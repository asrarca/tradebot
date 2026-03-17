import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { SETTINGS } from '../config/settings';

// Ensure logs directory exists
const logDir = path.resolve(SETTINGS.LOG_DIR);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    // Daily trade log file
    new winston.transports.File({
      filename: path.join(logDir, `trades-${today}.json`),
      level: 'info',
    }),
    // Error-only file
    new winston.transports.File({
      filename: path.join(logDir, `error-${today}.log`),
      level: 'error',
    }),
    // Console – human-readable (warn+ only; info/debug go to file so dashboard owns the terminal)
    new winston.transports.Console({
      level: process.env.LOG_LEVEL ?? 'warn',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const extras = Object.keys(meta).length
            ? ` ${JSON.stringify(meta)}`
            : '';
          return `[${timestamp}] ${level}: ${message}${extras}`;
        }),
      ),
    }),
  ],
});

export default logger;
