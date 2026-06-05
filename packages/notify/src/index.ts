/** @oracle/notify — pluggable push delivery for ORACLE batch results.
 *  Channels are constructed only when their env vars are present, so an unconfigured
 *  channel is simply absent (never a runtime error). */
export type { Notifier, BatchSummary, ActionablePick } from './types.js';
export { summarizeBatch, formatSummaryText, formatSummaryHtml } from './types.js';
export { TelegramNotifier } from './telegram.js';
export { SlackNotifier } from './slack.js';
export { EmailNotifier } from './email.js';
export { OpenClawNotifier } from './openclaw.js';

import type { Notifier, BatchSummary } from './types.js';
import { TelegramNotifier } from './telegram.js';
import { SlackNotifier } from './slack.js';
import { EmailNotifier } from './email.js';
import { OpenClawNotifier } from './openclaw.js';

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

  if (env['TELEGRAM_BOT_TOKEN'] && env['TELEGRAM_CHAT_ID']) {
    notifiers.push(new TelegramNotifier(env['TELEGRAM_BOT_TOKEN'], env['TELEGRAM_CHAT_ID']));
  }
  if (env['SLACK_WEBHOOK_URL']) {
    notifiers.push(new SlackNotifier(env['SLACK_WEBHOOK_URL']));
  }
  if (env['MAIL_API_KEY'] && env['MAIL_FROM'] && env['MAIL_TO']) {
    notifiers.push(new EmailNotifier({
      apiKey: env['MAIL_API_KEY'],
      from: env['MAIL_FROM'],
      to: env['MAIL_TO'],
      ...(env['MAIL_ENDPOINT'] ? { endpoint: env['MAIL_ENDPOINT'] } : {}),
    }));
  }
  if (env['OPENCLAW_GATEWAY_URL'] && env['OPENCLAW_TOKEN']) {
    notifiers.push(new OpenClawNotifier({
      gatewayUrl: env['OPENCLAW_GATEWAY_URL'],
      token: env['OPENCLAW_TOKEN'],
      ...(env['OPENCLAW_AGENT_ID'] ? { agentId: env['OPENCLAW_AGENT_ID'] } : {}),
    }));
  }

  return notifiers;
}

/** Fire every notifier; a single channel failure is logged but never aborts the others. */
export async function notifyAll(notifiers: Notifier[], summary: BatchSummary): Promise<void> {
  await Promise.allSettled(
    notifiers.map(async n => {
      try {
        await n.notify(summary);
        console.log(`[notify] ${n.name} sent`);
      } catch (err) {
        console.warn(`[notify] ${n.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}
