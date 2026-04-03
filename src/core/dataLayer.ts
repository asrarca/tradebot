import WebSocket from 'ws';
import protobuf from 'protobufjs';
import path from 'path';
import { RSI } from 'technicalindicators';
import { fetchOHLCV } from './exchange';
import { SETTINGS } from '../config/runtimeSettings';
import { SYMBOLS } from '../config/tokens';
import logger from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Candle {
  time: number;   // Unix ms timestamp (open time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Keyed as "SYMBOL:interval" e.g. "BTC/USDT:1m"
type CandleBuffer = Map<string, Candle[]>;

type CandleCallback = (symbol: string, interval: string, candles: Candle[]) => void;

// ─── MEXC WebSocket candle stream format ─────────────────────────────────────
// MEXC uses symbol format without slash: BTC/USDT → BTCUSDT
function toMexcSymbol(symbol: string): string {
  return symbol.replace('/', '');
}

function bufferKey(symbol: string, interval: string): string {
  return `${symbol}:${interval}`;
}

// ─── DataLayer ────────────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 10_000;  // Send JSON heartbeat every 10 s
const WATCHDOG_TIMEOUT_MS = 25_000; // Force-reconnect if no message in 25 s

// MEXC WebSocket blocks kline streams for these intervals – use REST polling instead
const REST_ONLY_INTERVALS = new Set(['4h', '1d']);

// How often to poll each REST-only interval (frequent enough to catch a candle close)
const REST_POLL_MS: Record<string, number> = {
  '4h': 10 * 60 * 1000,   // every 10 minutes
  '1d': 60 * 60 * 1000,   // every hour
};

export class DataLayer {
  private buffers: CandleBuffer = new Map();
  private sockets: Map<string, WebSocket> = new Map();
  private heartbeats: Map<string, NodeJS.Timeout> = new Map();
  private restPollTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastTickAt: Map<string, number> = new Map(); // Unix ms of last WS kline tick
  private callbacks: CandleCallback[] = [];
  private readonly MEXC_WS_BASE = 'wss://wbs-api.mexc.com/ws';
  private WrapperType!: protobuf.Type; // PushDataV3ApiWrapper protobuf type

  constructor(
    private readonly symbols: string[] = SYMBOLS,
    private readonly intervals: string[] = [...SETTINGS.CANDLE_INTERVALS],
  ) {}

  // Register a listener to be called on every new closed candle
  onCandle(cb: CandleCallback): void {
    this.callbacks.push(cb);
  }

  // ── Seed buffers with REST data, then subscribe to WebSocket streams ─────────
  async start(): Promise<void> {
    // Load protobuf definitions
    const protoDir = path.resolve(__dirname, '..', 'proto');
    const root = await protobuf.load([
      path.join(protoDir, 'PublicSpotKlineV3Api.proto'),
      path.join(protoDir, 'PushDataV3ApiWrapper.proto'),
    ]);
    this.WrapperType = root.lookupType('PushDataV3ApiWrapper');
    logger.info('Protobuf definitions loaded');
    logger.info('DataLayer: seeding candle buffers from REST…');

    // Seed each symbol × interval in parallel
    await Promise.all(
      this.symbols.flatMap((symbol) =>
        this.intervals.map((interval) =>
          this.seedBuffer(symbol, interval),
        ),
      ),
    );

    logger.info('DataLayer: candle buffers seeded, connecting WebSocket streams…');

    const wsIntervals   = this.intervals.filter((i) => !REST_ONLY_INTERVALS.has(i));
    const restIntervals = this.intervals.filter((i) => REST_ONLY_INTERVALS.has(i));

    for (const symbol of this.symbols) {
      for (const interval of wsIntervals) {
        this.subscribeStream(symbol, interval);
      }
    }

    for (const symbol of this.symbols) {
      for (const interval of restIntervals) {
        this.startRestPoll(symbol, interval);
      }
    }

    logger.info(`DataLayer: ${this.symbols.length * wsIntervals.length} WS streams, ${this.symbols.length * restIntervals.length} REST-polled streams`, {
      symbols: this.symbols,
      wsIntervals,
      restIntervals,
    });
  }

  // ── Seed a single buffer with historical candles via REST ────────────────────
  private async seedBuffer(symbol: string, interval: string): Promise<void> {
    try {
      const raw = await fetchOHLCV(symbol, interval, SETTINGS.CANDLE_BUFFER_SIZE);
      const candles: Candle[] = raw.map(([time, open, high, low, close, volume]) => ({
        time: time as number,
        open: open as number,
        high: high as number,
        low: low as number,
        close: close as number,
        volume: volume as number,
      }));
      this.buffers.set(bufferKey(symbol, interval), candles);
      logger.info(`Seeded ${candles.length} candles for ${symbol} ${interval}`);
    } catch (err) {
      logger.error(`Failed to seed buffer for ${symbol} ${interval}`, { err });
    }
  }

  // ── Poll a REST endpoint for intervals blocked on MEXC WebSocket ────────────
  private startRestPoll(symbol: string, interval: string): void {
    const key    = bufferKey(symbol, interval);
    const pollMs = REST_POLL_MS[interval] ?? 15 * 60 * 1000;

    const poll = async (): Promise<void> => {
      try {
        const raw = await fetchOHLCV(symbol, interval, SETTINGS.CANDLE_BUFFER_SIZE);
        const candles: Candle[] = raw.map(([time, open, high, low, close, volume]) => ({
          time:   time   as number,
          open:   open   as number,
          high:   high   as number,
          low:    low    as number,
          close:  close  as number,
          volume: volume as number,
        }));

        const prev = this.buffers.get(key);
        const prevLastTime = prev && prev.length > 0 ? prev[prev.length - 1].time : null;
        const newLastTime  = candles.length > 0 ? candles[candles.length - 1].time : null;

        this.buffers.set(key, candles);
        this.lastTickAt.set(key, Date.now());

        // Fire callbacks only when a new candle has closed
        if (newLastTime !== null && newLastTime !== prevLastTime) {
          logger.info(`REST poll: new ${interval} candle for ${symbol} @ ${new Date(newLastTime).toISOString()}`);
          for (const cb of this.callbacks) {
            cb(symbol, interval, [...candles]);
          }
        }
      } catch (err) {
        logger.warn(`REST poll failed: ${symbol} ${interval}`, { err });
      }
    };

    // Run once immediately (buffer is already seeded, this keeps it fresh)
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    this.restPollTimers.set(key, timer);
    logger.info(`REST poll started: ${symbol} ${interval} every ${pollMs / 60_000}min`);
  }

  // ── Subscribe to a MEXC WebSocket kline stream ───────────────────────────────
  private subscribeStream(symbol: string, interval: string): void {
    const mexcSymbol = toMexcSymbol(symbol);
    const key = bufferKey(symbol, interval);
    const ws = new WebSocket(this.MEXC_WS_BASE);

    // ── Watchdog: reset on every message; force-reconnect if silent too long ──
    let watchdog: NodeJS.Timeout;
    const resetWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        logger.warn(`WS watchdog fired for ${symbol} ${interval} – no message in ${WATCHDOG_TIMEOUT_MS / 1000}s, terminating…`);
        ws.terminate(); // triggers 'close', which schedules reconnect
      }, WATCHDOG_TIMEOUT_MS);
    };

    ws.on('open', () => {
      const channel = `spot@public.kline.v3.api.pb@${mexcSymbol}@Min${interval.replace('m', '')}`;
      const sub = {
        method: 'SUBSCRIPTION',
        params: [channel],
      };
      ws.send(JSON.stringify(sub));
      logger.info(`WS subscribed: ${symbol} ${interval} → ${channel}`);

      // Send JSON heartbeat on a fixed interval
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'PING' }));
        }
      }, PING_INTERVAL_MS);
      this.heartbeats.set(key, heartbeat);

      // Start watchdog
      resetWatchdog();
    });

    // Handle WebSocket protocol-level ping frames from MEXC
    ws.on('ping', () => {
      ws.pong();
      resetWatchdog();
    });

    ws.on('pong', () => {
      resetWatchdog(); // protocol-level pong confirms the link is alive
    });

    ws.on('message', (data: WebSocket.RawData) => {
      resetWatchdog();

      // Convert to Buffer for uniform handling
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      // ── Try JSON first (control frames: PING/PONG, subscription confirmations) ──
      // JSON messages always start with '{' (0x7B)
      if (buf.length > 0 && buf[0] === 0x7B) {
        try {
          const msg = JSON.parse(buf.toString('utf8'));
          const upperMethod   = typeof msg.method === 'string' ? msg.method.toUpperCase() : '';
          const upperMsgField = typeof msg.msg    === 'string' ? msg.msg.toUpperCase()    : '';

          if (upperMethod === 'PING' || upperMsgField === 'PING') {
            ws.send(JSON.stringify({ method: 'PONG' }));
            return;
          }
          if (upperMethod === 'PONG' || upperMsgField === 'PONG') return;

          if (typeof msg.code === 'number' && msg.code === 0 && typeof msg.msg === 'string') {
            logger.info(`WS confirmed: ${msg.msg}`);
            return;
          }
          // If it's some other JSON message, log and skip
          logger.debug(`WS JSON [${symbol} ${interval}]`, msg);
          return;
        } catch {
          // Not valid JSON despite starting with '{', fall through to protobuf
        }
      }

      // ── Decode protobuf binary ──────────────────────────────────────────────
      try {
        const wrapper = this.WrapperType.decode(buf) as unknown as {
          channel?: string;
          publicSpotKline?: {
            interval: string;
            windowStart: number | { toNumber(): number };
            openingPrice: string;
            closingPrice: string;
            highestPrice: string;
            lowestPrice: string;
            volume: string;
            amount: string;
            windowEnd: number | { toNumber(): number };
          };
          symbol?: string;
          symbolId?: string;
          createTime?: number | { toNumber(): number };
          sendTime?: number | { toNumber(): number };
        };

        if (wrapper.publicSpotKline) {
          this.handleKlineMessage(symbol, interval, bufferKey(symbol, interval), wrapper);
        } else {
          logger.info(`WS protobuf non-kline [${symbol} ${interval}] channel=${wrapper.channel}`);
        }
      } catch (err) {
        logger.info(`WS decode failed [${symbol} ${interval}]`, { err });
      }
    });

    ws.on('error', (err) => {
      logger.error(`WS error on ${symbol} ${interval}`, { err: err.message });
    });

    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(watchdog);
      // Clear heartbeat before scheduling reconnect
      const heartbeat = this.heartbeats.get(key);
      if (heartbeat) {
        clearInterval(heartbeat);
        this.heartbeats.delete(key);
      }
      logger.warn(`WS closed for ${symbol} ${interval}, reconnecting in 5s…`, {
        code,
        reason: reason.toString() || 'none',
      });
      setTimeout(() => this.subscribeStream(symbol, interval), 5_000);
    });

    this.sockets.set(key, ws);
  }

  // ── Parse a decoded protobuf kline message and update the buffer ────────────
  private handleKlineMessage(
    symbol: string,
    interval: string,
    key: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper: any,
  ): void {
    const kline = wrapper.publicSpotKline;
    if (!kline) return;

    // Record that a live tick arrived for this stream
    this.lastTickAt.set(key, Date.now());

    // protobufjs returns int64 as Long objects – coerce to number
    const windowStartSec = typeof kline.windowStart === 'object'
      ? (kline.windowStart as { toNumber(): number }).toNumber()
      : Number(kline.windowStart);
    const windowEndSec = typeof kline.windowEnd === 'object'
      ? (kline.windowEnd as { toNumber(): number }).toNumber()
      : Number(kline.windowEnd);

    const candle: Candle = {
      time: windowStartSec * 1000,
      open: parseFloat(kline.openingPrice),
      high: parseFloat(kline.highestPrice),
      low: parseFloat(kline.lowestPrice),
      close: parseFloat(kline.closingPrice),
      volume: parseFloat(kline.volume),
    };

    logger.debug(`Tick [${symbol} ${interval}] close=${candle.close} time=${new Date(candle.time).toISOString()}`);
    const buf = this.buffers.get(key) ?? [];
    const lastCandle = buf.length > 0 ? buf[buf.length - 1] : null;

    // A new windowstart means the previous candle has closed.
    // Emit the completed candle (lastCandle) to all listeners before
    // starting to accumulate the new live one.
    const isClosed = lastCandle !== null && candle.time > lastCandle.time;

    if (!isClosed) {
      // Still inside the same candle window – update the live entry in-place
      if (buf.length > 0 && buf[buf.length - 1].time === candle.time) {
        buf[buf.length - 1] = candle;
      } else if (buf.length === 0) {
        // Very first tick before any seed data
        buf.push(candle);
        this.buffers.set(key, buf);
      }
      return;
    }

    // Closed candle – append and trim buffer
    buf.push(candle);
    if (buf.length > SETTINGS.CANDLE_BUFFER_SIZE) {
      buf.shift();
    }
    this.buffers.set(key, buf);

    logger.debug(`Closed candle [${symbol} ${interval}] @ ${new Date(candle.time).toISOString()} close=${candle.close}`);

    // Notify all listeners
    for (const cb of this.callbacks) {
      cb(symbol, interval, [...buf]);
    }
  }

  // ── Public accessor for current buffer ───────────────────────────────────────
  getCandles(symbol: string, interval: string): Candle[] {
    return this.buffers.get(bufferKey(symbol, interval)) ?? [];
  }

  // Compute RSI from the live buffer (includes the current open candle close price)
  getLiveRsi(symbol: string, interval: string, period: number): number | null {
    const candles = this.getCandles(symbol, interval);
    if (candles.length < period + 1) return null;
    const closes = candles.map((c) => c.close);
    const values = RSI.calculate({ period, values: closes });
    return values.length > 0 ? values[values.length - 1] : null;
  }
  // Returns Unix ms timestamp of the last live WS tick for a given stream, or null if none yet
  getLastTickAt(symbol: string, interval: string): number | null {
    return this.lastTickAt.get(bufferKey(symbol, interval)) ?? null;
  }
  // ── Graceful shutdown ─────────────────────────────────────────────────────────
  stop(): void {
    for (const [key, heartbeat] of this.heartbeats) {
      clearInterval(heartbeat);
      logger.info(`WS heartbeat cleared: ${key}`);
    }
    this.heartbeats.clear();

    for (const [key, ws] of this.sockets) {
      ws.removeAllListeners();
      ws.close();
      logger.info(`WS closed: ${key}`);
    }
    this.sockets.clear();

    for (const [key, timer] of this.restPollTimers) {
      clearInterval(timer);
      logger.info(`REST poll cleared: ${key}`);
    }
    this.restPollTimers.clear();
  }
}
