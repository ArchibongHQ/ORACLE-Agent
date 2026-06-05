# SOP: ORACLE Integrations (push notifications)

## Objective

Deliver each batch's **actionable picks** to external channels. Implemented in `@oracle/notify`
as a pluggable `Notifier` interface; channels activate only when their env vars are present.

## Channels & env (.env)

| Channel | Required env | Notes |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | POST to Bot API `sendMessage` (Markdown) |
| Slack | `SLACK_WEBHOOK_URL` | POST to an incoming webhook |
| Email | `MAIL_API_KEY`, `MAIL_FROM`, `MAIL_TO` (+ optional `MAIL_ENDPOINT`) | HTTP mail API, Resend-style (zero-dep, no SMTP) |
| OpenClaw | `OPENCLAW_GATEWAY_URL`, `OPENCLAW_TOKEN` (+ optional `OPENCLAW_AGENT_ID`) | POST to local OpenClaw agent gateway — routes via any of its configured channels |

A channel with missing/partial env is silently skipped (never an error).

## What is OpenClaw?

[OpenClaw](https://openclaw.ai) is a free, open-source personal AI agent that runs locally and connects LLMs (Claude, GPT, DeepSeek) to real software. It ships a **Gateway HTTP API** that accepts messages from external apps, then routes them via any channel the user has configured: Telegram, Discord, Slack, iMessage, WhatsApp, Matrix, and more.

The [ClawHub marketplace](https://clawhub.ai) already has a **Football Value Bets skill** (`machina-sports/sports-skills`) — ORACLE's picks feed naturally into that ecosystem.

**Gateway API used:** `POST {OPENCLAW_GATEWAY_URL}/v1/responses`
(docs: <https://docs.openclaw.ai/gateway/openresponses-http-api>)

**Setup:**

1. Install and start OpenClaw locally
2. Note your gateway URL (default: `http://127.0.0.1:18789`) and Bearer token from its config
3. Add to `.env`:

```env
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_TOKEN=<your-gateway-token>
OPENCLAW_AGENT_ID=main
```

## Wiring

The worker calls `buildNotifiers(env)` + `notifyAll(notifiers, summarizeBatch(batch))` after each
daily batch (`apps/worker/src/index.ts`). `notifyAll` uses `Promise.allSettled` — one channel
failing never blocks the others or the batch.

## Test locally

```bash
# Set the env vars you want, then trigger a batch:
pnpm --filter @oracle/worker start:now
# Unset env → that channel is a no-op (asserted in packages/notify/test/notify.test.ts)
```

## Message format

- Chat (Telegram/Slack/OpenClaw): header line + one bullet per actionable pick (market, odds, Kelly %, confidence)
- Email: HTML table of picks

Both rendered via `formatSummaryText` / `formatSummaryHtml` in `@oracle/notify`.

## Follow-ups (not yet built)

- **Two-way Telegram bot** (`apps/bot`): a `getUpdates` long-poll loop accepting `/analyze Home vs Away` → `fetchFixtureByName` + `runAnalysis` → reply with the summary + web report link. Zero-dep (fetch).
- **Slack slash command**: needs the web server publicly reachable (Phase 2 is localhost-only).
