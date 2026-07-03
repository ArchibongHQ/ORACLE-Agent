# @oracle/notify

Pluggable outbound notification/delivery layer for batch results — Email, Slack, Telegram, and a custom "OpenClaw" channel.

- **Entry point:** `src/index.ts` (`buildNotifiers` factory + re-exports).
- **Key exports:** `EmailNotifier`, `SlackNotifier`, `TelegramNotifier`, `OpenClawNotifier`, `sendTelegramText`/`sendTelegramDocument`, `summarizeBatch`, `formatSummaryHtml`/`formatSummaryText`, types `ActionablePick`/`BatchSummary`/`Notifier`. Consumed by `apps/worker`, `apps/bot`, `apps/booking`.

**Gotcha:** Channels are constructed only when their env vars are present, so an unconfigured channel is simply absent — never a runtime error. Follow this pattern when adding a new channel.
