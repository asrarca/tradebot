import { SETTINGS } from '../config/runtimeSettings';
import { Candle } from '../core/dataLayer';
import {
  computeSwingIndicators,
  computeRsiSeries,
  detectCandlestickPattern,
  SwingIndicatorResult,
} from '../core/indicators';
import { notifyPhone } from '../core/notifier';
import { getExchange } from '../core/exchange';
import { RiskManager } from '../core/riskManager';
import logger from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

type SwingState = 'idle' | 'armed' | 'in_position' | 'cooldown';

interface SwingPosition {
  symbol: string;
  entryPrice: number;
  quantity: number;
  stopPrice: number;
  takeProfitPrice: number;
  openedAt: number;
  confluenceScore: number;
}

interface SymbolSwing {
  state: SwingState;
  position?: SwingPosition;
  armedAt?: number;
  cooldownUntil?: number;
  lastIndicators?: SwingIndicatorResult;
  prevStochK?: number; // previous candle's StochRSI %K for crossover detection
}

export interface SwingSnapshot {
  symbol: string;
  state: SwingState;
  position?: SwingPosition;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  macdHist?: number;
  ema50?: number;
  ema200?: number;
  confluenceScore?: number;
}

// ─── RsiStochSwingStrategy ────────────────────────────────────────────────────
// Long-only swing strategy on the 4H chart.
// Entry: RSI 30–55, StochRSI %K crosses up through %D from <20,
//        price ≥ EMA50, MACD histogram ≥ 0, volume expansion.
// Confluence scoring (0–5, minimum SWING_MIN_CONFLUENCE required).
// Stop: 1.5× ATR below the swing low.  TP: risk × SWING_RR_RATIO.
// HTF filter: only enter when daily RSI < 60 (not extreme overbought).

export class RsiStochSwingStrategy {
  private swings = new Map<string, SymbolSwing>();

  constructor(private risk: RiskManager, symbols: string[]) {
    for (const sym of symbols) {
      this.swings.set(sym, { state: 'idle' });
    }
  }

  // ── Main entry point – called by cycleManager on every 4h candle ──────────
  async onCandle(
    symbol: string,
    candles4h: Candle[],
    candles1d: Candle[],
  ): Promise<void> {
    const swing = this.swings.get(symbol);
    if (!swing) return;

    const now = Date.now();

    // Expire cooldown
    if (swing.state === 'cooldown' && now >= (swing.cooldownUntil ?? 0)) {
      swing.state = 'idle';
      swing.prevStochK = undefined;
      logger.info(`⏰ Swing cooldown done: ${symbol} – ready`);
    }

    const ind = computeSwingIndicators(candles4h);
    if (!ind) return; // not enough candle history yet

    // HTF daily RSI filter – skip if daily RSI is extremely overbought (>= 70)
    const htfRsiArr = computeRsiSeries(candles1d.map((c) => c.close), SETTINGS.SWING_RSI_PERIOD);
    const htfRsi = htfRsiArr.length > 0 ? htfRsiArr[htfRsiArr.length - 1] : 50;

    const prevK = swing.prevStochK;
    swing.prevStochK = ind.stochK;
    swing.lastIndicators = ind;

    switch (swing.state) {
      case 'idle':
        if (!this.risk.isHalted()) {
          await this.tryArm(symbol, swing, ind, htfRsi, prevK, now);
        }
        break;

      case 'armed':
        await this.tryEnter(symbol, swing, ind, now);
        break;

      case 'in_position':
        if (!swing.position) { swing.state = 'idle'; return; }
        await this.tryExit(symbol, swing, ind);
        break;

      case 'cooldown':
        break; // still waiting
    }
  }

  // ── Confluence score (long only) ──────────────────────────────────────────
  private scoreLong(ind: SwingIndicatorResult, htfRsi: number, prevK: number | undefined): number {
    let score = 0;

    // 1. RSI in bullish-reset zone
    if (ind.rsi >= SETTINGS.SWING_RSI_LONG_MIN && ind.rsi <= SETTINGS.SWING_RSI_LONG_MAX) score++;

    // 2. StochRSI %K rising from oversold (crossover %D from below 20)
    const kCrossedUp = prevK !== undefined && prevK < ind.stochD && ind.stochK > ind.stochD;
    if (ind.stochK < SETTINGS.SWING_STOCHRSI_OVERSOLD + 10 && (ind.stochK > ind.stochD || kCrossedUp)) score++;

    // 3. Price above EMA50 (trend filter)
    if (ind.currentClose >= ind.ema50) score++;

    // 4. MACD histogram positive or turning positive
    if (ind.macdHistogram >= 0) score++;

    // 5. Volume expansion
    if (ind.currentVolume > ind.volumeMA * SETTINGS.SWING_VOLUME_MULTIPLIER) score++;

    // 6. HTF daily RSI not overbought
    if (htfRsi < 60) score++;

    return score;
  }

  // ── Arm: signal found, wait for candlestick confirmation ─────────────────
  private async tryArm(
    symbol: string,
    swing: SymbolSwing,
    ind: SwingIndicatorResult,
    htfRsi: number,
    prevK: number | undefined,
    now: number,
  ): Promise<void> {
    const score = this.scoreLong(ind, htfRsi, prevK);
    if (score >= SETTINGS.SWING_MIN_CONFLUENCE) {
      swing.state = 'armed';
      swing.armedAt = now;
      logger.info(`🎯 Swing ARMED: ${symbol}`, {
        score: `${score}/6`,
        rsi: ind.rsi.toFixed(1),
        stochK: ind.stochK.toFixed(1),
        stochD: ind.stochD.toFixed(1),
        macdHist: ind.macdHistogram.toFixed(6),
        htfRsi: htfRsi.toFixed(1),
      });
    }
  }

  // ── Enter: candlestick confirmation on next 4h close ─────────────────────
  private async tryEnter(
    symbol: string,
    swing: SymbolSwing,
    ind: SwingIndicatorResult,
    now: number,
  ): Promise<void> {
    // Arm expires after 2 × 4h candles (8 hours)
    if (swing.armedAt && now - swing.armedAt > 2 * 4 * 60 * 60 * 1_000) {
      swing.state = 'idle';
      logger.info(`⌛ Swing arm expired: ${symbol}`);
      return;
    }

    const pattern = detectCandlestickPattern([
      {
        open: ind.prevClose, high: ind.prevHigh, low: ind.prevLow,
        close: ind.prevClose, volume: 0, time: 0,
      },
      {
        open: ind.currentOpen, high: ind.currentHigh, low: ind.currentLow,
        close: ind.currentClose, volume: 0, time: 0,
      },
    ] as Candle[]);

    // Confirm: bullish pattern OR simply green candle closing above previous close
    const confirmed = pattern === 'bullish' || ind.currentClose > ind.prevClose;
    if (!confirmed) return;

    const reserved = this.getReservedCapital(symbol);
    if (!this.risk.canEnterCycle(reserved)) return;

    const price  = ind.currentClose;
    const atr    = ind.atr;
    const swingLow = Math.min(ind.prevLow, ind.currentLow);
    let stopPrice = swingLow - SETTINGS.SWING_ATR_STOP_MULTIPLIER * atr;
    if (stopPrice >= price) stopPrice = price * (1 - 0.02);

    const riskPerUnit     = price - stopPrice;
    const takeProfitPrice = price + riskPerUnit * SETTINGS.SWING_RR_RATIO;

    const buyQty = SETTINGS.BUY_SIZE_USDT / price;
    let fillPrice = price;
    let filledQty = buyQty;

    if (SETTINGS.MODE === 'live') {
      try {
        const order: any = await getExchange().createMarketBuyOrder(symbol, buyQty);
        const avg = Number(order?.average);
        if (Number.isFinite(avg) && avg > 0) fillPrice = avg;
        const fl = Number(order?.filled);
        if (Number.isFinite(fl) && fl > 0) filledQty = fl;
      } catch (err) {
        logger.error(`Failed to place swing buy for ${symbol}`, { err });
        return;
      }
    }

    const cost = fillPrice * filledQty * (1 + SETTINGS.TAKER_FEE);
    if (SETTINGS.MODE !== 'live') {
      this.risk.paperBalance -= cost;
    }

    const confluenceScore = this.scoreLong(ind, 50, undefined);

    swing.state = 'in_position';
    swing.position = {
      symbol,
      entryPrice: fillPrice,
      quantity: filledQty,
      stopPrice,
      takeProfitPrice,
      openedAt: now,
      confluenceScore,
    };

    logger.info(`🟢 SWING BUY: ${symbol}`, {
      strategy: 'rsi-stoch-swing',
      timeframe: SETTINGS.SWING_TIMEFRAME,
      entryPrice: fillPrice,
      stopPrice,
      takeProfitPrice,
      riskReward: SETTINGS.SWING_RR_RATIO,
      confluenceScore,
      rsi: ind.rsi.toFixed(1),
      stochK: ind.stochK.toFixed(1),
      stochD: ind.stochD.toFixed(1),
      macdHist: ind.macdHistogram.toFixed(6),
      atr: atr.toFixed(6),
      pattern,
    });

    await notifyPhone(
      `🟢 SWING BUY ${symbol}\nprice: ${fillPrice.toFixed(4)}\nstop: ${stopPrice.toFixed(4)}\ntp: ${takeProfitPrice.toFixed(4)}\nconfluence: ${confluenceScore}/6\nrsi: ${ind.rsi.toFixed(1)}\nmode: ${SETTINGS.MODE}`,
      {
        event: 'swing_entry',
        symbol,
        strategy: 'rsi-stoch-swing',
        mode: SETTINGS.MODE,
        entryPrice: fillPrice,
        stopPrice,
        takeProfitPrice,
        confluenceScore,
        rsi: ind.rsi,
        stochK: ind.stochK,
      },
    );
  }

  // ── Exit: stop loss or take profit ────────────────────────────────────────
  private async tryExit(symbol: string, swing: SymbolSwing, ind: SwingIndicatorResult): Promise<void> {
    const pos = swing.position!;

    const stopHit = ind.currentLow  <= pos.stopPrice;
    const tpHit   = ind.currentHigh >= pos.takeProfitPrice;
    if (!stopHit && !tpHit) return;

    const reason      = stopHit ? 'stop_loss' : 'take_profit';
    const plannedExit = stopHit ? pos.stopPrice : pos.takeProfitPrice;

    let exitPrice = plannedExit;
    if (SETTINGS.MODE === 'live') {
      try {
        const order: any = await getExchange().createMarketSellOrder(symbol, pos.quantity);
        const avg = Number(order?.average);
        if (Number.isFinite(avg) && avg > 0) exitPrice = avg;
      } catch (err) {
        logger.error(`Failed to place swing sell for ${symbol}`, { err });
        return;
      }
    }

    const proceeds = exitPrice  * pos.quantity * (1 - SETTINGS.TAKER_FEE);
    const cost     = pos.entryPrice * pos.quantity * (1 + SETTINGS.TAKER_FEE);
    const pnl      = proceeds - cost;

    if (SETTINGS.MODE !== 'live') {
      this.risk.paperBalance += proceeds;
    }

    this.risk.recordTrade(pnl, pnl >= 0);
    logger.info(`🔵 SWING EXIT: ${symbol}`, {
      strategy: 'rsi-stoch-swing',
      reason,
      exitPrice,
      stopPrice: pos.stopPrice,
      takeProfitPrice: pos.takeProfitPrice,
      qty: pos.quantity.toFixed(6),
      pnl: `$${pnl.toFixed(4)}`,
    });

    await notifyPhone(
      `🔵 SWING EXIT ${symbol}\nreason: ${reason}\nprice: ${exitPrice.toFixed(4)}\npnl: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDT\nmode: ${SETTINGS.MODE}`,
      {
        event: 'swing_exit',
        symbol,
        reason,
        strategy: 'rsi-stoch-swing',
        mode: SETTINGS.MODE,
        exitPrice,
        pnl,
      },
    );

    swing.state = 'cooldown';
    swing.cooldownUntil = Date.now() + SETTINGS.SWING_COOLDOWN_MS;
    swing.position = undefined;
    logger.info(`🔄 Swing cycle done: ${symbol} – cooldown ${SETTINGS.SWING_COOLDOWN_MS / 3_600_000}h`);
  }

  // ── Capital reserved by active positions ──────────────────────────────────
  private getReservedCapital(excludeSymbol: string): number {
    let reserved = 0;
    for (const [sym, s] of this.swings) {
      if (sym !== excludeSymbol && s.state === 'in_position') {
        reserved += SETTINGS.BUY_SIZE_USDT;
      }
    }
    return reserved;
  }

  // ── Dashboard accessors ───────────────────────────────────────────────────
  getSnapshot(symbol: string): SwingSnapshot | null {
    const swing = this.swings.get(symbol);
    if (!swing) return null;
    const ind = swing.lastIndicators;
    return {
      symbol,
      state: swing.state,
      position: swing.position,
      rsi:          ind?.rsi,
      stochK:       ind?.stochK,
      stochD:       ind?.stochD,
      macdHist:     ind?.macdHistogram,
      ema50:        ind?.ema50,
      ema200:       ind?.ema200,
      confluenceScore: swing.position?.confluenceScore,
    };
  }

  getSwings(): Array<{
    symbol: string;
    state: SwingState;
    position?: SwingPosition;
    cooldownUntil?: number;
  }> {
    return Array.from(this.swings.entries()).map(([symbol, s]) => ({
      symbol,
      state: s.state,
      position: s.position,
      cooldownUntil: s.cooldownUntil,
    }));
  }
}
