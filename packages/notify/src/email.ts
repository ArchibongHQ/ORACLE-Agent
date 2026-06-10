/** Email push notifier — zero-dep via an HTTP mail API (Resend-style) rather than bundling SMTP.
 *  Default endpoint targets Resend (https://resend.com); override `endpoint` for a compatible API. */
import type { BatchSummary, Notifier } from "./types.js";
import { formatSummaryHtml } from "./types.js";

export interface EmailConfig {
  apiKey: string;
  from: string;
  to: string;
  endpoint?: string; // default: https://api.resend.com/emails
}

export class EmailNotifier implements Notifier {
  name = "email";
  private endpoint: string;
  constructor(private cfg: EmailConfig) {
    this.endpoint = cfg.endpoint ?? "https://api.resend.com/emails";
  }

  async notify(summary: BatchSummary): Promise<void> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        from: this.cfg.from,
        to: this.cfg.to,
        subject: `ORACLE ${summary.date} — ${summary.actionableCount} actionable`,
        html: formatSummaryHtml(summary),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Email API failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
      );
    }
  }
}
