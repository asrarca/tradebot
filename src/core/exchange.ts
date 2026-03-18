import { mexc as MexcExchange, OHLCV } from 'ccxt';
import * as dotenv from 'dotenv';
import logger from '../utils/logger';
import { SETTINGS } from '../config/settings';

dotenv.config();

// ─── MEXC Spot Client ─────────────────────────────────────────────────────────
// Configured to SPOT only – futures are explicitly disabled.
// In paper mode, API keys are optional (market data is public).

let exchange: MexcExchange;

export function getExchange(): MexcExchange {
  if (exchange) return exchange;

  const apiKey = process.env.MEXC_API_KEY ?? '';
  const secret = process.env.MEXC_SECRET ?? '';

  if (SETTINGS.MODE === 'live' && (!apiKey || !secret)) {
    throw new Error(
      'MEXC_API_KEY and MEXC_SECRET must be set in .env when MODE=live',
    );
  }

  exchange = new MexcExchange({
    apiKey,
    secret,
    options: {
      defaultType: 'spot', // CRITICAL: locks exchange to spot only
    },
    enableRateLimit: true, // Respect MEXC 20 req/s limit automatically
  });

  logger.info(`Exchange initialised`, {
    mode: SETTINGS.MODE,
    exchange: 'MEXC Spot v3',
    authenticated: !!(apiKey && secret),
  });

  return exchange;
}

// ─── Fetch USDT balance ───────────────────────────────────────────────────────
export async function getUsdtBalance(): Promise<number> {
  if (SETTINGS.MODE === 'paper') {
    throw new Error('getUsdtBalance() should not be called in paper mode – use RiskManager.paperBalance');
  }
  const ex = getExchange();
  const balance = await ex.fetchBalance();
  return (balance['USDT']?.free as number) ?? 0;
}

// ─── Fetch full account equity in USDT (USDT + all token holdings marked-to-market) ──
export async function getAccountUsdtEquity(): Promise<number> {
  if (SETTINGS.MODE === 'paper') {
    return 0;
  }

  const ex = getExchange();
  const balance = await ex.fetchBalance();
  const totals = (balance.total ?? {}) as unknown as Record<string, number>;

  let equityUsdt = Number(totals.USDT ?? 0);

  for (const [asset, rawAmount] of Object.entries(totals)) {
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (asset === 'USDT') continue;

    const symbol = `${asset}/USDT`;
    try {
      const ticker = await ex.fetchTicker(symbol);
      const price = ticker.last ?? ticker.bid ?? ticker.ask;
      if (price && Number.isFinite(price) && price > 0) {
        equityUsdt += amount * price;
      }
    } catch {
      // Ignore assets without a direct USDT market
    }
  }

  return equityUsdt;
}

// ─── Fetch current market price ──────────────────────────────────────────────
export async function getMarketPrice(symbol: string): Promise<number> {
  const ex = getExchange();
  const ticker = await ex.fetchTicker(symbol);
  const price = ticker.last ?? ticker.bid ?? ticker.ask;
  if (!price) throw new Error(`Cannot determine price for ${symbol}`);
  return price;
}

// ─── Fetch historical OHLCV candles (REST, for seeding the buffer) ────────────
export async function fetchOHLCV(
  symbol: string,
  timeframe: string,
  limit: number = 50,
): Promise<OHLCV[]> {
  const ex = getExchange();
  return ex.fetchOHLCV(symbol, timeframe, undefined, limit);
}
