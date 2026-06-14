/** Telegram push notifier — zero-dep (fetch to the Bot API). */
import type { BatchSummary, Notifier } from "./types.js";
import { formatSummaryText } from "./types.js";

export class TelegramNotifier implements Notifier {
  name = "telegram";
  constructor(
    private botToken: string,
    private chatId: string
  ) {}

  async notify(summary: BatchSummary): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: formatSummaryText(summary),
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return;
      const text = await res.text().catch(() => "");
      if (attempt === 1) {
        throw new Error(
          `Telegram sendMessage failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
        );
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}
