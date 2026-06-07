/** @oracle/bot — Telegram two-way bot for the punt-analysis pipeline.
 *  Zero-dep getUpdates long-poll loop. Reuses TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
 *
 *  Inbound: a bare SportyBet booking code OR `/punt <CODE>` → runPuntAnalysis → reply.
 *  Outbound: sendPuntPrompt() is called by the worker cron at 10:00/12:00/13:00.
 *
 *  The bot only acts on messages from the configured TELEGRAM_CHAT_ID (single power user). */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GBrainAdapter } from "@oracle/storage";
import {
  buildConfig,
  formatPuntResult,
  loadEnv,
  markFulfilled,
  runPuntAnalysis,
} from "@oracle/runtime";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const DB_PATH = join(ROOT, ".tmp/gbrain");

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

const env = loadEnv(join(ROOT, ".env"));
const TOKEN = env["TELEGRAM_BOT_TOKEN"];
const CHAT_ID = env["TELEGRAM_CHAT_ID"];

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

/** Send a Markdown message to the configured chat. Best-effort. */
async function sendMessage(text: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) return;
  try {
    await fetch(API(TOKEN, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch {
    /* best-effort */
  }
}

/** Push the daily "drop the code" prompt. Called by the worker cron. */
export async function sendPuntPrompt(): Promise<void> {
  await sendMessage(
    "🌌 *Universe, drop it here* 👇\nReply with today's SportyBet booking code (or `/punt <CODE>`) and ORACLE will counter-analyse every leg.",
  );
}

/** Extract a booking code from a message: bare code or `/punt <CODE>`. */
function extractCode(text: string): string | null {
  const t = text.trim();
  const cmd = t.match(/^\/punt(?:@\w+)?\s+([A-Za-z0-9]{4,16})$/i);
  if (cmd) return cmd[1] ?? null;
  if (/^[A-Za-z0-9]{4,16}$/.test(t)) return t;
  return null;
}

/** Process one inbound message: run the pipeline if it carries a code. */
async function handleMessage(text: string): Promise<void> {
  if (text.trim() === "/start" || text.trim() === "/help") {
    await sendMessage(
      "Send a SportyBet booking code (or `/punt <CODE>`). ORACLE keeps the fixtures, swaps weak picks, and returns a new code.",
    );
    return;
  }
  const code = extractCode(text);
  if (!code) return; // ignore non-code chatter

  await sendMessage(`⏳ Analysing \`${code}\` …`);
  const storage = new GBrainAdapter(DB_PATH);
  try {
    const config = buildConfig(env);
    const result = await runPuntAnalysis(code, { storage, config });
    if (result.oracleCode) markFulfilled(ROOT, code);
    await sendMessage(formatPuntResult(result));
  } catch (err) {
    await sendMessage(`⚠️ Punt analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await storage.close();
  }
}

/** Long-poll getUpdates loop. Resolves only on fatal error (never under normal operation). */
export async function runBot(): Promise<void> {
  if (!TOKEN || !CHAT_ID) {
    console.error("[oracle-bot] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — bot disabled.");
    return;
  }
  console.log("[oracle-bot] started — long-polling for booking codes.");
  let offset = 0;

  for (;;) {
    try {
      const url = `${API(TOKEN, "getUpdates")}?timeout=50&offset=${offset}`;
      const resp = await fetch(url);
      const data = (await resp.json()) as { ok: boolean; result?: TgUpdate[] };
      if (!data.ok || !data.result) continue;

      for (const upd of data.result) {
        offset = upd.update_id + 1;
        const msg = upd.message;
        if (!msg?.text) continue;
        if (String(msg.chat.id) !== String(CHAT_ID)) continue; // only the power user
        await handleMessage(msg.text);
      }
    } catch (err) {
      console.warn(`[oracle-bot] poll error (retrying): ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runBot().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
