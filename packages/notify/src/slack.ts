/** Slack push notifier — zero-dep (POST to an incoming webhook URL). */
import type { BatchSummary, Notifier } from "./types.js";
import { formatSummaryText } from "./types.js";

export class SlackNotifier implements Notifier {
  name = "slack";
  constructor(private webhookUrl: string) {}

  async notify(summary: BatchSummary): Promise<void> {
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: formatSummaryText(summary) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Slack webhook failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
      );
    }
  }
}
