import { RiskManager } from '../core/riskManager';
import { DataLayer } from '../core/dataLayer';
import { CycleManager } from '../core/cycleManager';
import { computeIndicators, computeTrendIndicators } from '../core/indicators';
import { TOKENS } from '../config/tokens';
import { SETTINGS } from '../config/runtimeSettings';

// ─── Terminal Dashboard ───────────────────────────────────────────────────────
// Prints a live summary to stdout every DASHBOARD_REFRESH_MS (30s default).
// No external dependencies – uses ANSI escape codes directly.

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function colorPnl(value: number): string {
  const sign = value >= 0 ? '+' : '';
  const color = value >= 0 ? GREEN : RED;
  return `${color}${sign}${value.toFixed(4)}${RESET}`;
}

function colorPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  const color = value >= 0 ? GREEN : RED;
  return `${color}${sign}(${(value * 100).toFixed(2)}%)${RESET}`;
}

function bar(value: number, max: number, width: number = 20): string {
  const filled = Math.min(Math.round((value / max) * width), width);
  return GREEN + '█'.repeat(filled) + DIM + '░'.repeat(width - filled) + RESET;
}

/** Strip ANSI escape codes to get printable character count */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad string to `width` visible characters (ANSI-safe) */
function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visLen(s)));
}

/** Colour RSI value: green=oversold, red=overbought, yellow=heating, cyan=neutral */
function rsiColor(rsi: number): string {
  if (rsi <= 30) return GREEN;
  if (rsi >= 70) return RED;
  if (rsi >= 60) return YELLOW;
  return CYAN;
}

const BOTTOM_BORDER = `${CYAN}${BOLD}╚══════════════════════════════════════════════════════════════════╝${RESET}`;

export class Dashboard {
  private dashTimer: ReturnType<typeof setInterval> | null = null;
  private tickerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private risk: RiskManager,
    private dataLayer: DataLayer,
    private cycleManager: CycleManager,
  ) {}

  start(): void {
    this.printFull();
    this.dashTimer = setInterval(() => this.printFull(), SETTINGS.DASHBOARD_REFRESH_MS);
    if (SETTINGS.PRICE_TICKER_ENABLED) {
      // Skip the very first tick – printFull() just ran
      this.tickerTimer = setInterval(() => this.printPriceTicker(), SETTINGS.PRICE_TICKER_REFRESH_MS);
    }
  }

  stop(): void {
    if (this.dashTimer)  clearInterval(this.dashTimer);
    if (this.tickerTimer) clearInterval(this.tickerTimer);
  }

  // ── Build price table rows (shared by full render and ticker) ─────────────────────
  private buildPriceLines(): string[] {
    const isBbStrategy    = SETTINGS.ACTIVE_STRATEGY === 'bb-mean-reversion';
    const isSwingStrategy = SETTINGS.ACTIVE_STRATEGY === 'rsi-stoch-swing';
    const COL_W = 20;
    const headerCells: string[] = [];
    const priceCells:  string[] = [];
    const row3Cells: string[] = [];
    const row4Cells: string[] = [];
    const row5Cells: string[] = [];

    for (const token of TOKENS) {
      const candles  = this.dataLayer.getCandles(token.symbol, '1m');
      const strategyCandles = this.dataLayer.getCandles(
        token.symbol,
        isBbStrategy ? SETTINGS.STRATEGY_TIMEFRAME
          : isSwingStrategy ? SETTINGS.SWING_TIMEFRAME
          : SETTINGS.STRATEGY_ENTRY_TIMEFRAME,
      );
      const lastTick = this.dataLayer.getLastTickAt(token.symbol, '1m');
      const price    = candles.length > 0 ? candles[candles.length - 1].close : null;
      const rsi      = this.dataLayer.getLiveRsi(token.symbol, SETTINGS.STRATEGY_TIMEFRAME, SETTINGS.RSI_PERIOD);
      const bbIndicators    = isBbStrategy    ? computeIndicators(strategyCandles)      : null;
      const trendIndicators = !isBbStrategy && !isSwingStrategy ? computeTrendIndicators(strategyCandles) : null;
      const trend           = !isBbStrategy && !isSwingStrategy ? this.cycleManager.getTrendSnapshot(token.symbol) : null;
      const swingSnap       = isSwingStrategy ? this.cycleManager.getSwingSnapshot(token.symbol) : null;

      // Column header – token symbol
      headerCells.push(padEnd(`${BOLD}${token.symbol}${RESET}`, COL_W));

      // Price cell
      let priceColor = CYAN;
      let ageTag = '';
      if (lastTick === null) {
        priceColor = DIM;
        ageTag = ` ${DIM}(seed)${RESET}`;
      } else {
        const ageS = Math.floor((Date.now() - lastTick) / 1_000);
        priceColor = ageS > 30 ? YELLOW : GREEN;
        ageTag = ` ${DIM}${ageS}s${RESET}`;
      }
      const priceDecimals = price !== null && price < 1 ? 4 : 2;
      const priceStr = price !== null
        ? `${priceColor}$${price.toLocaleString('en-US', { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals })}${RESET}${ageTag}`
        : `${DIM}loading…${RESET}`;
      priceCells.push(padEnd(priceStr, COL_W));

      if (isBbStrategy) {
        const rsiStr = rsi !== null
          ? `RSI15 ${rsiColor(rsi)}${rsi.toFixed(1)}${RESET}`
          : `${DIM}RSI —${RESET}`;
        row3Cells.push(padEnd(rsiStr, COL_W));

        const bbDecimals = price !== null && price < 1 ? 4 : 2;
        const bbHighStr = bbIndicators
          ? `${YELLOW}BBH $${bbIndicators.bb.upper.toFixed(bbDecimals)}${RESET}`
          : `${DIM}BBH —${RESET}`;
        const bbLowStr = bbIndicators
          ? `${CYAN}BBL $${bbIndicators.bb.lower.toFixed(bbDecimals)}${RESET}`
          : `${DIM}BBL —${RESET}`;
        row4Cells.push(padEnd(bbHighStr, COL_W));
        row5Cells.push(padEnd(bbLowStr, COL_W));

      } else if (isSwingStrategy) {
        const kStr = swingSnap?.stochK !== undefined
          ? `K ${rsiColor(swingSnap.stochK)}${swingSnap.stochK.toFixed(0)}${RESET} D ${rsiColor(swingSnap.stochD ?? 50)}${(swingSnap.stochD ?? 0).toFixed(0)}${RESET}`
          : `${DIM}StochRSI —${RESET}`;
        const rsiSwingStr = swingSnap?.rsi !== undefined
          ? `RSI4h ${rsiColor(swingSnap.rsi)}${swingSnap.rsi.toFixed(1)}${RESET}`
          : `${DIM}RSI4h —${RESET}`;
        const ema50str = swingSnap?.ema50 !== undefined
          ? `EMA50 ${YELLOW}${swingSnap.ema50.toFixed(2)}${RESET}`
          : `${DIM}EMA50 —${RESET}`;
        row3Cells.push(padEnd(rsiSwingStr, COL_W));
        row4Cells.push(padEnd(kStr, COL_W));
        row5Cells.push(padEnd(ema50str, COL_W));

      } else {
        const biasColor = trend?.bias === 'bullish' ? GREEN : trend?.bias === 'bearish' ? RED : CYAN;
        const biasStr = trend
          ? `Bias ${biasColor}${trend.bias.toUpperCase()}${RESET}`
          : `${DIM}Bias —${RESET}`;
        const emaStr = trendIndicators
          ? `EMA9 ${YELLOW}${trendIndicators.emaFast.toFixed(2)}${RESET}`
          : `${DIM}EMA9 —${RESET}`;
        const vwapStr = trendIndicators
          ? `VWAP ${CYAN}${trendIndicators.vwap.toFixed(2)}${RESET}`
          : `${DIM}VWAP —${RESET}`;
        row3Cells.push(padEnd(biasStr, COL_W));
        row4Cells.push(padEnd(emaStr, COL_W));
        row5Cells.push(padEnd(vwapStr, COL_W));
      }
    }

    const sep    = `  ${DIM}│${RESET}  `;
    const prefix = `${CYAN}${BOLD}║${RESET}  `;

    return [
      `${CYAN}${BOLD}╠══════════════════════════ Live Prices ═════════════════════════════╣${RESET}`,
      prefix + headerCells.join(sep),
      prefix + priceCells.join(sep),
      prefix + row3Cells.join(sep),
      prefix + row4Cells.join(sep),
      prefix + row5Cells.join(sep),
    ];
  }

  // ── Full dashboard render (clears screen, runs every DASHBOARD_REFRESH_MS) ───────
  printFull(): void {
    const now = new Date().toLocaleString('en-CA', { timeZone: 'UTC', hour12: false });
    const mode = SETTINGS.MODE === 'paper' ? `${YELLOW}PAPER${RESET}` : `${RED}LIVE${RESET}`;
    const balance = this.risk.paperBalance;
    const dailyPnl = this.risk.getDailyPnl();
    const dailyPct = this.risk.getDailyPnlPercent();
    const winRate = this.risk.getWinRate();
    const totalTrades = this.risk.getTotalTrades();

    const statusLine = this.risk.isHalted()
      ? `${RED}${BOLD}🛑 HALTED (circuit breaker)${RESET}`
      : this.risk.isProfitLocked()
        ? `${YELLOW}${BOLD}🔒 PROFIT LOCKED (+${(SETTINGS.DAILY_PROFIT_LOCK_PERCENT * 100).toFixed(0)}% hit)${RESET}`
        : `${GREEN}${BOLD}🟢 RUNNING${RESET}`;

    const lines = [
      '',
      `${CYAN}${BOLD}╔══════════════════════════ UltraMagnus ═════════════════════════════╗${RESET}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Mode:${RESET} ${mode}  ${BOLD}UTC:${RESET} ${now}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Status:${RESET} ${statusLine}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Balance:${RESET} $${balance.toFixed(2)} USDT  ${BOLD}Daily PnL:${RESET} $${colorPnl(dailyPnl)} ${colorPercent(dailyPct)}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Daily target:${RESET} ${bar(Math.max(dailyPct, 0), SETTINGS.DAILY_PROFIT_LOCK_PERCENT)} ${(SETTINGS.DAILY_PROFIT_LOCK_PERCENT * 100).toFixed(0)}%  ${BOLD}Stretch:${RESET} ${(SETTINGS.STRETCH_TARGET_PERCENT * 100).toFixed(0)}%`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Win rate:${RESET} ${(winRate * 100).toFixed(0)}% (${totalTrades} trades)`,
      SETTINGS.ACTIVE_STRATEGY === 'bb-mean-reversion'
        ? `${CYAN}${BOLD}║${RESET}  ${BOLD}Strategy:${RESET} ${SETTINGS.STRATEGY_TIMEFRAME} BB mean reversion  ${BOLD}Entry:${RESET} ≤ ${(SETTINGS.BB_ENTRY_MAX_DISTANCE_PERCENT * 100).toFixed(1)}% from BB low + RSI < ${SETTINGS.BB_ENTRY_RSI_MAX}  ${BOLD}Exit:${RESET} BB high + RSI > ${SETTINGS.BB_EXIT_RSI_MIN}`
        : SETTINGS.ACTIVE_STRATEGY === 'rsi-stoch-swing'
          ? `${CYAN}${BOLD}║${RESET}  ${BOLD}Strategy:${RESET} ${SETTINGS.SWING_TIMEFRAME} RSI+StochRSI Swing  ${BOLD}Entry:${RESET} RSI ${SETTINGS.SWING_RSI_LONG_MIN}–55 + StochRSI<20 cross-up + EMA50 + MACD  ${BOLD}TP/SL:${RESET} ${SETTINGS.SWING_RR_RATIO}R`
          : `${CYAN}${BOLD}║${RESET}  ${BOLD}Strategy:${RESET} ${SETTINGS.STRATEGY_DIRECTION_TIMEFRAME}/${SETTINGS.STRATEGY_ENTRY_TIMEFRAME} VWAP + EMA retrace  ${BOLD}Entry:${RESET} breakout arm + EMA pullback rejection  ${BOLD}Exit:${RESET} stop / TP / trend flip`,
      `${CYAN}${BOLD}╠══════════════════════════ Cycle States ════════════════════════════╣${RESET}`,
    ];

    const isSwingActive = SETTINGS.ACTIVE_STRATEGY === 'rsi-stoch-swing';
    const cycleList = isSwingActive
      ? this.cycleManager.getSwingCycles()
      : this.cycleManager.getCycles();

    for (const c of cycleList) {
      let stateStr: string;
      if (c.state === 'idle') {
        stateStr = `${DIM}⬜ IDLE${RESET}`;
        lines.push(`${CYAN}${BOLD}║${RESET}  ${BOLD}${c.symbol}${RESET}  ${stateStr}`);
      } else if (c.state === 'armed') {
        stateStr = `${YELLOW}${BOLD}🎯 ARMED${RESET}`;
        const snap = this.cycleManager.getSwingSnapshot(c.symbol);
        const rsiStr = snap?.rsi !== undefined ? `  RSI ${snap.rsi.toFixed(1)}` : '';
        lines.push(`${CYAN}${BOLD}║${RESET}  ${BOLD}${c.symbol}${RESET}  ${stateStr}${rsiStr}  ${DIM}waiting for confirmation${RESET}`);
      } else if (c.state === 'in_position' && c.position) {
        const pos = c.position;
        stateStr = `${GREEN}${BOLD}🟢 POSITION${RESET}`;
        const minsOpen = Math.max(0, Math.round((Date.now() - pos.openedAt) / 60_000));
        const entryField = 'entryPrice' in pos
          ? (pos as any).entryPrice
          : (pos as any).buyFillPrice;
        const stopPriceVal  = (pos as any).stopPrice;
        const tpPriceVal    = (pos as any).takeProfitPrice;
        const isTrendPos    = typeof stopPriceVal === 'number' && typeof tpPriceVal === 'number';
        lines.push(
          `${CYAN}${BOLD}║${RESET}  ${BOLD}${c.symbol}${RESET}  ${stateStr}` +
          `  entry@$${entryField.toFixed(2)}` +
          (
            isTrendPos
              ? `  stop@$${stopPriceVal.toFixed(2)}  tp@$${tpPriceVal.toFixed(2)}`
              : `  entry RSI ${((pos as any).entryRsi ?? 0).toFixed(1)}  exit: BB high + RSI > ${(pos as any).exitRsiThreshold ?? SETTINGS.BB_EXIT_RSI_MIN}`
          ) +
          `  ${DIM}open ${minsOpen}m${RESET}`,
        );
      } else if (c.state === 'cooldown') {
        const minsLeft = Math.max(0, Math.round(((c.cooldownUntil ?? 0) - Date.now()) / 60_000));
        stateStr = `${DIM}⏰ COOLDOWN${RESET}`;
        lines.push(`${CYAN}${BOLD}║${RESET}  ${BOLD}${c.symbol}${RESET}  ${stateStr}  ${DIM}resumes in ${minsLeft}m${RESET}`);
      }
    }

    if (SETTINGS.PRICE_TICKER_ENABLED) {
      lines.push(...this.buildPriceLines());
    }

    lines.push(BOTTOM_BORDER);
    lines.push('');

    process.stdout.write('\x1b[2J\x1b[H'); // Clear screen
    process.stdout.write(lines.join('\n') + '\n');
  }

  // ── In-place price update (no screen clear, cursor jump to price rows) ────────
  // After printFull(), the terminal ends with: ...price-data\nBOTTOM_BORDER\n\n
  // Cursor sits 2 lines below BOTTOM_BORDER, so \x1b[4F reaches the price header.
  printPriceTicker(): void {
    if (!SETTINGS.PRICE_TICKER_ENABLED) return;
    const priceLines = this.buildPriceLines();
    process.stdout.write(
      '\x1b[8F'   +   // move cursor up 8 lines (6 price rows + border + blank)
      '\x1b[0J'   +   // clear from cursor to end of screen
      priceLines.join('\n') + '\n' +
      BOTTOM_BORDER + '\n' +
      '\n',            // restore blank line so next \x1b[8F stays correct
    );
  }
}
