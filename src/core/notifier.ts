import { SETTINGS } from '../config/runtimeSettings';
import logger from '../utils/logger';

type NotifyProvider = 'telegram' | 'webhook' | 'none';

function isEnabled(): boolean {
  return SETTINGS.NOTIFICATIONS_ENABLED;
}

function getProvider(): NotifyProvider {
  const value = (SETTINGS.NOTIFY_PROVIDER ?? 'none').toLowerCase();
  if (value === 'telegram' || value === 'webhook' || value === 'none') return value;
  return 'none';
}

async function sendTelegram(text: string): Promise<void> {
  const token = SETTINGS.TELEGRAM_BOT_TOKEN;
  const chatId = SETTINGS.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    logger.warn('Notifications enabled but Telegram token/chat id is missing');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram send failed: ${res.status} ${res.statusText} ${body}`);
  }
}

async function sendWebhook(text: string, payload?: Record<string, unknown>): Promise<void> {
  const url = SETTINGS.NOTIFY_WEBHOOK_URL;
  if (!url) {
    logger.warn('Notifications enabled but NOTIFY_WEBHOOK_URL is missing');
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: text,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webhook send failed: ${res.status} ${res.statusText} ${body}`);
  }
}

export async function notifyPhone(text: string, payload?: Record<string, unknown>): Promise<void> {
  if (!isEnabled()) return;

  const provider = getProvider();
  if (provider === 'none') return;

  try {
    if (provider === 'telegram') {
      await sendTelegram(text);
      return;
    }

    if (provider === 'webhook') {
      await sendWebhook(text, payload);
      return;
    }
  } catch (err) {
    logger.error('Failed to send phone notification', {
      err,
      provider,
      text,
    });
  }
}
