import { SETTINGS } from '../config/settings';
import { getExchange } from './exchange';
import { RiskManager } from './riskManager';
import logger from '../utils/logger';
import { Candle } from './dataLayer';
import { computeTrendIndicators } from './indicators';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CycleState = 'idle' | 'in_position' | 'cooldown';
type TrendBias = 'bullish' | 'bearish' | 'neutral';

export interface ActivePosition {
  symbol: string;
  buyFillPrice: number;
  totalQty: number;
  stopPrice: number;
  takeProfitPrice: number;
  openedAt: number;
}

interface SymbolCycle {
  state: CycleState;
  position?: ActivePosition;
  cooldownUntil?: number;
}

interface TrendContext {
  bias: TrendBias;
  armedSide?: 'long' | 'short';
  breakoutLevel?: number;
  armedUntil?: number;
}

// ─── CycleManager ─────────────────────────────────────────────────────────────
// Per-symbol state machine: idle → in_position → cooldown → idle
// Direction: 5m VWAP + EMA9/20 trend + breakout detection.
// Entry/Exit: 1m EMA retrace + rejection continuation, with stop/TP risk model.

export class CycleManager {
  private cycles = new Map<string, SymbolCycle>();
  private trendContexts = new Map<string, TrendContext>();

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
    }
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
        await this.tryEnterSpot(symbol, cycle, indicators);
        break;

      case 'in_position':
        if (!cycle.position) {
          cycle.state = 'idle';
          return;
        }
        await this.tryExitSpot(symbol, cycle, indicators);
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

  // ── Spot entry on 1m retrace into EMA9/EMA20 after 5m breakout ───────────
  private async tryEnterSpot(
    symbol: string,
    cycle: SymbolCycle,
    indicators: NonNullable<ReturnType<typeof computeTrendIndicators>>,
  ): Promise<void> {
    const trend = this.trendContexts.get(symbol);
    if (!trend) return;

    // Spot bot: execute long setups only.
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
    if (SETTINGS.MODE === 'paper') {
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
  }

  // ── Spot exit: stop-loss, take-profit, or 5m bearish regime loss ─────────
  private async tryExitSpot(
    symbol: string,
    cycle: SymbolCycle,
    indicators: NonNullable<ReturnType<typeof computeTrendIndicators>>,
  ): Promise<void> {
    const pos = cycle.position!;
    const trend = this.trendContexts.get(symbol);

    const stopHit = indicators.currentLow <= pos.stopPrice;
    const tpHit = indicators.currentHigh >= pos.takeProfitPrice;
    const trendLost = trend?.bias === 'bearish' && indicators.currentClose < indicators.vwap;

    if (!stopHit && !tpHit && !trendLost) {
      return;
    }

    const plannedExit = stopHit
      ? pos.stopPrice
      : tpHit
        ? pos.takeProfitPrice
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

    if (SETTINGS.MODE === 'paper') {
      this.risk.paperBalance += proceeds;
    }

    this.risk.recordTrade(pnl, pnl >= 0);
    logger.info(`🔵 TREND EXIT: ${symbol}`, {
      reason,
      exitPrice,
      qty: pos.totalQty.toFixed(6),
      stopPrice: pos.stopPrice,
      takeProfitPrice: pos.takeProfitPrice,
      pnl: `$${pnl.toFixed(4)}`,
    });
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

  getTrendSnapshot(symbol: string): TrendContext | null {
    return this.trendContexts.get(symbol) ?? null;
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
