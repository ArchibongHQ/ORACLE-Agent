/** @oracle/bot — Telegram bot for ORACLE with full admin + user command set.
 *
 *  ACL model:
 *    ADMIN — TELEGRAM_CHAT_ID (the owner, single power user)
 *    USER  — any TELEGRAM_USER_IDS entry (comma-separated chat IDs in .env)
 *
 *  ADMIN commands (full control):
 *    /run              Trigger the full daily analysis batch immediately
 *    /goals-run        Trigger the goals ACCA pipeline (scrape → funnel → 5 slips → Telegram)
 *    /resolve          Resolve yesterday's fixtures and compute CLV
 *    /scrape           Fire the SportyBet fixture scraper right now
 *    /kaggle           Trigger the weekly Kaggle dataset refresh on-demand
 *    /settings         Show active config flags (bankroll, features, API key status)
 *    /config KEY VALUE Write a key=value pair to .env and hot-reload config
 *    /errors           Show AgentErrors from the last batch manifest
 *    /cost             Show LLM/API cost + ceiling from the last batch
 *    /validate         Check which required API keys are missing
 *    /coverage         List CLV-eligible and priority leagues
 *    /lineups          Show lineup data freshness
 *
 *  USER + ADMIN commands (read / analysis):
 *    /today            Today's picks summary (fixture count, actionable picks, booking code)
 *    /goals            Goals ACCA status — slip leg counts, booking state, age of last run
 *    /yesterday        Yesterday's resolved fixtures + realised CLV
 *    /picks            Reprint today's actionable picks
 *    /report [date]    Send HTML report as a file (today or YYYY-MM-DD)
 *    /fixtures [date]  Send the raw scrape-fixtures report on demand (today or YYYY-MM-DD)
 *    /status           Worker heartbeat — last batch time, records, state
 *    /analyze <Home vs Away> [league]   Ad-hoc fixture analysis
 *    /punt <CODE>      Counter-analyse a SportyBet booking code
 *    <CODE>            Bare booking code — same as /punt <CODE>
 *    /help             List all commands available to you
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BatchSummary } from "@oracle/notify";
import { buildNotifiers, formatSummaryText, notifyAll, summarizeBatch } from "@oracle/notify";
import {
  buildConfig,
  CLV_ELIGIBLE_LEAGUES,
  fetchFixtureByName,
  fetchTodaysFixtures,
  formatPuntResult,
  generateAndWriteDailyFixtureReport,
  loadEnv,
  markFulfilled,
  ORACLE_PRIORITY_LEAGUES,
  resolveDay,
  resolvePythonBin,
  runAnalysis,
  runPuntAnalysis,
  validateConfig,
} from "@oracle/runtime";
import { GBrainAdapter } from "@oracle/storage";

// ── Human-in-loop gate (Phase 5 #1) ──────────────────────────────────────────
// When auto-booking is enabled, ORACLE must NOT place a live stake without
// explicit admin confirmation. A pending booking is stored here for 60 seconds;
// the admin must reply /confirm YES (or /confirm NO) to proceed or cancel.

interface PendingBooking {
  summary: BatchSummary;
  expiresAt: number;
}

const pendingBookings = new Map<string, PendingBooking>();

/** Store a pending booking for the given chatId. Expires after 60 s. */
function setPendingBooking(chatId: string, summary: BatchSummary): void {
  pendingBookings.set(chatId, { summary, expiresAt: Date.now() + 60_000 });
}

function popPendingBooking(chatId: string): BatchSummary | null {
  const entry = pendingBookings.get(chatId);
  pendingBookings.delete(chatId);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.summary;
}

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const DB_PATH = join(ROOT, ".tmp/gbrain");
const HEARTBEAT_FILE = join(ROOT, ".tmp", "worker_heartbeat.json");
const BOT_HEARTBEAT_FILE = join(ROOT, ".tmp", "bot_heartbeat.json");
const REPORTS_DIR = join(ROOT, ".tmp/reports");
const ENV_PATH = join(ROOT, ".env");

let env = loadEnv(ENV_PATH);

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

// Node's global fetch (undici) pools TLS connections and ignores a `Connection:
// close` request header (it's a forbidden header). On some networks a pooled
// socket is silently RST between requests, so every reused call fails with
// "fetch failed" — observed live as the bot's getUpdates poll dying on every
// request after the first. Routing Telegram calls through node:https with a
// keepAlive:false agent forces a genuinely fresh connection per request, which
// is the one shape that works here.
const NO_KEEPALIVE_AGENT = new https.Agent({ keepAlive: false });

/** Telegram API call on a fresh (non-pooled) HTTPS connection. Returns parsed JSON. */
function tgRequest(
  url: string,
  opts: { method?: string; body?: string; timeoutMs?: number } = {}
): Promise<unknown> {
  const { method = "GET", body, timeoutMs = 15_000 } = opts;
  return new Promise((resolve, reject) => {
    const req = https.request(
      new URL(url),
      {
        method,
        agent: NO_KEEPALIVE_AGENT,
        timeout: timeoutMs,
        headers: body
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    if (body) req.write(body);
    req.end();
  });
}

// ── ACL ───────────────────────────────────────────────────────────────────────

function getAdminId(): string {
  return env.TELEGRAM_CHAT_ID ?? "";
}

function getUserIds(): Set<string> {
  const raw = env.TELEGRAM_USER_IDS ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([getAdminId(), ...ids]);
}

function isAdmin(chatId: string): boolean {
  return chatId === getAdminId();
}

function isAllowed(chatId: string): boolean {
  return getUserIds().has(chatId);
}

// ── Telegram primitives ───────────────────────────────────────────────────────

const TOKEN = () => env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = () => getAdminId();

async function sendTo(chatId: string, text: string): Promise<void> {
  const token = TOKEN();
  if (!token) return;
  try {
    await tgRequest(API(token, "sendMessage"), {
      method: "POST",
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      timeoutMs: 10_000,
    });
  } catch {
    /* best-effort */
  }
}

async function sendMessage(text: string): Promise<void> {
  await sendTo(CHAT_ID(), text);
}

async function sendDocumentTo(chatId: string, filePath: string, caption: string): Promise<void> {
  const token = TOKEN();
  if (!token || !existsSync(filePath)) return;
  try {
    const form = new FormData();
    const blob = new Blob([readFileSync(filePath)], { type: "text/html" });
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("document", blob, filePath.split(/[\\/]/).pop() ?? "report.html");
    await fetch(API(token, "sendDocument"), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    /* best-effort */
  }
}

// ── Heartbeat helpers ─────────────────────────────────────────────────────────

interface HeartbeatEntry {
  at: string;
  trigger?: string;
  fixtures?: number;
  records?: number;
  halted?: boolean;
  date?: string;
  candidates?: number;
  resolved?: number;
}

function readHeartbeat(): Record<string, HeartbeatEntry> {
  try {
    return JSON.parse(readFileSync(HEARTBEAT_FILE, "utf8")) as Record<string, HeartbeatEntry>;
  } catch {
    return {};
  }
}

function latestManifest(): Record<string, unknown> | null {
  try {
    const files = readdirSync(join(ROOT, ".tmp/manifests"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    if (!files[0]) return null;
    return JSON.parse(readFileSync(join(ROOT, ".tmp/manifests", files[0]), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

// ── Worker process check ──────────────────────────────────────────────────────

function checkWorkerProcess(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-Command",
        "Get-Process node -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count",
      ],
      (err, stdout) => resolve(!err && parseInt(stdout.trim(), 10) > 0)
    );
  });
}

// ── Help text ─────────────────────────────────────────────────────────────────

function helpText(forAdmin: boolean): string {
  const user = [
    "*ORACLE — Available Commands*\n",
    "*Analysis & Picks*",
    "/today — Today's picks summary with fixture count, actionable picks, and booking code",
    "/goals — Today's goals ACCA slips (top picks, lottery, mini-ACCA, Output B/C)",
    "/picks — Reprint actionable picks from the most recent batch",
    "/yesterday — Yesterday's resolved fixtures and realised CLV scores",
    "/analyze _Home vs Away_ \\[league\\] — Run an ad-hoc analysis on any fixture right now",
    "/punt _CODE_ — Load a SportyBet slip, counter-analyse every leg, return an adjusted code",
    "",
    "*Reports & Status*",
    "/report \\[YYYY-MM-DD\\] — Receive the HTML analysis report as a file (defaults to today)",
    "/fixtures \\[YYYY-MM-DD\\] — Receive the raw scrape-fixtures report (odds, stats, news, full markets) — generates on demand if not already on disk",
    "/status — Worker heartbeat: last run time, records stored, goals ACCA state",
    "",
    "*Help*",
    "/help — Show this message",
  ];

  const admin = [
    "",
    "─────────────────────",
    "*Admin Commands*",
    "/run — Trigger the full daily analysis batch immediately",
    "/goals-run — Trigger the goals ACCA pipeline right now (scrape → funnel → slips → Telegram)",
    "/confirm YES|NO — Confirm or cancel a pending SportyBet booking (60 s window after /run)",
    "/scrape — Fire the SportyBet fixture scraper right now (pre-batch)",
    "/resolve — Resolve yesterday's fixtures and compute CLV",
    "/kaggle — Trigger the weekly Kaggle dataset refresh on-demand",
    "/settings — Show active config: bankroll, features on/off, API key status",
    "/config _KEY_ _VALUE_ — Write a .env key live (e.g. /config BANKROLL 2000)",
    "/errors — Show any AgentErrors from the last batch run",
    "/cost — Show LLM/API cost and ceiling from the last batch",
    "/validate — Check which required API keys are missing",
    "/coverage — List CLV-eligible and priority leagues",
    "/lineups — Show how fresh the lineup data is",
  ];

  return forAdmin ? [...user, ...admin].join("\n") : user.join("\n");
}

// ══════════════════════════════════════════════════════════════════════════════
// USER COMMANDS
// ══════════════════════════════════════════════════════════════════════════════

async function handleHelp(chatId: string): Promise<void> {
  await sendTo(chatId, helpText(isAdmin(chatId)));
}

async function handleStatus(chatId: string): Promise<void> {
  const hb = readHeartbeat();
  const batch = hb.lastBatch;
  const resolve = hb.lastResolve;
  const gb = hb.lastGoalsBatch as
    | { at?: string; topPicksLegs?: number; lotteryLegs?: number; miniAccaLegs?: number }
    | undefined;
  const lines: string[] = ["*ORACLE Status*\n"];

  if (batch) {
    const age = Math.round((Date.now() - new Date(batch.at).getTime()) / 60_000);
    lines.push(
      `📦 *Last batch:* ${batch.at.slice(0, 16).replace("T", " ")} UTC _(${age}m ago)_\n` +
        `   Trigger: ${String(batch.trigger ?? "?")} | Fixtures: ${String(batch.fixtures ?? "?")} | Records: ${String(batch.records ?? "?")}` +
        (batch.halted ? "\n   ⚠️ Cost cap halted batch early" : "")
    );
  } else {
    lines.push("📦 No batch recorded yet.");
  }

  if (gb?.at) {
    const gbAge = Math.round((Date.now() - new Date(gb.at).getTime()) / 60_000);
    lines.push(
      `\n⚽ *Last goals ACCA:* ${gb.at.slice(0, 16).replace("T", " ")} UTC _(${gbAge}m ago)_\n` +
        `   Top Picks: ${String(gb.topPicksLegs ?? 0)} | Lottery: ${String(gb.lotteryLegs ?? 0)} | Mini: ${String(gb.miniAccaLegs ?? 0)}`
    );
  } else {
    lines.push("\n⚽ No goals ACCA run recorded. Use /goals-run (admin) or wait for 09:40 WAT.");
  }

  if (resolve) {
    lines.push(
      `\n🔍 *Last resolve:* ${String(resolve.date ?? "?")}\n` +
        `   Candidates: ${String(resolve.candidates ?? "?")} | Resolved: ${String(resolve.resolved ?? "?")}`
    );
  }

  const workerRunning = await checkWorkerProcess();
  lines.push(
    `\n${workerRunning ? "🟢" : "🔴"} Worker daemon: ${workerRunning ? "running" : "stopped"}`
  );

  await sendTo(chatId, lines.join("\n"));
}

async function handleToday(chatId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const hb = readHeartbeat();
  const batch = hb.lastBatch;
  const batchDate = batch?.at?.slice(0, 10);

  if (batchDate !== today) {
    await sendTo(
      chatId,
      `ℹ️ No batch for today (${today}) yet.\nLast run: ${batchDate ?? "never"}.\n\n` +
        (isAdmin(chatId) ? "Use /run to trigger now." : "Check back after 09:00.")
    );
    return;
  }

  const reportPath = join(REPORTS_DIR, `oracle-${today}.html`);
  const hasReport = existsSync(reportPath);

  await sendTo(
    chatId,
    `📅 *Today (${today})*\n` +
      `Fixtures analysed: ${String(batch?.fixtures ?? "?")}\n` +
      `Records stored: ${String(batch?.records ?? "?")}\n` +
      (batch?.halted ? "⚠️ Cost cap halted batch early\n" : "") +
      (hasReport ? "\nUse /report to get the full HTML report." : "\nNo report file yet.")
  );
}

async function handleYesterday(chatId: string): Promise<void> {
  const hb = readHeartbeat();
  const resolve = hb.lastResolve;

  if (!resolve) {
    await sendTo(chatId, "ℹ️ No resolution data yet. Fixtures are resolved at 14:00 daily.");
    return;
  }

  const lines = [
    `🔍 *Yesterday's Results (${String(resolve.date ?? "?")})*`,
    `Candidates: ${String(resolve.candidates ?? "?")}`,
    `Resolved: ${String(resolve.resolved ?? "?")}`,
    `Unresolved: ${String((resolve.candidates ?? 0) - (resolve.resolved ?? 0))}`,
  ];

  await sendTo(chatId, lines.join("\n"));
}

async function handlePicks(chatId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const hb = readHeartbeat();
  const batch = hb.lastBatch;
  const batchDate = batch?.at?.slice(0, 10);

  if (batchDate !== today) {
    await sendTo(
      chatId,
      `ℹ️ Last batch was on ${batchDate ?? "unknown"}, not today.\n` +
        (isAdmin(chatId)
          ? "Use /run to trigger a fresh batch."
          : "Picks will be available after the 09:00 run.")
    );
    return;
  }

  await sendTo(
    chatId,
    `📋 *Picks — ${today}*\n` +
      `Fixtures: ${String(batch?.fixtures ?? "?")} | Records: ${String(batch?.records ?? "?")}\n\n` +
      "Use /report to download the full annotated HTML report."
  );
}

async function handleGoals(chatId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const hb = readHeartbeat();
  const gb = hb.lastGoalsBatch as
    | {
        at?: string;
        trigger?: string;
        analysed?: number;
        topPicksLegs?: number;
        lotteryLegs?: number;
        miniAccaLegs?: number;
        outputBLegs?: number;
        outputCLegs?: number;
        target?: number;
        topPicksBooked?: boolean;
        lotteryBooked?: boolean;
      }
    | undefined;

  if (!gb) {
    await sendTo(
      chatId,
      `ℹ️ No goals ACCA run recorded yet.\n` +
        (isAdmin(chatId)
          ? "Use /goals-run to trigger now (scrape → funnel → slips)."
          : "Goals slips are sent at 09:40 WAT daily.")
    );
    return;
  }

  const gbDate = gb.at?.slice(0, 10);
  const age = gb.at ? Math.round((Date.now() - new Date(gb.at).getTime()) / 60_000) : null;
  const isToday = gbDate === today;

  const lines = [
    `⚽ *Goals ACCA — ${gbDate ?? "?"}*${isToday ? " ✅ today" : " ⚠️ not today"}`,
    `Run: ${gb.trigger ?? "?"} | ${age !== null ? `${age}m ago` : ""}`,
    `Analysed: ${String(gb.analysed ?? "?")} fixtures`,
    ``,
    `*Slips*`,
    `🎯 Top Picks: ${String(gb.topPicksLegs ?? 0)} legs${gb.topPicksBooked ? " · booked ✅" : ""}`,
    `🎰 Lottery: ${String(gb.lotteryLegs ?? 0)}/${String(gb.target ?? 39)} legs${gb.lotteryBooked ? " · booked ✅" : ""}`,
    `🏆 Mini-ACCA: ${String(gb.miniAccaLegs ?? 0)} legs (cross-league)`,
    `💎 Output B (odds ≥4.0): ${String(gb.outputBLegs ?? 0)} legs`,
    `🔵 Output C (odds 2.5–4.0): ${String(gb.outputCLegs ?? 0)} legs`,
  ];

  if (!isToday) {
    lines.push(
      ``,
      isAdmin(chatId)
        ? `_Last run was ${gbDate ?? "unknown"}. Use /goals-run to trigger today's run._`
        : `_Goals slips fire daily at 09:40 WAT._`
    );
  }

  await sendTo(chatId, lines.join("\n"));
}

async function handleReport(chatId: string, dateArg?: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : today;
  const reportPath = join(REPORTS_DIR, `oracle-${date}.html`);

  if (existsSync(reportPath)) {
    await sendDocumentTo(chatId, reportPath, `ORACLE report — ${date}`);
    return;
  }

  // Fallback: most recent available
  try {
    const files = readdirSync(REPORTS_DIR)
      .filter((f) => f.startsWith("oracle-") && f.endsWith(".html"))
      .sort()
      .reverse();
    if (files[0]) {
      const fallbackDate = files[0].match(/oracle-(\d{4}-\d{2}-\d{2})\.html/)?.[1] ?? "unknown";
      await sendDocumentTo(
        chatId,
        join(REPORTS_DIR, files[0]),
        `ORACLE report — ${fallbackDate} (most recent; no report for ${date})`
      );
      return;
    }
  } catch {
    /* no reports dir */
  }

  await sendTo(
    chatId,
    `ℹ️ No reports found. ${isAdmin(chatId) ? "Use /run to generate one." : "Check back after the 09:00 batch."}`
  );
}

/** On-demand raw-fixture-data report (the scrape report, distinct from /report's
 *  engine-decision report) — fires immediately whenever asked, not just on the
 *  worker's 00:00/08:30 cron ticks. Generates it fresh from today's SportyBet
 *  sidecar when no file is already sitting on disk, so the request never comes
 *  back empty just because the cron tick hasn't fired yet. */
async function handleFixturesReport(chatId: string, dateArg?: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : today;
  const reportPath = join(REPORTS_DIR, `oracle-fixtures-${date}.html`);

  if (existsSync(reportPath)) {
    await sendDocumentTo(chatId, reportPath, `ORACLE daily fixtures — ${date}`);
    return;
  }

  await sendTo(chatId, `⏳ Generating fixtures report for ${date}…`);
  try {
    const result = await generateAndWriteDailyFixtureReport(date, REPORTS_DIR);
    if (!result) {
      await sendTo(chatId, `ℹ️ No SportyBet fixtures found for ${date}.`);
      return;
    }
    await sendDocumentTo(
      chatId,
      result.path,
      `ORACLE daily fixtures — ${date} (${result.fixtureCount} fixtures)`
    );
  } catch (err) {
    await sendTo(
      chatId,
      `⚠️ Fixtures report failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleAnalyze(chatId: string, query: string, league?: string): Promise<void> {
  const parts = query.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (!parts) {
    await sendTo(chatId, "⚠️ Format: `/analyze Home vs Away` or `/analyze Home vs Away, League`");
    return;
  }
  const home = parts[1]!.trim();
  const away = parts[2]!.trim();

  await sendTo(chatId, `⏳ Fetching odds for *${home} vs ${away}*…`);

  const config = buildConfig(env);
  const job = await fetchFixtureByName(home, away, config.oddsApiKey, league);

  if (!job) {
    await sendTo(
      chatId,
      `❌ Could not find live odds for *${home} vs ${away}*.\nTry adding a league hint: \`/analyze ${home} vs ${away}, Premier League\``
    );
    return;
  }

  await sendTo(chatId, `⚙️ Analysing *${home} vs ${away}*…`);
  const storage = new GBrainAdapter(DB_PATH);
  try {
    const { batch } = await runAnalysis([job], { storage, config }, { trigger: "manual" });
    const summary = summarizeBatch(batch);
    await sendTo(chatId, formatSummaryText(summary));
  } catch (err) {
    await sendTo(chatId, `⚠️ Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await storage.close();
  }
}

async function handlePunt(chatId: string, code: string): Promise<void> {
  await sendTo(chatId, `⏳ Analysing \`${code}\`…`);
  const storage = new GBrainAdapter(DB_PATH);
  try {
    const config = buildConfig(env);
    const result = await runPuntAnalysis(code, { storage, config });
    if (result.oracleCode) markFulfilled(ROOT, code);
    await sendTo(chatId, formatPuntResult(result));
  } catch (err) {
    await sendTo(
      chatId,
      `⚠️ Punt analysis failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    await storage.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN COMMANDS
// ══════════════════════════════════════════════════════════════════════════════

async function handleRun(chatId: string): Promise<void> {
  await sendTo(chatId, "⚙️ *Triggering daily batch…* This may take 1–3 minutes.");

  const storage = new GBrainAdapter(DB_PATH);
  const config = buildConfig(env);

  try {
    const newsKey = config.enableNewsIntel ? config.perplexityApiKey : undefined;
    const newsStorage = config.enableNewsIntel ? storage : undefined;
    const { jobs } = await fetchTodaysFixtures(
      config.oddsApiKey,
      config.enableWebSearchOddsFallback,
      config.geminiApiKey,
      config.footballDataApiKey,
      newsKey,
      config.sharpApiIoKey,
      config.apiFootballKey,
      config.oddsApiIoKey,
      config.oddsPapiKey,
      config.sportsGameOddsKey,
      config.maxFixturesPerRun,
      newsStorage,
      config.webOddsMinConsensus,
      config.webOddsVarianceThreshold
    );

    if (!jobs.length) {
      await sendTo(chatId, "ℹ️ No fixtures found for today.");
      await storage.close();
      return;
    }

    const { batch } = await runAnalysis(jobs, { storage, config }, { trigger: "manual" });

    const summary = summarizeBatch(batch);

    await sendTo(chatId, formatSummaryText(summary));

    const notifiers = buildNotifiers(env);
    if (notifiers.length) await notifyAll(notifiers, summary);

    // Phase 5 #1 — Human-in-loop gate before irreversible stake placement.
    // Do NOT auto-book. Instead, ask for explicit confirmation within 60 s.
    if (env.ENABLE_SPORTYBET_BOOKING === "true" && summary.actionable.length > 0) {
      setPendingBooking(chatId, summary);
      await sendTo(
        chatId,
        `⚠️ *Booking pending — irreversible action*\n` +
          `${summary.actionable.length} pick(s) ready to book on SportyBet.\n\n` +
          `Reply within 60 s:\n` +
          `• \`/confirm YES\` — place the accumulator now\n` +
          `• \`/confirm NO\` — cancel (no booking made)`
      );
    }
  } catch (err) {
    await sendTo(chatId, `⚠️ Batch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await storage.close();
  }
}

async function handleGoalsRun(chatId: string): Promise<void> {
  await sendTo(
    chatId,
    "⚽ *Triggering goals ACCA run…*\nScrape → funnel → 5 slips → Telegram. Takes 2–5 min."
  );
  const workerDist = join(ROOT, "apps", "worker", "dist", "index.js");
  // --max-old-space-size=2048: this box SIGKILLs the default-heap goals run mid-funnel
  // (Windows OOM — see oracle_turbo_oom_windows memory). The funnel loads the full
  // SportyBet pool + per-fixture analysis; a 2 GB old-space cap lets V8 GC under
  // pressure instead of the process being killed before reaching slip dispatch.
  execFile(
    process.execPath,
    ["--max-old-space-size=2048", workerDist, "--run-goals-now"],
    { cwd: ROOT },
    async (err) => {
      if (err) {
        await sendTo(
          chatId,
          `⚠️ Goals run failed: \`${err.message.slice(0, 300)}\`\nCheck worker logs.`
        );
      } else {
        await sendTo(
          chatId,
          "✅ Goals ACCA run complete — slips sent to Telegram. Use /goals for the summary."
        );
      }
    }
  );
}

async function handleScrape(chatId: string): Promise<void> {
  await sendTo(chatId, "🔍 Scraping SportyBet fixtures…");
  const python = resolvePythonBin();
  const script = join(ROOT, "tools", "scrape_fixtures.py");

  execFile(python, [script], { cwd: ROOT }, async (err, stdout, stderr) => {
    const summary = stdout.match(/\[scrape\] .+/g)?.join("\n") ?? stdout.slice(0, 400);
    if (err) {
      await sendTo(chatId, `⚠️ Scrape error:\n\`\`\`\n${err.message}\n\`\`\``);
    } else {
      await sendTo(
        chatId,
        `✅ Scrape complete:\n\`\`\`\n${summary || stderr.slice(0, 300)}\n\`\`\``
      );
    }
  });
}

async function handleConfirm(chatId: string, answer: string): Promise<void> {
  const summary = popPendingBooking(chatId);
  if (!summary) {
    await sendTo(
      chatId,
      "ℹ️ No pending booking (expired or already processed). Run /run again to start a new batch."
    );
    return;
  }
  if (answer.toUpperCase() !== "YES") {
    await sendTo(chatId, "✅ Booking cancelled — no stake placed.");
    return;
  }
  await sendTo(chatId, "⏳ Placing accumulator on SportyBet…");
  try {
    const { bookAccumulator } = await import("@oracle/booking");
    const booking = await bookAccumulator(summary.actionable);
    if (booking.code) {
      summary.bookingCode = booking.code;
      summary.bookingLoadUrl = booking.loadUrl ?? undefined;
      summary.bookingUnmatched = booking.unmatched;
      await sendTo(
        chatId,
        `✅ *Booked* — code: \`${booking.code}\`\n` +
          (booking.loadUrl ? `Load: ${booking.loadUrl}` : "") +
          (booking.unmatched?.length ? `\n⚠️ ${booking.unmatched.length} leg(s) unmatched` : "")
      );
    } else {
      await sendTo(chatId, `⚠️ Booking failed: ${booking.error ?? "no code returned"}`);
    }
  } catch (err) {
    await sendTo(chatId, `⚠️ Booking failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleResolve(chatId: string): Promise<void> {
  const config = buildConfig(env);
  if (!config.footballDataApiKey) {
    await sendTo(chatId, "❌ FOOTBALL_DATA_API_KEY not set — cannot resolve fixtures.");
    return;
  }

  await sendTo(chatId, "🔍 Resolving yesterday's fixtures…");
  const storage = new GBrainAdapter(DB_PATH);
  try {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const { candidates, resolved, unmatched } = await resolveDay(
      storage,
      {
        footballDataApiKey: config.footballDataApiKey,
        oddsApiKey: config.oddsApiKey,
        geminiApiKey: config.geminiApiKey,
      },
      yesterday
    );
    await sendTo(
      chatId,
      `✅ *Resolved — ${yesterday}*\n` +
        `Candidates: ${String(candidates ?? 0)}\n` +
        `Resolved: ${resolved.length}\n` +
        `Unmatched: ${unmatched.length}`
    );
  } catch (err) {
    await sendTo(chatId, `⚠️ Resolve failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await storage.close();
  }
}

async function handleKaggle(chatId: string): Promise<void> {
  await sendTo(
    chatId,
    "📦 Triggering Kaggle refresh… (runs in background, may take several minutes)"
  );
  const python = resolvePythonBin();
  const scripts = [
    [
      "fetch_odds_timeseries.py",
      ["--btb-dir", ".tmp/kaggle/beat-the-bookie", "--ah-dir", ".tmp/kaggle/ah-odds"],
    ],
    ["fetch_spi.py", []],
    ["fetch_fbref.py", []],
    ["fetch_transfermarkt.py", ["--player-scores-dir", ".tmp/kaggle/player-scores"]],
    ["fetch_xg.py", ["--kaggle-ppda-dir", ".tmp/kaggle/xg-ppda"]],
  ] as const;

  const total = scripts.length;
  let completed = 0;

  await Promise.all(
    scripts.map(
      ([script, args]) =>
        new Promise<void>((resolve) => {
          execFile(python, [join(ROOT, "tools", script), ...args], { cwd: ROOT }, async (err) => {
            completed++;
            if (err) {
              await sendTo(chatId, `⚠️ ${script}: ${err.message}`);
            } else {
              await sendTo(chatId, `✅ ${script} (${completed}/${total})`);
            }
            resolve();
          });
        })
    )
  );

  await sendTo(chatId, "✅ Kaggle refresh complete.");
}

async function handleSettings(chatId: string): Promise<void> {
  const config = buildConfig(env);
  const keyStatus = (val: string | undefined, name: string) =>
    val ? `✅ ${name}` : `❌ ${name} (missing)`;

  const lines = [
    "*ORACLE Settings*\n",
    "*Financial*",
    `Bankroll: £${config.bankroll}`,
    `Ranking mode: ${config.rankingMode ?? "CONFIDENCE_WEIGHTED"}`,
    `Max fixtures/run: ${String(config.maxFixturesPerRun ?? 50)}`,
    `Batch concurrency: ${String(config.batchConcurrency ?? 8)}`,
    "",
    "*Feature Flags*",
    `News intel (T0): ${config.enableNewsIntel ? "✅ on" : "❌ off"}`,
    `Swarm agents: ${config.enableSwarm ? "✅ on" : "❌ off"}`,
    `SportyBet booking: ${env.ENABLE_SPORTYBET_BOOKING === "true" ? "✅ on" : "❌ off"}`,
    `Web search fallback: ${config.enableWebSearchOddsFallback !== false ? "✅ on" : "❌ off"}`,
    `Auto-research: ${config.enableAutoResearch ? "✅ on" : "❌ off"}`,
    "",
    "*API Keys*",
    keyStatus(config.claudeApiKey, "Claude"),
    keyStatus(config.geminiApiKey, "Gemini"),
    keyStatus(config.oddsApiKey, "Odds API"),
    keyStatus(config.footballDataApiKey, "Football-Data"),
    keyStatus(config.apiFootballKey, "API-Football"),
    keyStatus(config.openrouterApiKey, "OpenRouter"),
    keyStatus(config.perplexityApiKey, "Perplexity (news intel)"),
    keyStatus(config.sharpApiIoKey, "SharpAPI.io"),
    keyStatus(config.oddsApiIoKey, "Odds-API.io"),
    keyStatus(config.sportsGameOddsKey, "SportsGameOdds"),
  ];

  await sendTo(chatId, lines.join("\n"));
}

async function handleConfigSet(chatId: string, key: string, value: string): Promise<void> {
  // Safety: only allow known .env keys to be written
  const ALLOWED_KEYS = new Set([
    "BANKROLL",
    "BATCH_CONCURRENCY",
    "MAX_FIXTURES_PER_RUN",
    "ENABLE_SPORTYBET_BOOKING",
    "ENABLE_NEWS_INTEL",
    "ENABLE_SWARM",
    "ENABLE_WEB_SEARCH_FALLBACK",
    "WEB_ODDS_MIN_CONSENSUS",
    "WEB_ODDS_VARIANCE_THRESHOLD",
    "ORACLE_AUTORESEARCH_ENABLED",
  ]);

  if (!ALLOWED_KEYS.has(key.toUpperCase())) {
    await sendTo(
      chatId,
      `❌ \`${key}\` is not a writable setting.\n\nWritable keys:\n${[...ALLOWED_KEYS].map((k) => `• \`${k}\``).join("\n")}`
    );
    return;
  }

  // Guard value content: allow digits, letters, dots, underscores, plus, minus only.
  // This prevents newline injection and dotenv-structure corruption.
  if (!/^[\w.+-]{1,256}$/.test(value)) {
    await sendTo(
      chatId,
      "❌ Value contains invalid characters. Only alphanumeric, `.`, `+`, `-`, `_` allowed (max 256 chars)."
    );
    return;
  }

  const k = key.toUpperCase();
  try {
    let contents = readFileSync(ENV_PATH, "utf8");
    const lineRegex = new RegExp(`^(#\\s*)?${k}=.*$`, "m");
    if (lineRegex.test(contents)) {
      contents = contents.replace(lineRegex, `${k}=${value}`);
    } else {
      contents = `${contents.trimEnd()}\n${k}=${value}\n`;
    }
    writeFileSync(ENV_PATH, contents, "utf8");
    // Hot-reload
    env = loadEnv(ENV_PATH);
    await sendTo(chatId, `✅ \`${k}\` set to \`${value}\` and reloaded.`);
  } catch (err) {
    await sendTo(
      chatId,
      `⚠️ Failed to write .env: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleErrors(chatId: string): Promise<void> {
  const manifest = latestManifest();
  if (!manifest) {
    await sendTo(chatId, "ℹ️ No manifest found — run /run to generate one.");
    return;
  }

  const errors = manifest.errors as
    | Array<{ code: string; message: string; fixtureId?: string }>
    | undefined;

  if (!errors?.length) {
    await sendTo(chatId, `✅ *No errors* in last batch (${String(manifest.runId ?? "?")}).`);
    return;
  }

  const lines = [`⚠️ *Errors — last batch*\n`];
  for (const e of errors.slice(0, 10)) {
    lines.push(`• \`${e.code}\`${e.fixtureId ? ` (${e.fixtureId})` : ""}: ${e.message}`);
  }
  if (errors.length > 10) lines.push(`…and ${errors.length - 10} more.`);

  await sendTo(chatId, lines.join("\n"));
}

async function handleCost(chatId: string): Promise<void> {
  const manifest = latestManifest();
  if (!manifest) {
    await sendTo(chatId, "ℹ️ No manifest found — run /run to generate one.");
    return;
  }

  const cost = manifest.cost as
    | { estimatedUsd: number | null; ceilingUsd: number | null; halted: boolean }
    | undefined;
  const totals = manifest.totals as
    | { analysed: number; actionable: number; errors: number }
    | undefined;

  const lines = [
    `💰 *Cost — ${String(manifest.runId ?? "last batch")}*`,
    `Estimated: ${cost?.estimatedUsd != null ? `$${cost.estimatedUsd.toFixed(4)}` : "unknown"}`,
    `Ceiling: ${cost?.ceilingUsd != null ? `$${cost.ceilingUsd}` : "none set"}`,
    `Halted by cap: ${cost?.halted ? "⚠️ Yes" : "No"}`,
    "",
    `Analysed: ${String(totals?.analysed ?? "?")} | Actionable: ${String(totals?.actionable ?? "?")} | Errors: ${String(totals?.errors ?? "?")}`,
  ];

  await sendTo(chatId, lines.join("\n"));
}

async function handleValidate(chatId: string): Promise<void> {
  const config = buildConfig(env);
  const errors = validateConfig(config);

  if (!errors.length) {
    await sendTo(chatId, "✅ All required API keys are present.");
    return;
  }

  const lines = [`⚠️ *Missing API keys (${errors.length})*\n`];
  for (const e of errors) {
    lines.push(`• ${e.message}`);
  }
  await sendTo(chatId, lines.join("\n"));
}

async function handleCoverage(chatId: string): Promise<void> {
  const clv = [...CLV_ELIGIBLE_LEAGUES].sort();
  const priority = [...ORACLE_PRIORITY_LEAGUES].filter((l) => !CLV_ELIGIBLE_LEAGUES.has(l)).sort();

  const lines = [
    "*League Coverage*\n",
    "*CLV-Eligible* _(full closing-odds tracking)_",
    ...clv.map((l) => `• ${l}`),
    "",
    "*Priority* _(analysed + picked, no CLV)_",
    ...priority.map((l) => `• ${l}`),
  ];

  await sendTo(chatId, lines.join("\n"));
}

async function handleLineups(chatId: string): Promise<void> {
  const lineupsPath = join(ROOT, ".tmp/oracle-store/oracle_lineups.json");
  if (!existsSync(lineupsPath)) {
    await sendTo(
      chatId,
      "❌ No lineup data found.\nLineups are fetched before the 09:00 batch via `fetch_lineups.py`.\nRequires `API_FOOTBALL_KEY`."
    );
    return;
  }

  try {
    const raw = JSON.parse(readFileSync(lineupsPath, "utf8")) as Record<
      string,
      { fetchedAt?: string }
    >;
    const count = Object.keys(raw).length;
    const sample = Object.values(raw)[0];
    const fetchedAt = sample?.fetchedAt ?? "unknown";
    const age =
      fetchedAt !== "unknown"
        ? `${Math.round((Date.now() - new Date(fetchedAt).getTime()) / 60_000)}m ago`
        : "unknown";

    await sendTo(
      chatId,
      `📋 *Lineup Data*\nFixtures with lineups: ${count}\nFetched: ${fetchedAt.slice(0, 16).replace("T", " ")} UTC _(${age})_`
    );
  } catch {
    await sendTo(chatId, "⚠️ Could not read lineup data.");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════════════════════════════════════

/** Extract a bare booking code from a message. */
function extractCode(text: string): string | null {
  const t = text.trim();
  const cmd = t.match(/^\/punt(?:@\w+)?\s+([A-Za-z0-9]{4,16})$/i);
  if (cmd) return cmd[1] ?? null;
  if (/^[A-Za-z0-9]{4,16}$/.test(t)) return t;
  return null;
}

async function handleMessage(chatId: string, text: string): Promise<void> {
  const t = text.trim();
  const parts = t.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase().replace(/@\w+$/, "");
  const args = parts.slice(1);

  // ── Access control ─────────────────────────────────────────────────────────
  if (!isAllowed(chatId)) {
    await sendTo(chatId, "⛔ You are not authorised to use ORACLE.");
    return;
  }

  // ── User commands (admin + user) ───────────────────────────────────────────
  if (cmd === "/start" || cmd === "/help") return handleHelp(chatId);
  if (cmd === "/status") return handleStatus(chatId);
  if (cmd === "/today") return handleToday(chatId);
  if (cmd === "/yesterday") return handleYesterday(chatId);
  if (cmd === "/picks") return handlePicks(chatId);
  if (cmd === "/goals") return handleGoals(chatId);

  if (cmd === "/report") {
    return handleReport(chatId, args[0]);
  }

  if (cmd === "/fixtures") {
    return handleFixturesReport(chatId, args[0]);
  }

  if (cmd === "/analyze" || cmd === "/analyse") {
    const query = args.join(" ");
    // Support "Home vs Away, League" syntax
    const commaIdx = query.indexOf(",");
    const fixture = commaIdx >= 0 ? query.slice(0, commaIdx).trim() : query.trim();
    const league = commaIdx >= 0 ? query.slice(commaIdx + 1).trim() : undefined;
    if (!fixture) {
      await sendTo(chatId, "⚠️ Usage: `/analyze Home vs Away` or `/analyze Home vs Away, League`");
      return;
    }
    return handleAnalyze(chatId, fixture, league);
  }

  if (cmd === "/punt") {
    const code = extractCode(t);
    if (!code) {
      await sendTo(chatId, "⚠️ Usage: `/punt BOOKINGCODE`");
      return;
    }
    return handlePunt(chatId, code);
  }

  // Bare booking code
  const bareCode = extractCode(t);
  if (bareCode) return handlePunt(chatId, bareCode);

  // ── Admin-only commands ────────────────────────────────────────────────────
  if (!isAdmin(chatId)) {
    if (t.startsWith("/")) {
      await sendTo(chatId, "⛔ That command is admin-only. Use /help to see available commands.");
    }
    return;
  }

  if (cmd === "/run") return handleRun(chatId);
  if (cmd === "/goals-run") return handleGoalsRun(chatId);
  if (cmd === "/confirm") {
    const answer = args[0] ?? "";
    return handleConfirm(chatId, answer);
  }
  if (cmd === "/scrape") return handleScrape(chatId);
  if (cmd === "/resolve") return handleResolve(chatId);
  if (cmd === "/kaggle") return handleKaggle(chatId);
  if (cmd === "/settings") return handleSettings(chatId);
  if (cmd === "/errors") return handleErrors(chatId);
  if (cmd === "/cost") return handleCost(chatId);
  if (cmd === "/validate") return handleValidate(chatId);
  if (cmd === "/coverage") return handleCoverage(chatId);
  if (cmd === "/lineups") return handleLineups(chatId);

  if (cmd === "/config") {
    const key = args[0];
    const value = args
      .slice(1)
      .join(" ")
      .replace(/[\r\n]/g, " ")
      .trim();
    if (!key || !value) {
      await sendTo(chatId, "⚠️ Usage: `/config KEY value`");
      return;
    }
    return handleConfigSet(chatId, key, value);
  }

  // Unknown slash command
  if (t.startsWith("/")) return handleHelp(chatId);
}

// ══════════════════════════════════════════════════════════════════════════════
// Public outbound helpers (called by worker cron)
// ══════════════════════════════════════════════════════════════════════════════

export async function sendPuntPrompt(): Promise<void> {
  await sendMessage(
    "🌌 *Universe, drop it here* 👇\n" +
      "Reply with today's SportyBet booking code (or `/punt <CODE>`) and ORACLE will counter-analyse every leg."
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Long-poll loop
// ══════════════════════════════════════════════════════════════════════════════

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

/** Liveness signal for external monitoring (the worker's checkBotHeartbeatFreshness
 *  reads this). Written after each successfully-completed poll cycle — not on every
 *  loop tick, so a real "can't reach Telegram" gap stays visible rather than masked
 *  by a process that's merely still running. Best-effort; a write failure must
 *  never interrupt the poll loop itself. */
function writeBotHeartbeat(): void {
  try {
    writeFileSync(BOT_HEARTBEAT_FILE, JSON.stringify({ at: new Date().toISOString() }), "utf8");
  } catch {
    /* best-effort */
  }
}

export async function runBot(): Promise<void> {
  const token = TOKEN();
  const adminId = CHAT_ID();
  if (!token || !adminId) {
    return;
  }
  let offset = 0;

  // While a command is being processed the poll loop is blocked (single-threaded),
  // so the per-poll heartbeat above goes stale and the worker's 10-min freshness
  // check fires a false "bot offline" alert. Stamp the heartbeat on a timer while
  // (and only while) a command is in flight — the bot is alive, just busy. When
  // idle, this does nothing, so a genuine "can't reach Telegram" gap still shows.
  let busyProcessing = false;
  const busyHeartbeat = setInterval(() => {
    if (busyProcessing) writeBotHeartbeat();
  }, 60_000);
  busyHeartbeat.unref?.();

  for (;;) {
    try {
      // Pure short-polling (timeout=0 → Telegram returns immediately) over
      // tgRequest, which uses a fresh non-pooled HTTPS connection per call. On
      // this network a held long-poll AND a reused keep-alive socket both get
      // silently RST — observed live as the first poll after start succeeding
      // while every reused poll failed with "fetch failed". An instant return
      // on a fresh connection is the one shape that works here; the 2s pace
      // below keeps update latency low without hammering the API.
      const url = `${API(token, "getUpdates")}?timeout=0&offset=${offset}`;
      const data = (await tgRequest(url, { timeoutMs: 15_000 })) as {
        ok: boolean;
        result?: TgUpdate[];
      };
      writeBotHeartbeat(); // reached and parsed a response from Telegram — the loop is alive
      if (data.ok && data.result) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          const msg = upd.message;
          if (!msg?.text) continue;
          busyProcessing = true;
          try {
            await handleMessage(String(msg.chat.id), msg.text);
          } finally {
            busyProcessing = false;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 2_000));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[oracle-bot] poll error (retrying): ${msg}\n`);
      await new Promise((r) => setTimeout(r, 3_000));
      // Write heartbeat after the backoff so a transient network blip doesn't
      // stale the worker's 10-min freshness check and fire a false alert.
      writeBotHeartbeat();
    }
  }
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runBot().catch((_e) => {
    process.exit(1);
  });
}
