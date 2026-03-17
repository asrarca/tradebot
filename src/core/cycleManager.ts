import { SETTINGS } from '../config/settings';
import { getExchange } from './exchange';
import { RiskManager } from './riskManager';
import logger from '../utils/logger';
import { Candle } from './dataLayer';
import { computeIndicators } from './indicators';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CycleState = 'idle' | 'in_position' | 'cooldown';

export interface ActivePosition {
  symbol: string;
  buyFillPrice: number;
  totalQty: number;
  entryRsi: number;
  exitRsiThreshold: number;
  openedAt: number;
}

interface SymbolCycle {
  state: CycleState;
  position?: ActivePosition;
  cooldownUntil?: number;
}

// ─── CycleManager ─────────────────────────────────────────────────────────────
// Per-symbol state machine: idle → in_position → cooldown → idle
// Entry: 15m price near BB lower band and RSI below threshold.
// Exit: 15m candle touches BB upper band and RSI above threshold.

export class CycleManager {
  private cycles       = new Map<string, SymbolCycle>();
  private lastRsiCache = new Map<string, number>();

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
    }
  }

  // ── Main entry point – called on every closed candle ─────────────────────
  async onCandle(symbol: string, interval: string, candles: Candle[]): Promise<void> {
    if (interval !== SETTINGS.STRATEGY_TIMEFRAME) return;

    const cycle = this.cycles.get(symbol);
    if (!cycle) return;

    const now = Date.now();
    const indicators = computeIndicators(candles);
    if (!indicators) return;

    this.lastRsiCache.set(symbol, indicators.rsi);

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
        if (now >= (cycle.cooldownUntil ?? 0)) {
          cycle.state = 'idle';
          logger.info(`⏰ Cooldown done: ${symbol} – placing next cycle`);
        }
        break;
    }
  }

  // ── Spot entry on 15m BB lower-band proximity ─────────────────────────────
  private async tryEnterSpot(
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
    if (SETTINGS.MODE === 'paper') {
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
      entryPrice: fillPrice,
      bbLower: indicators.bb.lower,
      bbDistancePercent: `${(distanceToLowerBand * 100).toFixed(2)}%`,
      rsi: indicators.rsi.toFixed(2),
      qty: filledQty.toFixed(6),
      notional: `$${(fillPrice * filledQty).toFixed(4)}`,
      exitRule: `touch BB upper + RSI > ${SETTINGS.BB_EXIT_RSI_MIN}`,
    });
  }

  // ── Spot exit on 15m BB upper-band touch + RSI confirmation ──────────────
  private async tryExitSpot(
    symbol: string,
    cycle: SymbolCycle,
    indicators: NonNullable<ReturnType<typeof computeIndicators>>,
  ): Promise<void> {
    const pos = cycle.position!;
    const touchedUpperBand = indicators.currentHigh >= indicators.bb.upper;
    const rsiPassed = indicators.rsi > pos.exitRsiThreshold;

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

    if (SETTINGS.MODE === 'paper') {
      this.risk.paperBalance += proceeds;
    }

    this.risk.recordTrade(pnl, pnl >= 0);
    logger.info(`💚 BB EXIT: ${symbol}`, {
      timeframe: SETTINGS.STRATEGY_TIMEFRAME,
      exitPrice,
      bbUpper: indicators.bb.upper,
      rsi: indicators.rsi.toFixed(2),
      threshold: pos.exitRsiThreshold,
      qty: pos.totalQty.toFixed(6),
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

  // ── RSI accessor for dashboard ───────────────────────────────────────────
  getLastRsi(symbol: string): number | null {
    return this.lastRsiCache.get(symbol) ?? null;
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
