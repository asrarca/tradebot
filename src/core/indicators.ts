import {
  BollingerBands,
  RSI,
  ATR,
  SMA,
} from 'technicalindicators';
import { Candle } from './dataLayer';
import { SETTINGS } from '../config/settings';
import { TokenConfig } from '../config/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IndicatorResult {
  bb: {
    upper: number;
    middle: number;
    lower: number;
  };
  rsi: number;
  atr: number;
  volumeMA: number;
  currentVolume: number;
  currentClose: number;
  currentHigh: number;
  currentLow: number;
  prevClose: number; // previous candle's close – used for crossover detection
}

// ─── Compute all indicators for a candle buffer ───────────────────────────────
// Returns null if there are insufficient candles to compute reliably.

export function computeIndicators(
  candles: Candle[],
  tokenConfig: Partial<TokenConfig> = {},
): IndicatorResult | null {
  const bbPeriod = tokenConfig.bbPeriod ?? SETTINGS.BB_PERIOD;
  const bbStdDev = tokenConfig.bbStdDev ?? SETTINGS.BB_STD_DEV;
  const rsiPeriod = tokenConfig.rsiPeriod ?? SETTINGS.RSI_PERIOD;
  const atrPeriod = tokenConfig.atrPeriod ?? SETTINGS.ATR_PERIOD;

  const minRequired = Math.max(bbPeriod, rsiPeriod, atrPeriod) + 5;
  if (candles.length < minRequired) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  // ── Bollinger Bands ──────────────────────────────────────────────────────────
  const bbResults = BollingerBands.calculate({
    period: bbPeriod,
    values: closes,
    stdDev: bbStdDev,
  });
  if (!bbResults.length) return null;
  const latestBB = bbResults[bbResults.length - 1];

  // ── RSI ──────────────────────────────────────────────────────────────────────
  const rsiResults = RSI.calculate({ period: rsiPeriod, values: closes });
  if (!rsiResults.length) return null;
  const latestRSI = rsiResults[rsiResults.length - 1];

  // ── ATR ──────────────────────────────────────────────────────────────────────
  const atrResults = ATR.calculate({
    period: atrPeriod,
    high: highs,
    low: lows,
    close: closes,
  });
  if (!atrResults.length) return null;
  const latestATR = atrResults[atrResults.length - 1];

  // ── Volume SMA (20-period) ───────────────────────────────────────────────────
  const volSmaResults = SMA.calculate({ period: 20, values: volumes });
  if (!volSmaResults.length) return null;
  const latestVolMA = volSmaResults[volSmaResults.length - 1];

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  return {
    bb: {
      upper: latestBB.upper,
      middle: latestBB.middle,
      lower: latestBB.lower,
    },
    rsi: latestRSI,
    atr: latestATR,
    volumeMA: latestVolMA,
    currentVolume: last.volume,
    currentClose: last.close,
    currentHigh: last.high,
    currentLow: last.low,
    prevClose: prev?.close ?? last.close,
  };
}
