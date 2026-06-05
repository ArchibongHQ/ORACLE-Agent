/** Telegram push notifier — zero-dep (fetch to the Bot API). */
import type { Notifier, BatchSummary } from './types.js';
import { formatSummaryText } from './types.js';

export class TelegramNotifier implements Notifier {
  name = 'telegram';
  constructor(private botToken: string, private chatId: string) {}

  async notify(summary: BatchSummary): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatSummaryText(summary),
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
  }
}
