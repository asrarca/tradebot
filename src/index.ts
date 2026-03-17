import * as dotenv from 'dotenv';
dotenv.config();

import logger from './utils/logger';
import { SETTINGS } from './config/settings';
import { TOKENS } from './config/tokens';
import { getExchange, getUsdtBalance } from './core/exchange';
import { DataLayer, Candle } from './core/dataLayer';
import { RiskManager } from './core/riskManager';
import { CycleManager } from './core/cycleManager';
import { Dashboard } from './dashboard/terminal';
import cron from 'node-cron';

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info(`
  ██╗   ██╗██╗  ████████╗██████╗  █████╗ ███╗   ███╗ █████╗  ██████╗ ███╗   ██╗██╗   ██╗███████╗
  ██║   ██║██║  ╚══██╔══╝██╔══██╗██╔══██╗████╗ ████║██╔══██╗██╔════╝ ████╗  ██║██║   ██║██╔════╝
  ██║   ██║██║     ██║   ██████╔╝███████║██╔████╔██║███████║██║  ███╗██╔██╗ ██║██║   ██║███████╗
  ██║   ██║██║     ██║   ██╔══██╗██╔══██║██║╚██╔╝██║██╔══██║██║   ██║██║╚██╗██║██║   ██║╚════██║
  ╚██████╔╝███████╗██║   ██║  ██║██║  ██║██║ ╚═╝ ██║██║  ██║╚██████╔╝██║ ╚████║╚██████╔╝███████║
   ╚═════╝ ╚══════╝╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
  `);

  logger.info(`${SETTINGS.BOT_NAME} starting`, {
    mode: SETTINGS.MODE,
    tokens: TOKENS.map((t) => t.symbol),
    dailyTarget: `${SETTINGS.DAILY_PROFIT_LOCK_PERCENT * 100}%`,
    stretchTarget: `${SETTINGS.STRETCH_TARGET_PERCENT * 100}%`,
    circuitBreaker: `${SETTINGS.DAILY_LOSS_CIRCUIT_BREAKER * 100}%`,
  });

  // ── Validate exchange connectivity ──────────────────────────────────────────
  try {
    const ex = getExchange();
    await ex.loadMarkets();
    logger.info('MEXC markets loaded successfully');
  } catch (err) {
    logger.error('Failed to connect to MEXC – check API keys and network', { err });
    process.exit(1);
  }

  // ── Check USDT balance (live mode only) ─────────────────────────────────────
  if (SETTINGS.MODE === 'live') {
    try {
      const usdtBalance = await getUsdtBalance();
      const MIN_BALANCE = 10;
      if (usdtBalance < MIN_BALANCE) {
        logger.error(
          `Insufficient USDT balance: ${usdtBalance.toFixed(2)} USDT. ` +
          `A minimum of ${MIN_BALANCE} USDT is required to run the bot. ` +
          `Please fund your MEXC account with USDT and try again.`,
          { balance: usdtBalance, required: MIN_BALANCE },
        );
        process.exit(1);
      }
      logger.info(`USDT balance check passed`, { balance: `${usdtBalance.toFixed(2)} USDT` });
    } catch (err) {
      logger.error('Failed to fetch USDT balance – check API permissions', { err });
      process.exit(1);
    }
  }

  // ── Initialise core modules ─────────────────────────────────────────────────
  const riskManager = new RiskManager(SETTINGS.PAPER_START_USDT);
  const dataLayer = new DataLayer();
  const cycleManager = new CycleManager(riskManager, TOKENS.map((t) => t.symbol));
  const dashboard = new Dashboard(riskManager, dataLayer, cycleManager);

  // ── Register candle callback – drives the limit-cycle strategy ──────────────
  dataLayer.onCandle((symbol: string, interval: string, candles: Candle[]) => {
    cycleManager.onCandle(symbol, interval, candles).catch((err) =>
      logger.error('Cycle error', { symbol, interval, err }),
    );
  });

  // ── Daily reset at UTC midnight ─────────────────────────────────────────────
  cron.schedule('0 0 * * *', () => {
    riskManager.resetDay();
  }, { timezone: 'UTC' });

  // ── Start data streams and dashboard ───────────────────────────────────────
  await dataLayer.start();
  dashboard.start();

  // ── Graceful shutdown on SIGINT / SIGTERM ────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received – shutting down UltraMagnus…`);
    dashboard.stop();
    dataLayer.stop();
    const remaining = riskManager.getOpenPositions().length;
    if (remaining > 0) {
      logger.warn(`${remaining} positions still open at shutdown`);
    }
    logger.info('Final balance', { usdt: riskManager.paperBalance.toFixed(2) });
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(`${SETTINGS.BOT_NAME} is running. Press Ctrl+C to stop.`);
}

main().catch((err) => {
  console.error('Fatal error in main():', err);
  process.exit(1);
});
