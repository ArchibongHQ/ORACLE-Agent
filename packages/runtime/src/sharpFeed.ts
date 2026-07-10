/** [Wave-2 W2-S, owner WS2-C] Sharp-reference odds feed (P1-4). Odds API
 *  primary + Playwright/Google-AI-Mode fallback; devig via markets/devig.ts;
 *  persists {pick_odds, sharp_fair_at_pick, sharp_fair_at_close} per pick so
 *  CLV becomes a headline ledger metric. Un-zero-weight criterion for
 *  ConvergenceScorer's S02-S05 (OracleConfig.sharpFeedVerified): ≥95% pick
 *  coverage over 7 consecutive slates — checked and flipped manually, never
 *  auto-enabled.
 *
 *  Recon note on the plan's "dormant sharp_consensus plumbing": packages/
 *  engine/src/safety/index.ts and execution/index.ts DO read
 *  resData.frozenOdds.sharp_consensus / rawOddsPay.sharp_consensus — but
 *  nothing in the codebase (as of Wave 2) ever WRITES that key into an odds
 *  payload; the only places `sharp_consensus` appears are those two readers
 *  and their test fixtures, which construct it by hand. There is no existing
 *  producer to wire into — this module (fetchSharpFairPrice) IS the producer
 *  this workstream builds, not a rewire of something that already worked.
 *  Wiring fetchSharpFairPrice's output into execution/index.ts's rawOddsPay
 *  shape is out of scope here (that file is owned by a different concurrent
 *  workstream) — this module instead persists sharp prices independently via
 *  SharpOddsRecord, consumed by resolveFixtures.ts for a second, genuinely
 *  independent CLV metric.
 *
 *  Network design: ONE python subprocess (tools/fetch_sharp_odds.py) does
 *  BOTH tiers internally (Odds API primary, Google-AI-Mode fallback) and
 *  returns RAW (vigged) prices; devig happens here via @oracle/engine's
 *  shared devig module so there is exactly one devig implementation in the
 *  whole codebase. Fail-open throughout: any missing key, unmapped league,
 *  network error, or parse failure returns null — this must never block a
 *  pick from being priced or logged (CLAUDE.md §6 — data is never a
 *  blocker). Callers on a hot decision path MUST treat this as fire-and-
 *  forget/best-effort (a short subprocess timeout, never a blocking await
 *  that could stall the batch loop) — see apps/worker/src/dailyAcquisition.ts
 *  for the calling convention. */

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devigThreeWay, devigTwoWay } from "@oracle/engine";
import { resolvePythonBin } from "./fixtures.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "../../..");
const PYTHON_BIN = resolvePythonBin();
const SCRIPT_PATH = join(REPO_ROOT, "tools", "fetch_sharp_odds.py");

/** Best-effort budget for the whole subprocess call (both tiers combined —
 *  Odds API is typically <1s, the Playwright AI-Mode fallback can take
 *  several seconds). Callers must not block their own critical path on this
 *  — fire-and-forget, log-and-continue on timeout/failure, never await this
 *  inline in a per-fixture decision loop. */
export const DEFAULT_SHARP_FEED_TIMEOUT_MS = 15_000;

/** Storage key for the persisted SharpOddsRecord ledger — a raw string
 *  (StoragePort.get/set/upsertBulk accept any string key) rather than an
 *  addition to packages/storage/src/keys.ts, since that file is shared
 *  surface other concurrent Wave-2 workstreams may be touching right now.
 *  Single source of truth: import this constant everywhere a SharpOddsRecord
 *  is read or written rather than repeating the literal. */
export const SHARP_ODDS_STORAGE_KEY = "oracle_v2026_sharp_odds";

/** Stable per-pick id for upsertBulk dedup — one SharpOddsRecord per
 *  (fixture, market, side), updated in place as sharp_fair_at_close and its
 *  source land later. */
export function sharpOddsRecordId(fixtureKey: string, market: string, side: string): string {
  return `${fixtureKey}::${market}::${side}`;
}

/** One pick's sharp-reference odds snapshot. `sharp_fair_at_close` is
 *  populated later (post-kickoff, by the closing-odds sweep) — undefined
 *  until then. */
export interface SharpOddsRecord {
  /** sharpOddsRecordId(fixtureKey, market, side) — the storage.upsertBulk
   *  dedup key (StoragePort.upsertBulk needs a single idField; fixtureKey
   *  alone isn't unique when a fixture has more than one priced market). */
  id: string;
  fixtureKey: string;
  market: string;
  side: string;
  pick_odds: number;
  sharp_fair_at_pick: number | null;
  sharp_fair_at_close: number | null;
  /** Where sharp_fair_at_pick came from — "odds_api" | "ai_mode_fallback" | "unavailable". */
  source: string;
  /** Where sharp_fair_at_close came from — captured later by the closing-odds
   *  sweep (apps/worker/src/dailyAcquisition.ts's closingOddsSweepJob), so
   *  this is independent of `source` (the two captures happen hours apart
   *  and may land on different tiers). Additive/optional so a value built
   *  against the original single-`source` shape still typechecks. */
  sharp_fair_at_close_source?: string | null;
  capturedAt: string;
  /** ISO-8601 timestamp of the sharp_fair_at_close capture — undefined until
   *  the closing-odds sweep runs. */
  closeCapturedAt?: string;
}

/** ── §95%-coverage un-zero-weight criterion (P1-4 plan, verbatim) ──────────
 *
 *  "≥95% pick coverage over 7 consecutive slates" of REAL sharp data is the
 *  documented bar for manually flipping OracleConfig.sharpFeedVerified (see
 *  packages/engine/src/safety/index.ts's ConvergenceScorer S02-S05, zero-
 *  weighted until that latch is true). This module does NOT auto-flip the
 *  flag — that stays a manual ops decision per the plan — but
 *  computeSharpFeedCoverage below is the natural place a future coverage
 *  check hooks in: it turns a batch of SharpOddsRecords into the exact
 *  "coverage" percentage the criterion is worded against (source !==
 *  "unavailable" ÷ total picks), so a per-slate/7-slate rollup can be built
 *  on top of it without re-deriving what "verified" means. */
export function computeSharpFeedCoverage(records: readonly SharpOddsRecord[]): number {
  if (records.length === 0) return 0;
  const covered = records.filter((r) => r.source !== "unavailable" && r.sharp_fair_at_pick != null);
  return covered.length / records.length;
}

// ── Fetch (Tier 1 Odds API + Tier 2 AI-Mode, both inside the python script) ─

interface FetchSharpOddsToolOutput {
  ok: boolean;
  source: "odds_api" | "ai_mode_fallback" | "unavailable" | string;
  market: string;
  side: string;
  prices: Partial<Record<"home" | "draw" | "away" | "yes" | "no", number>>;
  error?: string;
}

export interface SharpFeedContext {
  home: string;
  away: string;
  kickoff: string; // ISO-8601
  /** Human-readable league name, used only for the AI-Mode query context. */
  league?: string;
  /** Odds-API sport key (e.g. "soccer_epl") — see resolveFixtures.ts's
   *  LEAGUE_TO_SPORT. Omitted/unmapped leagues skip Tier 1 for 1X2 too. */
  sportKey?: string;
  /** the-odds-api.com key — Tier 1 is skipped entirely without one. */
  oddsApiKey?: string;
  /** Override the default subprocess timeout (ms). */
  timeoutMs?: number;
}

function runFetchSharpOddsScript(
  fixtureKey: string,
  market: string,
  side: string,
  ctx: SharpFeedContext
): Promise<FetchSharpOddsToolOutput | null> {
  const args = [
    SCRIPT_PATH,
    "--home",
    ctx.home,
    "--away",
    ctx.away,
    "--kickoff",
    ctx.kickoff,
    "--market",
    market,
    "--side",
    side,
    "--fixture-key",
    fixtureKey,
  ];
  if (ctx.league) args.push("--league", ctx.league);
  if (ctx.sportKey) args.push("--sport-key", ctx.sportKey);

  // [review fix] Pass the Odds API key via the child's ENVIRONMENT, never as a
  // CLI argument — argv is world-readable via ps/Task Manager/proc-audit
  // tooling, and fetch_sharp_odds.py already reads ODDS_API_KEY from its own
  // environment (_load_env). Only override when the caller supplied a key;
  // otherwise the script falls back to the ambient .env value on its own.
  const childEnv = ctx.oddsApiKey ? { ...process.env, ODDS_API_KEY: ctx.oddsApiKey } : process.env;

  return new Promise((resolvePromise) => {
    execFile(
      PYTHON_BIN,
      args,
      {
        cwd: REPO_ROOT,
        timeout: ctx.timeoutMs ?? DEFAULT_SHARP_FEED_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: childEnv,
      },
      (err, stdout) => {
        if (err) {
          resolvePromise(null); // timeout/spawn/nonzero-exit — fail-open, never throw
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout.trim()) as FetchSharpOddsToolOutput);
        } catch {
          resolvePromise(null); // unparseable stdout — fail-open
        }
      }
    );
  });
}

/** Devig whatever sides the tool returned and pick out the fair probability
 *  for `side`. 1X2 (3 sides present) uses devigThreeWay; a 2-way pair (BTTS
 *  yes/no, or DNB home/away with no draw leg) uses devigTwoWay. A single
 *  lone side can't be devigged (no margin to remove without a paired price)
 *  — returns null rather than passing through a vigged number as if it were
 *  fair, since that would silently misrepresent the whole point of this
 *  module. Same additive method used everywhere else in ORACLE — see
 *  packages/engine/src/markets/devig.ts's header for why additive, not
 *  multiplicative or an iterative Shin solver. */
function devigSide(prices: FetchSharpOddsToolOutput["prices"], side: string): number | null {
  const s = side.toLowerCase();

  if (prices.home != null && prices.draw != null && prices.away != null) {
    const fair = devigThreeWay(prices.home, prices.draw, prices.away);
    if (!fair) return null;
    const prob =
      s === "home" ? fair[0] : s === "draw" ? fair[1] : s === "away" ? fair[2] : undefined;
    return prob != null && prob > 0 ? 1 / prob : null;
  }

  if (prices.yes != null && prices.no != null) {
    const fair = devigTwoWay(prices.yes, prices.no);
    if (!fair) return null;
    const prob = s === "yes" ? fair[0] : s === "no" ? fair[1] : undefined;
    return prob != null && prob > 0 ? 1 / prob : null;
  }

  if (prices.home != null && prices.away != null) {
    const fair = devigTwoWay(prices.home, prices.away);
    if (!fair) return null;
    const prob = s === "home" ? fair[0] : s === "away" ? fair[1] : undefined;
    return prob != null && prob > 0 ? 1 / prob : null;
  }

  return null; // fewer than 2 matching sides — nothing to devig against
}

/** Fetch + devig the sharp-reference fair price for one market/side, at
 *  whatever point in time this is called (at-pick or at-close — the caller's
 *  timing is what distinguishes the two, not any parameter here). Fail-open:
 *  returns null (never throws) when no sharp source is available, the
 *  subprocess times out, or devig can't be computed from what came back.
 *
 *  `fair` is expressed as a decimal-odds-equivalent number (1 / fair
 *  probability) — the same units as `pick_odds` — so downstream CLV math
 *  (resolveFixtures.ts's computeSharpReferenceClv) can reuse the exact
 *  `1/closing - 1/analysis` implied-probability-delta shape already used for
 *  computeRealisedClv, just against a sharp reference instead of SportyBet's
 *  own closing line. */
export async function fetchSharpFairPrice(
  fixtureKey: string,
  market: string,
  side: string,
  ctx: SharpFeedContext
): Promise<{ fair: number; source: string } | null> {
  try {
    const raw = await runFetchSharpOddsScript(fixtureKey, market, side, ctx);
    if (!raw || !raw.ok) return null;
    const fair = devigSide(raw.prices, side);
    if (fair == null || !Number.isFinite(fair)) return null;
    return { fair: parseFloat(fair.toFixed(4)), source: raw.source };
  } catch {
    return null; // belt-and-braces — this function must never throw
  }
}
