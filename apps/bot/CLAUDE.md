# @oracle/bot

Telegram bot providing full admin + user command interface to ORACLE (trigger batches, resolve days, scrape, config, punt/booking-code analysis, status).

- **Entry point:** `src/index.ts` (single file implementing all commands).
- **Exports:** Package `exports`/`main` point at `dist/index.js` — importable by `apps/worker` (e.g. `sendPuntPrompt`).
- **Dev commands:** `pnpm --filter @oracle/bot start` → `dist/index.js` (256MB heap cap).

**Gotcha:** Two-tier ACL model — `ADMIN` = `TELEGRAM_CHAT_ID` (owner), `USER` = `TELEGRAM_USER_IDS` list. `/config KEY VALUE` writes directly to `.env` and hot-reloads config — be careful with that command's blast radius.
