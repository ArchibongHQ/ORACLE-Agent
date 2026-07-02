/** @oracle/notify — pluggable push delivery for ORACLE batch results.
 *  Channels are constructed only when their env vars are present, so an unconfigured
 *  channel is simply absent (never a runtime error). */

export { EmailNotifier } from "./email.js";
export { OpenClawNotifier } from "./openclaw.js";
export { SlackNotifier } from "./slack.js";
export { TelegramNotifier } from "./telegram.js";
export { sendTelegramDocument, sendTelegramText } from "./telegramDocument.js";
export type { ActionablePick, BatchSummary, Notifier } from "./types.js";
export {
  buildAnalysisModelNote,
  formatSummaryHtml,
  formatSummaryText,
  GOALS_V3_RG_NOTE,
  summarizeBatch,
} from "./types.js";

import { EmailNotifier } from "./email.js";
import { OpenClawNotifier } from "./openclaw.js";
import { SlackNotifier } from "./slack.js";
import { TelegramNotifier } from "./telegram.js";
import type { BatchSummary, Notifier } from "./types.js";

/** Build the set of notifiers configured in the given env record.
 *  Recognised keys:
 *    TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *    SLACK_WEBHOOK_URL
 *    MAIL_API_KEY + MAIL_FROM + MAIL_TO  (+ optional MAIL_ENDPOINT)
 *    OPENCLAW_GATEWAY_URL + OPENCLAW_TOKEN  (+ optional OPENCLAW_AGENT_ID)
 *
 *  A channel with missing/partial env is silently skipped. */
export function buildNotifiers(env: Record<string, string | undefined>): Notifier[] {
  const notifiers: Notifier[] = [];

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    notifiers.push(new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID));
  }
  if (env.SLACK_WEBHOOK_URL) {
    notifiers.push(new SlackNotifier(env.SLACK_WEBHOOK_URL));
  }
  if (env.MAIL_API_KEY && env.MAIL_FROM && env.MAIL_TO) {
    notifiers.push(
      new EmailNotifier({
        apiKey: env.MAIL_API_KEY,
        from: env.MAIL_FROM,
        to: env.MAIL_TO,
        ...(env.MAIL_ENDPOINT ? { endpoint: env.MAIL_ENDPOINT } : {}),
      })
    );
  }
  if (env.OPENCLAW_GATEWAY_URL && env.OPENCLAW_TOKEN) {
    notifiers.push(
      new OpenClawNotifier({
        gatewayUrl: env.OPENCLAW_GATEWAY_URL,
        token: env.OPENCLAW_TOKEN,
        ...(env.OPENCLAW_AGENT_ID ? { agentId: env.OPENCLAW_AGENT_ID } : {}),
      })
    );
  }

  return notifiers;
}

/** Fire every notifier; a single channel failure is logged but never aborts the others. */
export async function notifyAll(notifiers: Notifier[], summary: BatchSummary): Promise<void> {
  await Promise.allSettled(
    notifiers.map(async (n) => {
      try {
        await n.notify(summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[notify] ${n.name} failed: ${msg}\n`);
      }
    })
  );
}
