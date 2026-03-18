// ─── Bot Settings ─────────────────────────────────────────────────────────────
// Central config for all risk, signal, and operational parameters.
// Edit here to tune the bot – do not hardcode values in other modules.

export const SETTINGS = {
  // ── Bot identity ────────────────────────────────────────────────────────────
  BOT_NAME: 'UltraMagnus',

  // ── Trading mode (overridden by .env MODE variable) ─────────────────────────
  // 'paper' = simulate fills locally, no real orders
  // 'live'  = real orders on MEXC
  MODE: (process.env.MODE ?? 'paper') as 'paper' | 'live',
  PAPER_START_USDT: 1000, // Starting balance for paper mode

  // ── Exchange ─────────────────────────────────────────────────────────────────
  TAKER_FEE: 0.001,           // MEXC spot taker fee: 0.1%
  EXECUTION_MARKET_TYPE: (process.env.EXECUTION_MARKET_TYPE ?? 'swap') as 'spot' | 'swap', // swap enables shorting
  ALLOW_SHORTS: (process.env.ALLOW_SHORTS ?? 'true') === 'true',
  CANDLE_INTERVALS: ['1m', '5m'] as const,
  CANDLE_BUFFER_SIZE: 50,     // Rolling candle history per pair per interval

  // ── Signal parameters (defaults – can be overridden per token in tokens.ts) ─
  BB_PERIOD: 20,
  BB_STD_DEV: 2,
  RSI_PERIOD: 14,
  ATR_PERIOD: 14,
  RSI_ENTRY_MIN: 42,         // RSI must be above this to enter
  RSI_ENTRY_MAX: 72,         // RSI must be below this to enter (not overextended)
  RSI_EXIT_OVERBOUGHT: 78,   // Exit when RSI climbs above this
  VOLUME_MULTIPLIER: 1.05,   // Volume must be >= this × 20-period volume MA

  // ── Risk management ──────────────────────────────────────────────────────────
  MAX_POSITION_PERCENT: 0.25,   // Max 25% of USDT balance per trade
  MAX_CONCURRENT_POSITIONS: 3,  // Max open trades at once
  TP_PERCENT: 0.006,            // Take-profit: +0.6% above entry
  SL_PERCENT: 0.0035,           // Hard stop-loss: -0.35% below entry
  TRAILING_STOP_ATR_MULTIPLIER: 1.0,  // Trailing stop = 1× ATR below peak

  // Volatility adaptation (ATR% = ATR / price)
  VOLATILITY_BASE_ATR_PERCENT: 0.004, // 0.4% ATR is treated as baseline
  TP_MIN_PERCENT: 0.004,              // 0.4% minimum TP in calm markets
  TP_MAX_PERCENT: 0.012,              // 1.2% maximum TP in volatile markets
  SL_MIN_PERCENT: 0.0025,             // 0.25% minimum SL in calm markets
  SL_MAX_PERCENT: 0.006,              // 0.6% maximum SL in volatile markets

  // Legacy timeout settings kept for compatibility with the unused signal engine
  ENTRY_TIMEOUT_DEFAULT_MS: 15 * 60 * 1000,
  ENTRY_TIMEOUT_MIN_MS: 10 * 60 * 1000,
  ENTRY_TIMEOUT_MAX_MS: 20 * 60 * 1000,

  // ── VWAP + 9/20 EMA retrace strategy ────────────────────────────────────────
  STRATEGY_DIRECTION_TIMEFRAME: '5m', // Trend/breakout detection timeframe
  STRATEGY_ENTRY_TIMEFRAME: '1m',     // Entry/exit trigger timeframe
  BUY_SIZE_USDT: 20,                  // Fixed notional per spot buy
  EMA_FAST_PERIOD: 9,
  EMA_SLOW_PERIOD: 20,
  BREAKOUT_LOOKBACK_5M: 6,            // 6 x 5m = last 30m structure
  BREAKOUT_ARM_MS: 45 * 60 * 1000,    // Breakout remains valid for pullback entry
  EMA_RETRACE_TOLERANCE_PERCENT: 0.0015, // Allow slight dip below EMA20 on retrace
  STOP_BUFFER_PERCENT: 0.0005,        // Stop padding below pullback low/EMA20
  DEFAULT_STOP_PERCENT: 0.0035,       // Fallback stop if computed stop is invalid
  RISK_REWARD_RATIO: 2.0,             // TP = risk * RR from entry
  CYCLE_COOLDOWN_MS: 5 * 60 * 1000,   // Cooldown after a completed spot cycle

  // ── Daily PnL thresholds ─────────────────────────────────────────────────────
  DAILY_PROFIT_LOCK_PERCENT: 0.04,     // Pause new entries at +4% daily gain (lets volatile days run)
  DAILY_LOSS_CIRCUIT_BREAKER: -0.02,  // Sell all + halt at -2% daily loss
  STRETCH_TARGET_PERCENT: 0.10,        // Stretch goal: +10% (informational only)

  // ── Operational ─────────────────────────────────────────────────────────────
  DASHBOARD_REFRESH_MS: 30_000,  // Terminal dashboard refresh interval
  PRICE_TICKER_ENABLED: true,    // Show live token prices while waiting for trades
  PRICE_TICKER_REFRESH_MS: 5_000, // How often to refresh prices (ms)
  LOG_DIR: 'logs',
} as const;

export type Mode = typeof SETTINGS.MODE;
