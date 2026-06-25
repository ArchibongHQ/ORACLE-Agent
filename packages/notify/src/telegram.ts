/** Telegram push notifier — zero-dep (fetch to the Bot API, https.request fallback). */
import { request as httpsRequest } from "node:https";
import type { BatchSummary, Notifier } from "./types.js";
import { formatSummaryText } from "./types.js";

/** Minimal { ok, status, text() } shape so the notify() logic is transport-agnostic. */
interface SendResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export class TelegramNotifier implements Notifier {
  name = "telegram";
  constructor(
    private botToken: string,
    private chatId: string
  ) {}

  /** POST a JSON body to the Bot API. Tries undici `fetch` first; on a transport-level
   *  failure ("fetch failed" — thrown by fetch before any HTTP response, typically an
   *  undici DNS/TLS/IPv6 quirk that doesn't affect Node's OpenSSL https stack — seen in
   *  the Servy service context), falls back to node:https.request which uses a different
   *  network path. HTTP status errors (4xx/5xx) are NOT retried here — they return a
   *  response so the caller's Markdown-fallback logic still runs. */
  private async post(url: string, body: string): Promise<SendResponse> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      return { ok: res.ok, status: res.status, text: () => res.text() };
    } catch {
      // fetch threw (transport error, not an HTTP status) — retry via node:https.
      return this.postViaHttps(url, body);
    }
  }

  /** node:https.request fallback — bypasses undici entirely. */
  private postViaHttps(url: string, body: string): Promise<SendResponse> {
    return new Promise<SendResponse>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          timeout: 20_000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => {
            data += c;
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              text: () => Promise.resolve(data),
            });
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("https.request timed out")));
      req.write(body);
      req.end();
    });
  }

  async notify(summary: BatchSummary): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const text = formatSummaryText(summary);
    const send = (useMarkdown: boolean): Promise<SendResponse> =>
      this.post(
        url,
        JSON.stringify({
          chat_id: this.chatId,
          text,
          ...(useMarkdown ? { parse_mode: "Markdown" } : {}),
          disable_web_page_preview: true,
        })
      );
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
