import {
  BollingerBands,
  RSI,
  ATR,
  SMA,
  EMA,
} from 'technicalindicators';
import { Candle } from './dataLayer';
import { SETTINGS } from '../config/runtimeSettings';
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

// ─── Pure-math helpers (no library dependency) ────────────────────────────────

export function computeEma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: number[] = [ema];
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export function computeRsiSeries(closes: number[], period: number): number[] {
  if (closes.length < period + 1) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const rsiArr: number[] = [];
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  rsiArr.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0));
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsiArr.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }
  return rsiArr;
}

export function computeStochRsi(
  closes: number[],
  rsiPeriod: number,
  stochPeriod: number,
  kPeriod: number,
  dPeriod: number,
): { k: number; d: number } | null {
  const rsiArr = computeRsiSeries(closes, rsiPeriod);
  if (rsiArr.length < stochPeriod + kPeriod + dPeriod - 2) return null;

  // Raw %K for each RSI window
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiArr.length; i++) {
    const window = rsiArr.slice(i - stochPeriod + 1, i + 1);
    const minRsi = Math.min(...window);
    const maxRsi = Math.max(...window);
    const range = maxRsi - minRsi;
    rawK.push(range === 0 ? 0 : ((rsiArr[i] - minRsi) / range) * 100);
  }

  // Smooth %K with kPeriod SMA
  const smoothK: number[] = [];
  for (let i = kPeriod - 1; i < rawK.length; i++) {
    const slice = rawK.slice(i - kPeriod + 1, i + 1);
    smoothK.push(slice.reduce((a, b) => a + b, 0) / kPeriod);
  }

  if (smoothK.length < dPeriod) return null;
  const k = smoothK[smoothK.length - 1];
  const dSlice = smoothK.slice(-dPeriod);
  const d = dSlice.reduce((a, b) => a + b, 0) / dPeriod;
  return { k, d };
}

export function computeMacd(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): { macd: number; signal: number; histogram: number } | null {
  const fastEma = computeEma(closes, fastPeriod);
  const slowEma = computeEma(closes, slowPeriod);
  if (!fastEma.length || !slowEma.length) return null;

  const diff = fastEma.length - slowEma.length;
  const macdLine: number[] = slowEma.map((s, i) => fastEma[i + diff] - s);

  const signalEma = computeEma(macdLine, signalPeriod);
  if (!signalEma.length) return null;

  const latestMacd = macdLine[macdLine.length - 1];
  const latestSignal = signalEma[signalEma.length - 1];
  return {
    macd: latestMacd,
    signal: latestSignal,
    histogram: latestMacd - latestSignal,
  };
}

export interface SwingIndicatorResult {
  rsi: number;
  stochK: number;
  stochD: number;
  macdHistogram: number;
  ema50: number;
  ema200: number;
  atr: number;
  volumeMA: number;
  currentVolume: number;
  bbUpper: number;
  bbLower: number;
  currentClose: number;
  currentHigh: number;
  currentLow: number;
  currentOpen: number;
  prevClose: number;
  prevLow: number;
  prevHigh: number;
}

export function computeSwingIndicators(candles: Candle[]): SwingIndicatorResult | null {
  const {
    SWING_RSI_PERIOD, SWING_STOCHRSI_PERIOD, SWING_STOCHRSI_K_PERIOD, SWING_STOCHRSI_D_PERIOD,
    SWING_EMA_FAST, SWING_EMA_SLOW, SWING_ATR_PERIOD,
    SWING_MACD_FAST, SWING_MACD_SLOW, SWING_MACD_SIGNAL,
    BB_PERIOD, BB_STD_DEV,
  } = SETTINGS;

  const minRequired = SWING_EMA_SLOW + SWING_RSI_PERIOD + 10;
  if (candles.length < minRequired) return null;

  const closes  = candles.map((c) => c.close);
  const highs   = candles.map((c) => c.high);
  const lows    = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const rsiArr = computeRsiSeries(closes, SWING_RSI_PERIOD);
  if (!rsiArr.length) return null;
  const rsi = rsiArr[rsiArr.length - 1];

  const stoch = computeStochRsi(closes, SWING_RSI_PERIOD, SWING_STOCHRSI_PERIOD, SWING_STOCHRSI_K_PERIOD, SWING_STOCHRSI_D_PERIOD);
  if (!stoch) return null;

  const macdResult = computeMacd(closes, SWING_MACD_FAST, SWING_MACD_SLOW, SWING_MACD_SIGNAL);
  if (!macdResult) return null;

  const ema50Arr  = computeEma(closes, SWING_EMA_FAST);
  const ema200Arr = computeEma(closes, SWING_EMA_SLOW);
  if (!ema50Arr.length || !ema200Arr.length) return null;

  // Wilder-smoothed ATR
  let atr = 0;
  {
    let sumTR = 0;
    for (let i = 1; i <= SWING_ATR_PERIOD; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      );
      sumTR += tr;
    }
    atr = sumTR / SWING_ATR_PERIOD;
    for (let i = SWING_ATR_PERIOD + 1; i < candles.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      );
      atr = (atr * (SWING_ATR_PERIOD - 1) + tr) / SWING_ATR_PERIOD;
    }
  }

  // Volume MA (20-period SMA)
  const volSlice = volumes.slice(-20);
  const volumeMA = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;

  // Bollinger Bands (pure math)
  const bbSlice = closes.slice(-BB_PERIOD);
  const bbMean = bbSlice.reduce((a, b) => a + b, 0) / BB_PERIOD;
  const variance = bbSlice.reduce((acc, v) => acc + (v - bbMean) ** 2, 0) / BB_PERIOD;
  const stdDev = Math.sqrt(variance);
  const bbUpper = bbMean + BB_STD_DEV * stdDev;
  const bbLower = bbMean - BB_STD_DEV * stdDev;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  return {
    rsi,
    stochK: stoch.k,
    stochD: stoch.d,
    macdHistogram: macdResult.histogram,
    ema50: ema50Arr[ema50Arr.length - 1],
    ema200: ema200Arr[ema200Arr.length - 1],
    atr,
    volumeMA,
    currentVolume: last.volume,
    bbUpper,
    bbLower,
    currentClose: last.close,
    currentHigh: last.high,
    currentLow: last.low,
    currentOpen: last.open,
    prevClose: prev?.close ?? last.close,
    prevLow:   prev?.low  ?? last.low,
    prevHigh:  prev?.high ?? last.high,
  };
}

export function detectCandlestickPattern(candles: Candle[]): 'bullish' | 'bearish' | 'none' {
  if (candles.length < 2) return 'none';
  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const currBody  = Math.abs(curr.close - curr.open);
  const currRange = curr.high - curr.low;

  // Bullish engulfing
  if (prev.close < prev.open && curr.close > curr.open &&
      curr.close > prev.open && curr.open < prev.close) return 'bullish';

  // Bearish engulfing
  if (prev.close > prev.open && curr.close < curr.open &&
      curr.open > prev.close && curr.close < prev.open) return 'bearish';

  // Pin bars
  if (currRange > 0) {
    const lowerWick = Math.min(curr.open, curr.close) - curr.low;
    if (lowerWick >= currRange * 0.6 && currBody <= currRange * 0.3) return 'bullish';
    const upperWick = curr.high - Math.max(curr.open, curr.close);
    if (upperWick >= currRange * 0.6 && currBody <= currRange * 0.3) return 'bearish';
  }

  return 'none';
}

export function detectBullishDivergence(candles: Candle[], rsiSeries: number[]): boolean {
  if (candles.length < 5 || rsiSeries.length < 5) return false;
  const priceNow  = candles[candles.length - 1].low;
  const pricePrev = Math.min(...candles.slice(-5, -1).map((c) => c.low));
  const rsiNow    = rsiSeries[rsiSeries.length - 1];
  const rsiPrev   = Math.min(...rsiSeries.slice(-5, -1));
  return priceNow < pricePrev && rsiNow > rsiPrev;
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
