// ─── Token Whitelist ─────────────────────────────────────────────────────────
// All pairs traded against USDT on MEXC Spot.
// Per-token overrides allow future tuning without changing the signal engine.

export interface TokenConfig {
  symbol: string;          // CCXT symbol format e.g. "BTC/USDT"
  bbPeriod?: number;       // Bollinger Band period (default: 20)
  bbStdDev?: number;       // Bollinger Band std dev multiplier (default: 2)
  rsiPeriod?: number;      // RSI period (default: 14)
  atrPeriod?: number;      // ATR period (default: 14)
  tpPercent?: number;      // Take-profit % above entry (default from settings)
  slPercent?: number;      // Stop-loss % below entry (default from settings)
  volumeMultiplier?: number; // Required volume spike vs MA (default: 1.5)
}

export const TOKENS: TokenConfig[] = [
  { symbol: 'BTC/USDT' },
  { symbol: 'TAO/USDT' },
  { symbol: 'RENDER/USDT' },
  { symbol: 'ROSE/USDT' },
];

export const SYMBOLS = TOKENS.map((t) => t.symbol);
