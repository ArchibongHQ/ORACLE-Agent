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
    const text = formatSummaryText(summary);
    const send = (useMarkdown: boolean): Promise<Response> =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          ...(useMarkdown ? { parse_mode: "Markdown" } : {}),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await send(true);
      if (res.ok) return;
      const errBody = await res.text().catch(() => "");
      // Telegram rejects malformed Markdown (an unbalanced _ * [ ` from dynamic
      // content like team names, error strings, or file paths) with HTTP 400
      // "can't parse entities". Resend once as plain text so the message — often
      // an operational alert we can't afford to drop — still gets through.
      if (res.status === 400 && /can't parse entities/i.test(errBody)) {
        const plain = await send(false);
        if (plain.ok) return;
        const pBody = await plain.text().catch(() => "");
        throw new Error(
          `Telegram sendMessage failed (plain-text retry): HTTP ${plain.status}${pBody ? ` — ${pBody.slice(0, 200)}` : ""}`
        );
      }
      if (attempt === 1) {
        throw new Error(
          `Telegram sendMessage failed: HTTP ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`
        );
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}
