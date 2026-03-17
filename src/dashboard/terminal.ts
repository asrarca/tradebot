import { RiskManager } from '../core/riskManager';
import { DataLayer } from '../core/dataLayer';
import { CycleManager } from '../core/cycleManager';
import { computeIndicators } from '../core/indicators';
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
    const COL_W = 20;
    const headerCells: string[] = [];
    const priceCells:  string[] = [];
    const rsiCells:    string[] = [];
    const bbHighCells: string[] = [];
    const bbLowCells:  string[] = [];

    for (const token of TOKENS) {
      const candles  = this.dataLayer.getCandles(token.symbol, '1m');
      const strategyCandles = this.dataLayer.getCandles(token.symbol, SETTINGS.STRATEGY_TIMEFRAME);
      const lastTick = this.dataLayer.getLastTickAt(token.symbol, '1m');
      const price    = candles.length > 0 ? candles[candles.length - 1].close : null;
      const rsi      = this.dataLayer.getLiveRsi(token.symbol, SETTINGS.STRATEGY_TIMEFRAME, SETTINGS.RSI_PERIOD);
      const indicators = computeIndicators(strategyCandles);

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

      // RSI cell
      const rsiStr = rsi !== null
        ? `RSI15 ${rsiColor(rsi)}${rsi.toFixed(1)}${RESET}`
        : `${DIM}RSI —${RESET}`;
      rsiCells.push(padEnd(rsiStr, COL_W));

      // Bollinger rows (strategy timeframe)
      const bbDecimals = price !== null && price < 1 ? 4 : 2;
      const bbHighStr = indicators
        ? `${YELLOW}BBH $${indicators.bb.upper.toFixed(bbDecimals)}${RESET}`
        : `${DIM}BBH —${RESET}`;
      const bbLowStr = indicators
        ? `${CYAN}BBL $${indicators.bb.lower.toFixed(bbDecimals)}${RESET}`
        : `${DIM}BBL —${RESET}`;
      bbHighCells.push(padEnd(bbHighStr, COL_W));
      bbLowCells.push(padEnd(bbLowStr, COL_W));
    }

    const sep    = `  ${DIM}│${RESET}  `;
    const prefix = `${CYAN}${BOLD}║${RESET}  `;

    return [
      `${CYAN}${BOLD}╠══════════════════════════ Live Prices ═════════════════════════════╣${RESET}`,
      prefix + headerCells.join(sep),
      prefix + priceCells.join(sep),
      prefix + rsiCells.join(sep),
      prefix + bbHighCells.join(sep),
      prefix + bbLowCells.join(sep),
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
        ? `${YELLOW}${BOLD}🔒 PROFIT LOCKED (+3% hit)${RESET}`
        : `${GREEN}${BOLD}🟢 RUNNING${RESET}`;

    const lines = [
      '',
      `${CYAN}${BOLD}╔══════════════════════════ UltraMagnus ═════════════════════════════╗${RESET}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Mode:${RESET} ${mode}  ${BOLD}UTC:${RESET} ${now}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Status:${RESET} ${statusLine}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Balance:${RESET} $${balance.toFixed(2)} USDT  ${BOLD}Daily PnL:${RESET} $${colorPnl(dailyPnl)} ${colorPercent(dailyPct)}`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Daily target:${RESET} ${bar(Math.max(dailyPct, 0), SETTINGS.DAILY_PROFIT_LOCK_PERCENT)} 3%  ${BOLD}Stretch:${RESET} 10%`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Win rate:${RESET} ${(winRate * 100).toFixed(0)}% (${totalTrades} trades)`,
      `${CYAN}${BOLD}║${RESET}  ${BOLD}Strategy:${RESET} ${SETTINGS.STRATEGY_TIMEFRAME} BB mean reversion  ${BOLD}Entry:${RESET} ≤ ${(SETTINGS.BB_ENTRY_MAX_DISTANCE_PERCENT * 100).toFixed(1)}% from BB low + RSI < ${SETTINGS.BB_ENTRY_RSI_MAX}  ${BOLD}Exit:${RESET} BB high + RSI > ${SETTINGS.BB_EXIT_RSI_MIN}`,
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
          `  entry RSI ${pos.entryRsi.toFixed(1)}` +
          `  exit: BB high + RSI > ${pos.exitRsiThreshold}` +
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
