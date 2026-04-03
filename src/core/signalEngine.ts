import { IndicatorResult } from './indicators';
import { SETTINGS } from '../config/runtimeSettings';
import { TokenConfig } from '../config/tokens';

// ─── Signal types ─────────────────────────────────────────────────────────────

export type EntrySignal = {
  type: 'ENTER';
  symbol: string;
  price: number;
  tpPrice: number;
  slPrice: number;
  entryLimitTimeoutMs: number;
  trailingStopDistance: number; // ATR-based trailing distance in price units
  reason: string;
};

export type ExitSignal = {
  type: 'EXIT';
  symbol: string;
  price: number;
  reason: 'TP_HIT' | 'SL_HIT' | 'TRAILING_STOP' | 'RSI_OVERBOUGHT' | 'CIRCUIT_BREAKER';
};

export type Signal = EntrySignal | ExitSignal | { type: 'HOLD' };

// ─── Entry signal check ───────────────────────────────────────────────────────
// Long-only. No short entries ever generated.

export function checkEntrySignal(
  symbol: string,
  indicators: IndicatorResult,
  tokenConfig: Partial<TokenConfig> = {},
): EntrySignal | null {
  const { bb, rsi, atr, volumeMA, currentVolume, currentClose, prevClose } = indicators;

  const rsiMin = SETTINGS.RSI_ENTRY_MIN;
  const rsiMax = SETTINGS.RSI_ENTRY_MAX;
  const volMultiplier = tokenConfig.volumeMultiplier ?? SETTINGS.VOLUME_MULTIPLIER;
  const baseTpPercent = tokenConfig.tpPercent ?? SETTINGS.TP_PERCENT;
  const baseSlPercent = tokenConfig.slPercent ?? SETTINGS.SL_PERCENT;

  // ── Signal conditions (BB middle-band crossover scalping) ────────────────────
  const crossedAboveMiddle = prevClose <= bb.middle && currentClose > bb.middle;
  const rsiInRange = rsi >= rsiMin && rsi <= rsiMax;
  const volumeAboveAvg = currentVolume >= volumeMA * volMultiplier;
  const notExtended = currentClose < bb.upper;

  if (!crossedAboveMiddle || !rsiInRange || !volumeAboveAvg || !notExtended) return null;

  // ── Volatility-adaptive TP/SL ───────────────────────────────────────────────
  const atrPercent = atr / currentClose;
  const volatilityFactor = Math.max(
    0.8,
    Math.min(1.8, atrPercent / SETTINGS.VOLATILITY_BASE_ATR_PERCENT),
  );
  const tpPercent = Math.max(
    SETTINGS.TP_MIN_PERCENT,
    Math.min(SETTINGS.TP_MAX_PERCENT, baseTpPercent * volatilityFactor),
  );
  const slPercent = Math.max(
    SETTINGS.SL_MIN_PERCENT,
    Math.min(SETTINGS.SL_MAX_PERCENT, baseSlPercent * volatilityFactor),
  );
  const entryLimitTimeoutMs = Math.max(
    SETTINGS.ENTRY_TIMEOUT_MIN_MS,
    Math.min(
      SETTINGS.ENTRY_TIMEOUT_MAX_MS,
      Math.round(SETTINGS.ENTRY_TIMEOUT_DEFAULT_MS / Math.max(volatilityFactor, 0.0001)),
    ),
  );

  const tpPrice = currentClose * (1 + tpPercent);
  const slPrice = currentClose * (1 - slPercent);
  const trailingStopDistance = atr * SETTINGS.TRAILING_STOP_ATR_MULTIPLIER;

  return {
    type: 'ENTER',
    symbol,
    price: currentClose,
    tpPrice,
    slPrice,
    entryLimitTimeoutMs,
    trailingStopDistance,
    reason: `BB mid crossover: ${prevClose.toFixed(4)}→${currentClose.toFixed(4)} (mid ${bb.middle.toFixed(4)}), RSI ${rsi.toFixed(1)}, vol ${(currentVolume / volumeMA).toFixed(2)}×, ATR% ${(atrPercent * 100).toFixed(2)}%, TP ${(tpPercent * 100).toFixed(2)}%, SL ${(slPercent * 100).toFixed(2)}%, entryTimeout ${(entryLimitTimeoutMs / 60000).toFixed(0)}m`,
  };
}

// ─── Exit signal check ────────────────────────────────────────────────────────
// Called on every candle for each open position.

export interface OpenPosition {
  symbol: string;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  trailingStopDistance: number;
  peakPrice: number; // Track highest price since entry for trailing stop
}

export function checkExitSignal(
  position: OpenPosition,
  indicators: IndicatorResult,
): ExitSignal | null {
  const { rsi, currentClose, currentLow } = indicators;

  // Update peak (caller is responsible for persisting this)
  const effectivePeak = Math.max(position.peakPrice, currentClose);
  const trailingStopPrice = effectivePeak - position.trailingStopDistance;

  // ── Exit conditions (checked in priority order) ───────────────────────────
  if (currentClose >= position.tpPrice) {
    return { type: 'EXIT', symbol: position.symbol, price: currentClose, reason: 'TP_HIT' };
  }

  if (currentLow <= position.slPrice) {
    return { type: 'EXIT', symbol: position.symbol, price: position.slPrice, reason: 'SL_HIT' };
  }

  if (currentLow <= trailingStopPrice && effectivePeak > position.entryPrice * 1.005) {
    // Only activate trailing stop after at least 0.5% above entry (avoids premature exit)
    return { type: 'EXIT', symbol: position.symbol, price: trailingStopPrice, reason: 'TRAILING_STOP' };
  }

  if (rsi > SETTINGS.RSI_EXIT_OVERBOUGHT) {
    return { type: 'EXIT', symbol: position.symbol, price: currentClose, reason: 'RSI_OVERBOUGHT' };
  }

  return null;
}
