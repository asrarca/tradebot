import { SETTINGS } from '../config/runtimeSettings';
import { getExchange } from './exchange';
import { RiskManager } from './riskManager';
import logger from '../utils/logger';
import { Candle } from './dataLayer';
import { computeIndicators, computeTrendIndicators } from './indicators';
import { notifyPhone } from './notifier';
import { RsiStochSwingStrategy, SwingSnapshot } from '../strategies/rsiStochSwing';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CycleState = 'idle' | 'in_position' | 'cooldown';
type TrendBias = 'bullish' | 'bearish' | 'neutral';

export interface ActivePosition {
  symbol: string;
  buyFillPrice: number;
  totalQty: number;
  entryRsi?: number;
  exitRsiThreshold?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  openedAt: number;
}

interface SymbolCycle {
  state: CycleState;
  position?: ActivePosition;
  cooldownUntil?: number;
}

export interface TrendContext {
  bias: TrendBias;
  armedSide?: 'long' | 'short';
  breakoutLevel?: number;
  armedUntil?: number;
}

// ─── CycleManager ─────────────────────────────────────────────────────────────
// Per-symbol state machine: idle → in_position → cooldown → idle
// Entry: 15m price near BB lower band and RSI below threshold.
// Exit: 15m candle touches BB upper band and RSI above threshold.

export class CycleManager {
  private cycles       = new Map<string, SymbolCycle>();
  private lastRsiCache = new Map<string, number>();
  private trendContexts = new Map<string, TrendContext>();
  private swingStrategy: RsiStochSwingStrategy;
  private candles1d    = new Map<string, Candle[]>();

  private async resolveMarketFillPrice(
    symbol: string,
    side: 'buy' | 'sell',
    order: any,
    fallbackPrice: number,
  ): Promise<number> {
    const avg = Number(order?.average);
    if (Number.isFinite(avg) && avg > 0) return avg;

    const cost = Number(order?.cost);
    const filled = Number(order?.filled);
    if (Number.isFinite(cost) && cost > 0 && Number.isFinite(filled) && filled > 0) {
      return cost / filled;
    }

    const orderId = order?.id;
    if (orderId) {
      try {
        const refreshed: any = await getExchange().fetchOrder(orderId, symbol);
        const refreshedAvg = Number(refreshed?.average);
        if (Number.isFinite(refreshedAvg) && refreshedAvg > 0) return refreshedAvg;

        const refreshedCost = Number(refreshed?.cost);
        const refreshedFilled = Number(refreshed?.filled);
        if (Number.isFinite(refreshedCost) && refreshedCost > 0 && Number.isFinite(refreshedFilled) && refreshedFilled > 0) {
          return refreshedCost / refreshedFilled;
        }
      } catch (err) {
        logger.warn(`Could not refresh ${side} order fill details for ${symbol}`, { err, orderId });
      }
    }

    logger.warn(`Using fallback ${side} fill price for ${symbol}`, {
      fallbackPrice,
      orderId: order?.id,
      hasAverage: Number.isFinite(Number(order?.average)),
      hasCost: Number.isFinite(Number(order?.cost)),
      hasFilled: Number.isFinite(Number(order?.filled)),
    });

    return fallbackPrice;
  }

  constructor(private risk: RiskManager, symbols: string[]) {
    for (const sym of symbols) {
      this.cycles.set(sym, { state: 'idle' });
      this.trendContexts.set(sym, { bias: 'neutral' });
      this.candles1d.set(sym, []);
    }
    this.swingStrategy = new RsiStochSwingStrategy(risk, symbols);
  }

  // ── Main entry point – called on every closed candle ─────────────────────
  async onCandle(symbol: string, interval: string, candles: Candle[]): Promise<void> {
    const cycle = this.cycles.get(symbol);
    if (!cycle) return;

    const now = Date.now();
    if (cycle.state === 'cooldown' && now >= (cycle.cooldownUntil ?? 0)) {
      cycle.state = 'idle';
      logger.info(`⏰ Cooldown done: ${symbol} – ready for next setup`);
    }

    // ── Cache 1D candles for HTF filter ───────────────────────────────────────
    if (interval === SETTINGS.SWING_HTF_TIMEFRAME) {
      this.candles1d.set(symbol, candles);
      return; // 1D candles are only for the HTF filter, not for entry logic
    }

    if (SETTINGS.ACTIVE_STRATEGY === 'bb-mean-reversion') {
      await this.handleBbStrategy(symbol, interval, candles, cycle);
      return;
    }

    if (SETTINGS.ACTIVE_STRATEGY === 'rsi-stoch-swing') {
      if (interval !== SETTINGS.SWING_TIMEFRAME) return;
      const candles1d = this.candles1d.get(symbol) ?? [];
      await this.swingStrategy.onCandle(symbol, candles, candles1d);
      return;
    }

    await this.handleVwapEmaStrategy(symbol, interval, candles, cycle, now);
  }

  private async handleBbStrategy(
    symbol: string,
    interval: string,
    candles: Candle[],
    cycle: SymbolCycle,
  ): Promise<void> {
    if (interval !== SETTINGS.STRATEGY_TIMEFRAME) return;

    const indicators = computeIndicators(candles);
    if (!indicators) return;
    this.lastRsiCache.set(symbol, indicators.rsi);

    switch (cycle.state) {
      case 'idle':
        if (this.risk.isHalted()) return;
        await this.tryEnterSpotBb(symbol, cycle, indicators);
        break;

      case 'in_position':
        if (!cycle.position) {
          cycle.state = 'idle';
          return;
        }
        await this.tryExitSpotBb(symbol, cycle, indicators);
        break;

      case 'cooldown':
        break;
    }
  }

  private async handleVwapEmaStrategy(
    symbol: string,
    interval: string,
    candles: Candle[],
    cycle: SymbolCycle,
    now: number,
  ): Promise<void> {
    if (interval === SETTINGS.STRATEGY_DIRECTION_TIMEFRAME) {
      this.updateDirectionContext(symbol, candles);
      return;
    }

    if (interval !== SETTINGS.STRATEGY_ENTRY_TIMEFRAME) return;

    const indicators = computeTrendIndicators(candles);
    if (!indicators) return;

    const trend = this.trendContexts.get(symbol);
    if (trend?.armedUntil && now > trend.armedUntil) {
      trend.armedSide = undefined;
      trend.breakoutLevel = undefined;
      trend.armedUntil = undefined;
    }

    switch (cycle.state) {
      case 'idle':
        if (this.risk.isHalted()) return;
        await this.tryEnterSpotTrend(symbol, cycle, indicators);
        break;

      case 'in_position':
        if (!cycle.position) {
          cycle.state = 'idle';
          return;
        }
        await this.tryExitSpotTrend(symbol, cycle, indicators);
        break;

      case 'cooldown':
        break;
    }
  }

  private updateDirectionContext(symbol: string, candles: Candle[]): void {
    const indicators = computeTrendIndicators(candles);
    if (!indicators) return;

    const ctx = this.trendContexts.get(symbol) ?? { bias: 'neutral' as TrendBias };
    let bias: TrendBias = 'neutral';
    if (indicators.currentClose > indicators.vwap && indicators.emaFast >= indicators.emaSlow) {
      bias = 'bullish';
    } else if (indicators.currentClose < indicators.vwap && indicators.emaFast <= indicators.emaSlow) {
      bias = 'bearish';
    }
    ctx.bias = bias;

    const lookback = SETTINGS.BREAKOUT_LOOKBACK_5M;
    if (candles.length < lookback + 1) {
      this.trendContexts.set(symbol, ctx);
      return;
    }

    const prior = candles.slice(-(lookback + 1), -1);
    const priorHigh = Math.max(...prior.map((c) => c.high));
    const priorLow = Math.min(...prior.map((c) => c.low));

    if (bias === 'bullish' && indicators.currentClose > priorHigh) {
      ctx.armedSide = 'long';
      ctx.breakoutLevel = indicators.currentClose;
      ctx.armedUntil = Date.now() + SETTINGS.BREAKOUT_ARM_MS;
      logger.info(`📈 Breakout armed: ${symbol}`, {
        side: 'long',
        timeframe: SETTINGS.STRATEGY_DIRECTION_TIMEFRAME,
        breakoutLevel: indicators.currentClose,
        priorHigh,
      });
    } else if (bias === 'bearish' && indicators.currentClose < priorLow) {
      ctx.armedSide = 'short';
      ctx.breakoutLevel = indicators.currentClose;
      ctx.armedUntil = Date.now() + SETTINGS.BREAKOUT_ARM_MS;
      logger.info(`📉 Breakout armed: ${symbol}`, {
        side: 'short',
        timeframe: SETTINGS.STRATEGY_DIRECTION_TIMEFRAME,
        breakoutLevel: indicators.currentClose,
        priorLow,
      });
    }

    this.trendContexts.set(symbol, ctx);
  }

  // ── Spot entry on 15m BB lower-band proximity ─────────────────────────────
  private async tryEnterSpotBb(
    symbol: string,
    cycle: SymbolCycle,
    indicators: NonNullable<ReturnType<typeof computeIndicators>>,
  ): Promise<void> {
    const distanceToLowerBand = (indicators.currentClose - indicators.bb.lower) / indicators.bb.lower;
    const nearLowerBand = distanceToLowerBand <= SETTINGS.BB_ENTRY_MAX_DISTANCE_PERCENT;
    const rsiPassed = indicators.rsi < SETTINGS.BB_ENTRY_RSI_MAX;

    if (!nearLowerBand || !rsiPassed) {
      return;
    }

    const reserved = this.getReservedCapital(symbol);
    if (!this.risk.canEnterCycle(reserved)) return;

    const buyQty = SETTINGS.BUY_SIZE_USDT / indicators.currentClose;
    let fillPrice = indicators.currentClose;
    let filledQty = buyQty;

    if (SETTINGS.MODE === 'live') {
      try {
        const order: any = await getExchange().createMarketBuyOrder(symbol, buyQty);
        fillPrice = await this.resolveMarketFillPrice(symbol, 'buy', order, indicators.currentClose);
        filledQty = Number(order?.filled ?? buyQty);
      } catch (err) {
        logger.error(`Failed to place spot buy for ${symbol}`, { err });
        return;
      }
    }

    const cost = fillPrice * filledQty * (1 + SETTINGS.TAKER_FEE);
    if (SETTINGS.MODE !== 'live') {
      this.risk.paperBalance -= cost;
    }

    cycle.state = 'in_position';
    cycle.position = {
      symbol,
      buyFillPrice: fillPrice,
      totalQty: filledQty,
      entryRsi: indicators.rsi,
      exitRsiThreshold: SETTINGS.BB_EXIT_RSI_MIN,
      openedAt: Date.now(),
    };

    logger.info(`🟢 SPOT BUY: ${symbol}`, {
      timeframe: SETTINGS.STRATEGY_TIMEFRAME,
      strategy: 'bb-mean-reversion',
      entryPrice: fillPrice,
      bbLower: indicators.bb.lower,
      bbDistancePercent: `${(distanceToLowerBand * 100).toFixed(2)}%`,
      rsi: indicators.rsi.toFixed(2),
      qty: filledQty.toFixed(6),
      notional: `$${(fillPrice * filledQty).toFixed(4)}`,
      exitRule: `touch BB upper + RSI > ${SETTINGS.BB_EXIT_RSI_MIN}`,
    });

    await notifyPhone(
      `🟢 ENTRY ${symbol} (${SETTINGS.ACTIVE_STRATEGY})\nprice: ${fillPrice.toFixed(4)}\nrsi: ${indicators.rsi.toFixed(2)}\nqty: ${filledQty.toFixed(6)}\nmode: ${SETTINGS.MODE}`,
      {
        event: 'entry',
        symbol,
        strategy: SETTINGS.ACTIVE_STRATEGY,
        mode: SETTINGS.MODE,
        entryPrice: fillPrice,
        rsi: indicators.rsi,
        quantity: filledQty,
      },
    );
  }

  // ── Spot exit on 15m BB upper-band touch + RSI confirmation ──────────────
  private async tryExitSpotBb(
    symbol: string,
    cycle: SymbolCycle,
    indicators: NonNullable<ReturnType<typeof computeIndicators>>,
  ): Promise<void> {
    const pos = cycle.position!;
    const exitRsiThreshold = pos.exitRsiThreshold ?? SETTINGS.BB_EXIT_RSI_MIN;
    const touchedUpperBand = indicators.currentHigh >= indicators.bb.upper;
    const rsiPassed = indicators.rsi > exitRsiThreshold;

    if (!touchedUpperBand || !rsiPassed) {
      return;
    }

    let exitPrice = indicators.bb.upper;
    if (SETTINGS.MODE === 'live') {
      try {
        const order: any = await getExchange().createMarketSellOrder(symbol, pos.totalQty);
        exitPrice = await this.resolveMarketFillPrice(symbol, 'sell', order, indicators.currentClose);
      } catch (err) {
        logger.error(`Failed to place spot sell for ${symbol}`, { err });
        return;
      }
    }

    const proceeds = exitPrice * pos.totalQty * (1 - SETTINGS.TAKER_FEE);
    const cost = pos.buyFillPrice * pos.totalQty * (1 + SETTINGS.TAKER_FEE);
    const pnl = proceeds - cost;

    if (SETTINGS.MODE !== 'live') {
      this.risk.paperBalance += proceeds;
    }

    this.risk.recordTrade(pnl, pnl >= 0);
    logger.info(`💚 BB EXIT: ${symbol}`, {
      timeframe: SETTINGS.STRATEGY_TIMEFRAME,
      strategy: 'bb-mean-reversion',
      exitPrice,
      bbUpper: indicators.bb.upper,
      rsi: indicators.rsi.toFixed(2),
      threshold: exitRsiThreshold,
      qty: pos.totalQty.toFixed(6),
      pnl: `$${pnl.toFixed(4)}`,
    });

    await notifyPhone(
      `💚 EXIT ${symbol} (${SETTINGS.ACTIVE_STRATEGY})\nprice: ${exitPrice.toFixed(4)}\npnl: ${pnl.toFixed(4)} USDT\nmode: ${SETTINGS.MODE}`,
      {
        event: 'exit',
        symbol,
        strategy: SETTINGS.ACTIVE_STRATEGY,
        mode: SETTINGS.MODE,
        exitPrice,
        pnl,
      },
    );
    this.enterCooldown(symbol, cycle);
  }

  // ── Spot entry on 1m retrace into EMA9/EMA20 after 5m breakout ───────────
  private async tryEnterSpotTrend(
    symbol: string,
    cycle: SymbolCycle,
    indicators: NonNullable<ReturnType<typeof computeTrendIndicators>>,
  ): Promise<void> {
    const trend = this.trendContexts.get(symbol);
    if (!trend) return;

    if (trend.bias !== 'bullish' || trend.armedSide !== 'long') return;

    const zoneTop = Math.max(indicators.emaFast, indicators.emaSlow);
    const zoneBottom = Math.min(indicators.emaFast, indicators.emaSlow);
    const retraceFloor = zoneBottom * (1 - SETTINGS.EMA_RETRACE_TOLERANCE_PERCENT);
    const pulledBackToEmaZone = indicators.currentLow <= zoneTop && indicators.currentLow >= retraceFloor;
    const rejectionContinuation =
      indicators.currentClose > indicators.currentOpen &&
      indicators.currentClose > zoneTop &&
      indicators.currentClose > indicators.prevClose &&
      indicators.currentClose > indicators.vwap;

    if (!pulledBackToEmaZone || !rejectionContinuation) return;

    const reserved = this.getReservedCapital(symbol);
    if (!this.risk.canEnterCycle(reserved)) return;

    const buyQty = SETTINGS.BUY_SIZE_USDT / indicators.currentClose;
    let fillPrice = indicators.currentClose;
    let filledQty = buyQty;

    if (SETTINGS.MODE === 'live') {
      try {
        const order: any = await getExchange().createMarketBuyOrder(symbol, buyQty);
        fillPrice = await this.resolveMarketFillPrice(symbol, 'buy', order, indicators.currentClose);
        const orderFilled = Number(order?.filled);
        filledQty = Number.isFinite(orderFilled) && orderFilled > 0 ? orderFilled : buyQty;
      } catch (err) {
        logger.error(`Failed to place spot buy for ${symbol}`, { err });
        return;
      }
    }

    let stopPrice = Math.min(indicators.currentLow, zoneBottom) * (1 - SETTINGS.STOP_BUFFER_PERCENT);
    if (!(stopPrice > 0) || stopPrice >= fillPrice) {
      stopPrice = fillPrice * (1 - SETTINGS.DEFAULT_STOP_PERCENT);
    }

    const riskPerUnit = Math.max(fillPrice - stopPrice, fillPrice * SETTINGS.DEFAULT_STOP_PERCENT);
    const takeProfitPrice = fillPrice + (riskPerUnit * SETTINGS.RISK_REWARD_RATIO);

    const cost = fillPrice * filledQty * (1 + SETTINGS.TAKER_FEE);
    if (SETTINGS.MODE !== 'live') {
      this.risk.paperBalance -= cost;
    }

    cycle.state = 'in_position';
    cycle.position = {
      symbol,
      buyFillPrice: fillPrice,
      totalQty: filledQty,
      stopPrice,
      takeProfitPrice,
      openedAt: Date.now(),
    };

    trend.armedSide = undefined;
    trend.breakoutLevel = undefined;
    trend.armedUntil = undefined;

    logger.info(`🟢 SPOT BUY: ${symbol}`, {
      strategy: 'vwap-ema-retrace',
      directionTf: SETTINGS.STRATEGY_DIRECTION_TIMEFRAME,
      entryTf: SETTINGS.STRATEGY_ENTRY_TIMEFRAME,
      entryPrice: fillPrice,
      emaFast: indicators.emaFast,
      emaSlow: indicators.emaSlow,
      vwap: indicators.vwap,
      stopPrice,
      takeProfitPrice,
      qty: filledQty.toFixed(6),
      notional: `$${(fillPrice * filledQty).toFixed(4)}`,
      rule: '5m breakout + 1m EMA retrace rejection',
    });

    await notifyPhone(
      `🟢 ENTRY ${symbol} (${SETTINGS.ACTIVE_STRATEGY})\nprice: ${fillPrice.toFixed(4)}\nstop: ${stopPrice.toFixed(4)}\ntp: ${takeProfitPrice.toFixed(4)}\nmode: ${SETTINGS.MODE}`,
      {
        event: 'entry',
        symbol,
        strategy: SETTINGS.ACTIVE_STRATEGY,
        mode: SETTINGS.MODE,
        entryPrice: fillPrice,
        stopPrice,
        takeProfitPrice,
        quantity: filledQty,
      },
    );
  }

  // ── Spot exit: stop-loss, take-profit, or trend regime loss ──────────────
  private async tryExitSpotTrend(
    symbol: string,
    cycle: SymbolCycle,
    indicators: NonNullable<ReturnType<typeof computeTrendIndicators>>,
  ): Promise<void> {
    const pos = cycle.position!;
    const stopPrice = pos.stopPrice;
    const takeProfitPrice = pos.takeProfitPrice;
    if (!stopPrice || !takeProfitPrice) return;

    const trend = this.trendContexts.get(symbol);
    const stopHit = indicators.currentLow <= stopPrice;
    const tpHit = indicators.currentHigh >= takeProfitPrice;
    const trendLost = trend?.bias === 'bearish' && indicators.currentClose < indicators.vwap;

    if (!stopHit && !tpHit && !trendLost) return;

    const plannedExit = stopHit
      ? stopPrice
      : tpHit
        ? takeProfitPrice
        : indicators.currentClose;
    const reason = stopHit ? 'stop_loss' : tpHit ? 'take_profit' : 'trend_flip';

    let exitPrice = plannedExit;
    if (SETTINGS.MODE === 'live') {
      try {
        const order: any = await getExchange().createMarketSellOrder(symbol, pos.totalQty);
        exitPrice = await this.resolveMarketFillPrice(symbol, 'sell', order, indicators.currentClose);
      } catch (err) {
        logger.error(`Failed to place spot sell for ${symbol}`, { err });
        return;
      }
    }

    const proceeds = exitPrice * pos.totalQty * (1 - SETTINGS.TAKER_FEE);
    const cost = pos.buyFillPrice * pos.totalQty * (1 + SETTINGS.TAKER_FEE);
    const pnl = proceeds - cost;

    if (SETTINGS.MODE !== 'live') {
      this.risk.paperBalance += proceeds;
    }

    this.risk.recordTrade(pnl, pnl >= 0);
    logger.info(`🔵 TREND EXIT: ${symbol}`, {
      strategy: 'vwap-ema-retrace',
      reason,
      exitPrice,
      qty: pos.totalQty.toFixed(6),
      stopPrice,
      takeProfitPrice,
      pnl: `$${pnl.toFixed(4)}`,
    });

    await notifyPhone(
      `🔵 EXIT ${symbol} (${SETTINGS.ACTIVE_STRATEGY})\nreason: ${reason}\nprice: ${exitPrice.toFixed(4)}\npnl: ${pnl.toFixed(4)} USDT\nmode: ${SETTINGS.MODE}`,
      {
        event: 'exit',
        symbol,
        strategy: SETTINGS.ACTIVE_STRATEGY,
        mode: SETTINGS.MODE,
        reason,
        exitPrice,
        pnl,
      },
    );
    this.enterCooldown(symbol, cycle);
  }

  // ── Enter cooldown state ──────────────────────────────────────────────────
  private enterCooldown(symbol: string, cycle: SymbolCycle): void {
    cycle.state = 'cooldown';
    cycle.cooldownUntil = Date.now() + SETTINGS.CYCLE_COOLDOWN_MS;
    cycle.position = undefined;
    logger.info(`🔄 Cycle complete: ${symbol} – cooldown ${SETTINGS.CYCLE_COOLDOWN_MS / 60_000}min`);
  }

  // ── Capital already reserved by other pending/active cycles ──────────────
  private getReservedCapital(excludeSymbol: string): number {
    let reserved = 0;
    for (const [sym, c] of this.cycles) {
      if (sym !== excludeSymbol && c.state === 'in_position') {
        reserved += SETTINGS.BUY_SIZE_USDT;
      }
    }
    return reserved;
  }

  // ── RSI accessor for dashboard ───────────────────────────────────────────
  getLastRsi(symbol: string): number | null {
    return this.lastRsiCache.get(symbol) ?? null;
  }

  getTrendSnapshot(symbol: string): TrendContext | null {
    return this.trendContexts.get(symbol) ?? null;
  }

  getSwingSnapshot(symbol: string): SwingSnapshot | null {
    return this.swingStrategy.getSnapshot(symbol);
  }

  getSwingCycles(): ReturnType<RsiStochSwingStrategy['getSwings']> {
    return this.swingStrategy.getSwings();
  }

  // ── Accessor for dashboard ────────────────────────────────────────────────
  getCycles(): Array<{
    symbol: string;
    state: CycleState;
    position?: ActivePosition;
    cooldownUntil?: number;
  }> {
    return Array.from(this.cycles.entries()).map(([symbol, c]) => ({
      symbol,
      state: c.state,
      position: c.position,
      cooldownUntil: c.cooldownUntil,
    }));
  }
}
