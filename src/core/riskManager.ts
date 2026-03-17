import { SETTINGS } from '../config/settings';
import logger from '../utils/logger';
import { OpenPosition } from './signalEngine';

// ─── Trade record (logged to file on close) ───────────────────────────────────

export interface TradeRecord {
  id: string;
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnlUsdt: number;
  pnlPercent: number;
  reason: string;
  entryTime: string;
  exitTime: string;
}

// ─── RiskManager ──────────────────────────────────────────────────────────────

export class RiskManager {
  // Paper mode balance (ignored in live mode – real balance fetched from exchange)
  paperBalance: number = SETTINGS.PAPER_START_USDT;

  private dayStartBalance: number = SETTINGS.PAPER_START_USDT;
  private dailyPnl: number = 0;
  private openPositions: Map<string, OpenPosition & { qty: number; entryTime: string }> = new Map();
  private closedTrades: TradeRecord[] = [];
  private halted: boolean = false;
  private profitLocked: boolean = false;
  private wins: number = 0;
  private losses: number = 0;

  constructor(startingBalance: number = SETTINGS.PAPER_START_USDT) {
    this.paperBalance = startingBalance;
    this.dayStartBalance = startingBalance;
  }

  // ── Can we start a new limit cycle? ──────────────────────────────────────────
  // reservedUsdt = capital already committed by other pending/active cycles
  canEnterCycle(reservedUsdt: number = 0): boolean {
    if (this.halted) return false;
    if (this.profitLocked) return false;
    return (this.paperBalance - reservedUsdt) >= SETTINGS.BUY_SIZE_USDT;
  }

  // ── Record a closed trade directly (used by CycleManager) ─────────────────
  recordTrade(pnlUsdt: number, won: boolean): void {
    this.dailyPnl += pnlUsdt;
    if (won) this.wins++; else this.losses++;
    this.checkDailyThresholds();
  }

  // ── Daily reset (call at UTC midnight) ────────────────────────────────────────
  resetDay(): void {
    this.dayStartBalance = this.paperBalance;
    this.dailyPnl = 0;
    this.halted = false;
    this.profitLocked = false;
    logger.info('RiskManager: new trading day started', {
      balance: this.paperBalance.toFixed(2),
    });
  }

  // ── Can we open a new position? ────────────────────────────────────────────
  canEnter(symbol: string): boolean {
    if (this.halted) return false;
    if (this.profitLocked) return false;
    if (this.openPositions.has(symbol)) return false; // Already in this pair
    if (this.openPositions.size >= SETTINGS.MAX_CONCURRENT_POSITIONS) return false;
    if (this.getAvailableBalance() < 5) return false; // MEXC minimum notional
    return true;
  }

  // ── Calculate position size in USDT ───────────────────────────────────────
  getPositionSizeUsdt(availableBalance: number): number {
    const size = availableBalance * SETTINGS.MAX_POSITION_PERCENT;
    return Math.floor(size * 100) / 100; // Round down to 2dp
  }

  // ── Register a new open position ──────────────────────────────────────────
  openPosition(
    symbol: string,
    entryPrice: number,
    qty: number,
    tpPrice: number,
    slPrice: number,
    trailingStopDistance: number,
  ): void {
    this.openPositions.set(symbol, {
      symbol,
      entryPrice,
      qty,
      tpPrice,
      slPrice,
      trailingStopDistance,
      peakPrice: entryPrice,
      entryTime: new Date().toISOString(),
    });
    logger.info('Position opened', { symbol, entryPrice, qty, tpPrice, slPrice });
  }

  // ── Update trailing peak price ─────────────────────────────────────────────
  updatePeak(symbol: string, currentPrice: number): void {
    const pos = this.openPositions.get(symbol);
    if (!pos) return;
    if (currentPrice > pos.peakPrice) {
      pos.peakPrice = currentPrice;
    }
  }

  // ── Close a position and record the trade ─────────────────────────────────
  closePosition(symbol: string, exitPrice: number, reason: string): TradeRecord | null {
    const pos = this.openPositions.get(symbol);
    if (!pos) return null;

    const grossPnl = (exitPrice - pos.entryPrice) * pos.qty;
    const fees = (pos.entryPrice + exitPrice) * pos.qty * SETTINGS.TAKER_FEE;
    const netPnl = grossPnl - fees;
    const pnlPercent = (netPnl / (pos.entryPrice * pos.qty)) * 100;

    // Update paper balance
    if (SETTINGS.MODE === 'paper') {
      this.paperBalance += netPnl;
    }

    this.dailyPnl += netPnl;

    if (netPnl >= 0) this.wins++; else this.losses++;

    const record: TradeRecord = {
      id: `${symbol}-${Date.now()}`,
      symbol,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.qty,
      pnlUsdt: parseFloat(netPnl.toFixed(4)),
      pnlPercent: parseFloat(pnlPercent.toFixed(2)),
      reason,
      entryTime: pos.entryTime,
      exitTime: new Date().toISOString(),
    };

    this.closedTrades.push(record);
    this.openPositions.delete(symbol);

    logger.info('Position closed', record);

    // Check daily thresholds
    this.checkDailyThresholds();

    return record;
  }

  // ── Check daily PnL limits ────────────────────────────────────────────────
  private checkDailyThresholds(): void {
    const dailyPnlPercent = this.dailyPnl / this.dayStartBalance;

    if (dailyPnlPercent >= SETTINGS.DAILY_PROFIT_LOCK_PERCENT && !this.profitLocked) {
      this.profitLocked = true;
      logger.info('🔒 Daily profit target reached – no new entries until tomorrow', {
        dailyPnl: this.dailyPnl.toFixed(2),
        percent: (dailyPnlPercent * 100).toFixed(2) + '%',
      });
    }

    if (dailyPnlPercent <= SETTINGS.DAILY_LOSS_CIRCUIT_BREAKER && !this.halted) {
      this.halted = true;
      logger.warn('🛑 Circuit breaker triggered – halting all trading for today', {
        dailyPnl: this.dailyPnl.toFixed(2),
        percent: (dailyPnlPercent * 100).toFixed(2) + '%',
      });
    }
  }

  // ── Getters ──────────────────────────────────────────────────────────────
  getOpenPositions(): Array<OpenPosition & { qty: number; entryTime: string }> {
    return Array.from(this.openPositions.values());
  }

  getPosition(symbol: string): (OpenPosition & { qty: number; entryTime: string }) | undefined {
    return this.openPositions.get(symbol);
  }

  getDailyPnl(): number { return this.dailyPnl; }
  getDailyPnlPercent(): number { return this.dailyPnl / this.dayStartBalance; }
  isHalted(): boolean { return this.halted; }
  isProfitLocked(): boolean { return this.profitLocked; }
  getWinRate(): number {
    const total = this.wins + this.losses;
    return total === 0 ? 0 : this.wins / total;
  }
  getTotalTrades(): number { return this.wins + this.losses; }
  getClosedTrades(): TradeRecord[] { return this.closedTrades; }
  getAvailableBalance(): number {
    // In paper mode use tracked balance; in live this is fetched from exchange separately
    const inPositions = Array.from(this.openPositions.values())
      .reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
    return this.paperBalance - inPositions;
  }
}
