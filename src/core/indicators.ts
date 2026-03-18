import {
  BollingerBands,
  RSI,
  ATR,
  SMA,
  EMA,
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

export interface TrendIndicatorResult {
  emaFast: number;
  emaSlow: number;
  vwap: number;
  currentOpen: number;
  currentHigh: number;
  currentLow: number;
  currentClose: number;
  prevClose: number;
}

function computeSessionVwap(candles: Candle[]): number | null {
  if (!candles.length) return null;

  const last = candles[candles.length - 1];
  const dayStart = new Date(last.time);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  const sessionCandles = candles.filter((c) => c.time >= dayStartMs);
  const source = sessionCandles.length > 0 ? sessionCandles : candles;

  let pv = 0;
  let vv = 0;
  for (const c of source) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vv += c.volume;
  }

  if (vv <= 0) return null;
  return pv / vv;
}

export function computeTrendIndicators(candles: Candle[]): TrendIndicatorResult | null {
  const fast = SETTINGS.EMA_FAST_PERIOD;
  const slow = SETTINGS.EMA_SLOW_PERIOD;
  const minRequired = Math.max(fast, slow) + 5;
  if (candles.length < minRequired) return null;

  const closes = candles.map((c) => c.close);
  const emaFastArr = EMA.calculate({ period: fast, values: closes });
  const emaSlowArr = EMA.calculate({ period: slow, values: closes });
  if (!emaFastArr.length || !emaSlowArr.length) return null;

  const vwap = computeSessionVwap(candles);
  if (vwap === null) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  return {
    emaFast: emaFastArr[emaFastArr.length - 1],
    emaSlow: emaSlowArr[emaSlowArr.length - 1],
    vwap,
    currentOpen: last.open,
    currentHigh: last.high,
    currentLow: last.low,
    currentClose: last.close,
    prevClose: prev?.close ?? last.close,
  };
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
