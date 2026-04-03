import { getExchange, getMarketPrice } from './exchange';
import { RiskManager } from './riskManager';
import { EntrySignal, ExitSignal } from './signalEngine';
import { SETTINGS } from '../config/runtimeSettings';
import logger from '../utils/logger';

// ─── OrderManager ─────────────────────────────────────────────────────────────
// In paper mode:  simulates fills at signal price minus taker fee.
// In live mode:   places real MARKET orders on MEXC Spot and tracks order state.

export class OrderManager {
  constructor(private risk: RiskManager) {}

  // ── Handle an entry signal ────────────────────────────────────────────────
  async handleEntry(signal: EntrySignal): Promise<void> {
    const { symbol, price, tpPrice, slPrice, entryLimitTimeoutMs, trailingStopDistance } = signal;

    if (!this.risk.canEnter(symbol)) {
      logger.info(`Entry skipped for ${symbol} – risk manager blocked`, {
        halted: this.risk.isHalted(),
        profitLocked: this.risk.isProfitLocked(),
        openCount: this.risk.getOpenPositions().length,
      });
      return;
    }

    const availableBalance = SETTINGS.MODE === 'paper'
      ? this.risk.getAvailableBalance()
      : await this.getLiveBalance();

    const positionUsdt = this.risk.getPositionSizeUsdt(availableBalance);
    if (positionUsdt < 5) {
      logger.warn(`Position size $${positionUsdt} below MEXC minimum – skipping ${symbol}`);
      return;
    }

    const qty = positionUsdt / price;

    if (SETTINGS.MODE === 'paper') {
      // Simulate fill at signal close price with taker fee applied
      const fillPrice = price * (1 + SETTINGS.TAKER_FEE);
      logger.info(`📄 PAPER BUY ${symbol}`, {
        qty: qty.toFixed(6),
        fillPrice,
        positionUsdt: positionUsdt.toFixed(2),
        tp: tpPrice,
        sl: slPrice,
        entryTimeoutMinutes: Math.round(entryLimitTimeoutMs / 60_000),
        reason: signal.reason,
      });
      this.risk.openPosition(symbol, fillPrice, qty, tpPrice, slPrice, trailingStopDistance);
    } else {
      await this.placeLiveEntry(symbol, qty, tpPrice, slPrice, trailingStopDistance);
    }
  }

  // ── Handle an exit signal ─────────────────────────────────────────────────
  async handleExit(signal: ExitSignal): Promise<void> {
    const { symbol, price, reason } = signal;

    if (SETTINGS.MODE === 'paper') {
      const fillPrice = reason === 'TP_HIT'
        ? price * (1 - SETTINGS.TAKER_FEE)  // Sell slightly below TP (taker)
        : price;
      logger.info(`📄 PAPER SELL ${symbol}`, { fillPrice, reason });
      this.risk.closePosition(symbol, fillPrice, reason);
    } else {
      await this.placeLiveExit(symbol, reason);
    }
  }

  // ── Live order: MARKET buy + OCO stop/TP ─────────────────────────────────
  private async placeLiveEntry(
    symbol: string,
    qty: number,
    tpPrice: number,
    slPrice: number,
    trailingStopDistance: number,
  ): Promise<void> {
    const ex = getExchange();
    try {
      // 1. Market buy
      const order = await ex.createMarketBuyOrder(symbol, qty);
      const fillPrice = order.average ?? order.price ?? await getMarketPrice(symbol);
      logger.info(`✅ LIVE BUY ${symbol}`, { orderId: order.id, fillPrice, qty });

      this.risk.openPosition(symbol, fillPrice, qty, tpPrice, slPrice, trailingStopDistance);

      // 2. Place stop-loss limit order (protects downside)
      const slLimitPrice = slPrice * 0.999; // Slightly below SL trigger
      await ex.createOrder(symbol, 'STOP_LOSS_LIMIT', 'sell', qty, slLimitPrice, {
        stopPrice: slPrice,
      });

      // 3. Place take-profit limit order
      await ex.createLimitSellOrder(symbol, qty, tpPrice);

      logger.info(`🛡️  SL/TP orders placed for ${symbol}`, { sl: slPrice, tp: tpPrice });
    } catch (err) {
      logger.error(`Failed to place live entry for ${symbol}`, { err });
    }
  }

  // ── Live order: MARKET sell (for signal-driven exits) ─────────────────────
  private async placeLiveExit(symbol: string, reason: string): Promise<void> {
    const ex = getExchange();
    const pos = this.risk.getPosition(symbol);
    if (!pos) return;

    try {
      // Cancel any open SL/TP orders first
      const openOrders = await ex.fetchOpenOrders(symbol);
      for (const o of openOrders) {
        await ex.cancelOrder(o.id, symbol);
      }

      // Market sell
      const order = await ex.createMarketSellOrder(symbol, pos.qty);
      const fillPrice = order.average ?? order.price ?? await getMarketPrice(symbol);
      logger.info(`✅ LIVE SELL ${symbol}`, { orderId: order.id, fillPrice, reason });

      this.risk.closePosition(symbol, fillPrice, reason);
    } catch (err) {
      logger.error(`Failed to place live exit for ${symbol}`, { err });
    }
  }

  // ── Close all open positions (circuit breaker) ────────────────────────────
  async closeAll(reason: string = 'CIRCUIT_BREAKER'): Promise<void> {
    const positions = this.risk.getOpenPositions();
    for (const pos of positions) {
      if (SETTINGS.MODE === 'paper') {
        const price = await getMarketPrice(pos.symbol).catch(() => pos.entryPrice);
        this.risk.closePosition(pos.symbol, price, reason);
      } else {
        await this.placeLiveExit(pos.symbol, reason);
      }
    }
  }

  // ── Fetch live USDT balance ────────────────────────────────────────────────
  private async getLiveBalance(): Promise<number> {
    const ex = getExchange();
    const balance = await ex.fetchBalance();
    return (balance['USDT']?.free as number) ?? 0;
  }
}
