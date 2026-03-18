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

const WS_CONNECTIVITY_RE = /^(WS\s|WS watchdog fired|DataLayer: subscribed to)/;

const onlyWsConnectivity = winston.format((info) => {
  const message = typeof info.message === 'string' ? info.message : '';
  return WS_CONNECTIVITY_RE.test(message) ? info : false;
});

const excludeWsConnectivity = winston.format((info) => {
  const message = typeof info.message === 'string' ? info.message : '';
  return WS_CONNECTIVITY_RE.test(message) ? false : info;
});

const timestampFirstJson = winston.format.printf((info) => {
  const { timestamp, ...rest } = info;
  const ordered = timestamp
    ? { timestamp, ...rest }
    : rest;
  return JSON.stringify(ordered);
});

const fileJsonFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  timestampFirstJson,
);

const logger = winston.createLogger({
  level: 'debug',
  transports: [
    // Daily trade log file (trades only; WS connectivity logs excluded)
    new winston.transports.File({
      filename: path.join(logDir, `trades-${today}.json`),
      level: 'info',
      format: winston.format.combine(fileJsonFormat, excludeWsConnectivity()),
    }),
    // WebSocket connectivity log file (subscribe/confirm/disconnect/reconnect)
    new winston.transports.File({
      filename: path.join(logDir, `ws-${today}.json`),
      level: 'info',
      format: winston.format.combine(fileJsonFormat, onlyWsConnectivity()),
    }),
    // Error-only file
    new winston.transports.File({
      filename: path.join(logDir, `error-${today}.log`),
      level: 'error',
      format: fileJsonFormat,
    }),
    // Console – human-readable (warn+ only; info/debug go to file so dashboard owns the terminal)
    new winston.transports.Console({
      level: process.env.LOG_LEVEL ?? 'warn',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
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
