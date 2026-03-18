import { RiskManager } from '../core/riskManager';
import { DataLayer } from '../core/dataLayer';
import { CycleManager } from '../core/cycleManager';
import { computeTrendIndicators } from '../core/indicators';
import { getAccountUsdtEquity } from '../core/exchange';
import { TOKENS } from '../config/tokens';
import { SETTINGS } from '../config/settings';

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

const BOTTOM_BORDER = `${CYAN}${BOLD}╚══════════════════════════════════════════════════════════════════╝${RESET}`;

export class Dashboard {
  private dashTimer: ReturnType<typeof setInterval> | null = null;
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  private liveEquityUsdt: number | null = null;
  private liveEquityLoading = false;

  constructor(
    private risk: RiskManager,
    private dataLayer: DataLayer,
    private cycleManager: CycleManager,
  ) {}

  start(): void {
    if (SETTINGS.MODE === 'live') {
      void this.refreshLiveEquity();
    }
    this.printFull();
    this.dashTimer = setInterval(() => this.printFull(), SETTINGS.DASHBOARD_REFRESH_MS);
    if (SETTINGS.PRICE_TICKER_ENABLED) {
      // Skip the very first tick – printFull() just ran
      this.tickerTimer = setInterval(() => this.printPriceTicker(), SETTINGS.PRICE_TICKER_REFRESH_MS);
    }
  }

  private async refreshLiveEquity(): Promise<void> {
    if (SETTINGS.MODE !== 'live' || this.liveEquityLoading) return;
    this.liveEquityLoading = true;
    try {
      this.liveEquityUsdt = await getAccountUsdtEquity();
    } finally {
      this.liveEquityLoading = false;
    }
  }

  stop(): void {
    if (this.dashTimer)  clearInterval(this.dashTimer);
    if (this.tickerTimer) clearInterval(this.tickerTimer);
  }

  // ── Build price table rows (shared by full render and ticker) ─────────────────────
  private buildPriceLines(): string[] {
    const COL_W = 20;
    const headerCells: string[] = [];
    const priceCells:  string[] = [];
    const trendCells:  string[] = [];
    const emaCells:    string[] = [];
    const vwapCells:   string[] = [];

    for (const token of TOKENS) {
      const candles  = this.dataLayer.getCandles(token.symbol, '1m');
      const directionCandles = this.dataLayer.getCandles(token.symbol, SETTINGS.STRATEGY_DIRECTION_TIMEFRAME);
      const lastTick = this.dataLayer.getLastTickAt(token.symbol, '1m');
      const price    = candles.length > 0 ? candles[candles.length - 1].close : null;
      const entryIndicators = computeTrendIndicators(candles);
      const directionIndicators = computeTrendIndicators(directionCandles);
      const trendSnapshot = this.cycleManager.getTrendSnapshot(token.symbol);

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

      const trendStr = trendSnapshot
        ? trendSnapshot.bias === 'bullish'
          ? `${GREEN}5m BULL${RESET}`
          : trendSnapshot.bias === 'bearish'
            ? `${RED}5m BEAR${RESET}`
            : `${YELLOW}5m NEUTRAL${RESET}`
        : `${DIM}5m —${RESET}`;
      trendCells.push(padEnd(trendStr, COL_W));

      const emaDecimals = price !== null && price < 1 ? 4 : 2;
      const emaStr = entryIndicators
        ? `${CYAN}EMA9/20 ${entryIndicators.emaFast.toFixed(emaDecimals)}/${entryIndicators.emaSlow.toFixed(emaDecimals)}${RESET}`
        : `${DIM}EMA9/20 —${RESET}`;
      emaCells.push(padEnd(emaStr, COL_W));

      const vwapStr = directionIndicators
        ? `${YELLOW}VWAP5 $${directionIndicators.vwap.toFixed(emaDecimals)}${RESET}`
        : `${DIM}VWAP5 —${RESET}`;
      vwapCells.push(padEnd(vwapStr, COL_W));
    }

    const sep    = `  ${DIM}│${RESET}  `;
    const prefix = `${CYAN}${BOLD}║${RESET}  `;

    return [
      `${CYAN}${BOLD}╠══════════════════════════ Live Prices ═════════════════════════════╣${RESET}`,
      prefix + headerCells.join(sep),
      prefix + priceCells.join(sep),
      prefix + trendCells.join(sep),
      prefix + emaCells.join(sep),
      prefix + vwapCells.join(sep),
    ];
  }

  // ── Full dashboard render (clears screen, runs every DASHBOARD_REFRESH_MS) ───────
  printFull(): void {
    if (SETTINGS.MODE === 'live') {
      void this.refreshLiveEquity();
    }

    const now = new Date().toLocaleString('en-CA', { timeZone: 'UTC', hour12: false });
    const mode = SETTINGS.MODE === 'paper' ? `${YELLOW}PAPER${RESET}` : `${RED}LIVE${RESET}`;
    const balance = SETTINGS.MODE === 'live'
      ? (this.liveEquityUsdt ?? 0)
      : this.risk.paperBalance;
    const balanceStr = SETTINGS.MODE === 'live' && this.liveEquityUsdt === null
      ? `${DIM}syncing…${RESET}`
      : `$${balance.toFixed(2)} USDT`;
    const dailyPnl = this.risk.getDailyPnl();
    const dailyPct = this.risk.getDailyPnlPercent();
    const winRate = this.risk.getWinRate();
    const totalTrades = this.risk.getTotalTrades();

    const statusLine = this.risk.isHalted()
      ? `${RED}${BOLD}🛑 HALTED (circuit breaker)${RESET}`
      : this.risk.isProfitLocked()
        ? `${YELLOW}${BOLD}🔒 PROFIT LOCKED (+3% hit)${RESET}`
        : `${GREEN}${BOLD}🟢 RUNNING${RESET}`;

    const lines = [
      '',
      `${CYAN}${BOLD}╔══════════════════════════ UltraMagnus ═════════════════════════════╗${RESET}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Mode:${RESET} ${mode}  ${BOLD}UTC:${RESET} ${now}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Status:${RESET} ${statusLine}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Balance:${RESET} ${balanceStr}  ${BOLD}Daily PnL:${RESET} $${colorPnl(dailyPnl)} ${colorPercent(dailyPct)}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Win rate:${RESET} ${(winRate * 100).toFixed(0)}% (${totalTrades} trades)`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Strategy:${RESET} VWAP + EMA9/20 retrace  ${BOLD}Direction:${RESET} ${SETTINGS.STRATEGY_DIRECTION_TIMEFRAME}  ${BOLD}Entry:${RESET} ${SETTINGS.STRATEGY_ENTRY_TIMEFRAME} pullback rejection  ${BOLD}Risk:${RESET} RR ${SETTINGS.RISK_REWARD_RATIO}:1`,
      `${CYAN}${BOLD}╠══════════════════════════ Cycle States ════════════════════════════╣${RESET}`,
    ];

    for (const c of this.cycleManager.getCycles()) {
      let stateStr: string;
      if (c.state === 'idle') {
        stateStr = `${DIM}⬜ IDLE${RESET}`;
        lines.push(`${CYAN}${BOLD}║${RESET}  ${BOLD}${c.symbol}${RESET}  ${stateStr}`);
      } else if (c.state === 'in_position' && c.position) {
        const pos = c.position;
        stateStr = `${GREEN}${BOLD}🟢 POSITION${RESET}`;
        const minsOpen = Math.max(0, Math.round((Date.now() - pos.openedAt) / 60_000));
        lines.push(
          `${CYAN}${BOLD}║${RESET}  ${BOLD}${c.symbol}${RESET}  ${stateStr}` +
          `  entry@$${pos.buyFillPrice.toFixed(2)}` +
          `  stop@$${pos.stopPrice.toFixed(2)}` +
          `  tp@$${pos.takeProfitPrice.toFixed(2)}` +
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
