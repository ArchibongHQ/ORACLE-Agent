/** RAGSystem — full port from ORACLE_v2026_8_0.jsx §7/§7c (lines 1884–2180).
 *  12-dim L2-normalized embedding; cosine similarity; B5-04 RLM pre-filter; SSSVO elevation.
 *  StoragePort replaces localStorage (_persist / init).
 *  PostmortemRegistry: B11 failure-pattern store, pre-seeded with 4 confirmed 2026-03-10 losses. */
import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS, withKeyLock } from "@oracle/storage";
import { benfordMAD, safeNum } from "../math/index.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const LEAGUE_NAMES = [
  "Premier League",
  "La Liga",
  "Serie A",
  "Bundesliga",
  "Ligue 1",
  "Eredivisie",
  "Champions League",
  "Default",
];
const MAX_STORE = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RAGEntry {
  id: string;
  fixture: string;
  home: string;
  away: string;
  league: string;
  competitionType: string;
  leagueTier: number;
  vorpCount: number;
  totalXG: number;
  lambdaH: number; // Phase 2: explicit Poisson λ (home), avoids reading result bag
  lambdaA: number; // Phase 2: explicit Poisson λ (away)
  embedding: number[];
  topMarketCat: string;
  result: Record<string, unknown>;
  timestamp: string;
  similarity?: number;
  isSSSVO?: boolean;
  sameCategoryAsQuery?: boolean;
}

// ── RAGSystem ─────────────────────────────────────────────────────────────────

export class RAGSystem {
  private _store: RAGEntry[] = [];

  constructor(private _storage: StoragePort) {}

  async init(): Promise<void> {
    const saved = await this._storage.get<RAGEntry[]>(STORAGE_KEYS.ragStore);
    if (Array.isArray(saved)) this._store = saved.slice(-MAX_STORE);
  }

  private async _persist(): Promise<void> {
    await this._storage.set(STORAGE_KEYS.ragStore, this._store.slice(-MAX_STORE));
  }

  private _normalize(vec: number[]): number[] {
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) + 1e-8;
    return vec.map((v) => v / norm);
  }

  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i]! * b[i]!;
    return dot; // pre-normalized: cosine = dot product
  }

  // BUG-B04: 12-dimensional embedding
  // Dims: lH, lA, pH, pD, pA, ev*10, varMult, mes, leagueHash, hoursToKO bucket, marketTypeBit, drawSpread
  createEmbedding(fd: Record<string, unknown>): number[] {
    const leagueIdx = LEAGUE_NAMES.indexOf(String(fd.league ?? "Default"));
    const leagueHash =
      (leagueIdx >= 0 ? leagueIdx : LEAGUE_NAMES.length - 1) / Math.max(1, LEAGUE_NAMES.length - 1);
    const hoursBucket = Math.min(1.0, ((fd.hoursToKO as number | undefined) ?? 24) / 72);
    const evMarkets = fd.evMarkets as Array<Record<string, unknown>> | undefined;
    const topMarket = evMarkets?.[0];
    const mt = String(topMarket?.cat ?? "");
    const marketTypeBit = mt.includes("Asian")
      ? 0.66
      : mt.includes("Goals") || mt.includes("BTTS")
        ? 0.33
        : 0.0;
    const fp = fd.fp as Record<string, number> | undefined;
    const drawSpread = Math.abs((fp?.draw ?? 0.25) - 0.25);
    const raw = [
      (fd.bayesian_lH as number | undefined) ?? 1.5,
      (fd.bayesian_lA as number | undefined) ?? 1.2,
      fp?.home ?? 0.33,
      fp?.draw ?? 0.33,
      fp?.away ?? 0.33,
      ((topMarket?.ev as number | undefined) ?? 0) * 10,
      (fd.mc as Record<string, number> | undefined)?.varMultiplier ?? 1.0,
      (fd.mes as number | undefined) ?? 0.9,
      leagueHash,
      hoursBucket,
      marketTypeBit,
      drawSpread,
    ];
    return this._normalize(raw);
  }

  // B5-03: NaN-sanitize embedding on add to prevent cosine corruption
  async addToStore(fd: Record<string, unknown>, result: Record<string, unknown>): Promise<void> {
    const evMarkets = fd.evMarkets as Array<Record<string, unknown>> | undefined;
    const topMarketCat = String(evMarkets?.[0]?.cat ?? "unknown");
    const rawEmb = this.createEmbedding(fd);
    const cleanEmb = rawEmb.map((v) => (Number.isNaN(v) || !Number.isFinite(v) ? 0 : v));
    const league = String(fd.league ?? "Default");
    const lH = safeNum((fd.bayesian_lH as number | undefined) ?? 0, 0);
    const lA = safeNum((fd.bayesian_lA as number | undefined) ?? 0, 0);
    const entry: RAGEntry = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      fixture: `${fd.home ?? ""} vs ${fd.away ?? ""}`,
      home: String(fd.home ?? ""),
      away: String(fd.away ?? ""),
      league,
      competitionType: String(
        fd.competitionType ?? (league.toLowerCase().includes("cup") ? "cup" : "league")
      ),
      leagueTier: (fd.leagueTier as number | undefined) ?? 2,
      vorpCount: safeNum((fd.vorpCount as number | undefined) ?? 0, 0),
      totalXG: safeNum(lH + lA, 2.5),
      lambdaH: lH,
      lambdaA: lA,
      embedding: cleanEmb,
      topMarketCat,
      result,
      timestamp: new Date().toISOString(),
    };

    // Serialized read-modify-write on the shared store key. Re-reads the persisted
    // store inside the lock so concurrent fixtures append to the latest state
    // instead of each overwriting with a stale init() snapshot (would drop entries).
    await withKeyLock(STORAGE_KEYS.ragStore, async () => {
      const persisted = (await this._storage.get<RAGEntry[]>(STORAGE_KEYS.ragStore)) ?? [];
      const merged = [...persisted, entry].slice(-MAX_STORE);
      this._store = merged;
      await this._storage.set(STORAGE_KEYS.ragStore, merged);
    });
  }

  findSimilar(qf: Record<string, unknown>, k = 5): RAGEntry[] {
    const qEmb = this.createEmbedding(qf);
    const evMarkets = qf.evMarkets as Array<Record<string, unknown>> | undefined;
    const qCat = String(evMarkets?.[0]?.cat ?? "unknown");
    const qHome = String(qf.home ?? "").toLowerCase();
    const qAway = String(qf.away ?? "").toLowerCase();
    const qDate = String(qf.date ?? "").slice(0, 7);
    const qTier = (qf.leagueTier as number | undefined) ?? 2;
    const qVORP = safeNum((qf.vorpCount as number | undefined) ?? 0, 0);
    const qXG = safeNum(
      ((qf.bayesian_lH as number | undefined) ?? 0) + ((qf.bayesian_lA as number | undefined) ?? 0),
      2.5
    );

    // B5-04: RLM programmatic pre-filter when store >= 10
    let pool: RAGEntry[] = this._store;
    if (pool.length >= 10) {
      const filtered = pool.filter((item) => {
        const tierOK = Math.abs((item.leagueTier ?? 2) - qTier) <= 1;
        const vorpOK = Math.abs((item.vorpCount ?? 0) - qVORP) <= 2;
        const xgOK = Math.abs((item.totalXG ?? 2.5) - qXG) <= 0.5;
        return tierOK && vorpOK && xgOK;
      });
      if (filtered.length >= 5) pool = filtered;
    }

    const scored: RAGEntry[] = pool.map((item) => {
      let sim = this.cosineSimilarity(qEmb, item.embedding);
      const itemDate = (item.timestamp ?? "").slice(0, 7);
      const sameSeasonWindow = !!(
        qDate &&
        itemDate &&
        Math.abs(parseInt(qDate.replace("-", ""), 10) - parseInt(itemDate.replace("-", ""), 10)) <=
          6
      );
      const sameTeams = item.home.toLowerCase() === qHome && item.away.toLowerCase() === qAway;
      const isSSSVO = sameSeasonWindow && sameTeams;
      if (isSSSVO) sim = Math.max(sim, 0.97); // B5-01: SSSVO floor
      return { ...item, similarity: sim, isSSSVO, sameCategoryAsQuery: item.topMarketCat === qCat };
    });

    scored.sort((a, b) => {
      if (a.isSSSVO && !b.isSSSVO) return -1;
      if (!a.isSSSVO && b.isSSSVO) return 1;
      return (b.similarity ?? 0) - (a.similarity ?? 0);
    });
    return scored.slice(0, k);
  }

  formatAnalogues(similar: RAGEntry[]): string {
    if (!similar || similar.length === 0) return "No historical analogues found.";
    return similar
      .slice(0, 3)
      .map((s, i) => {
        const res = s.result;
        const topEv = (res?.evMarkets as Array<Record<string, number>> | undefined)?.[0]?.ev ?? 0;
        const topBanker =
          (res?.debate as Record<string, unknown> | undefined)?.topBankerBet ?? "N/A";
        return `[${i + 1}] ${s.fixture} (sim:${((s.similarity ?? 0) * 100).toFixed(0)}%, cat_match:${s.sameCategoryAsQuery ? "YES" : "NO"}) — EV:${(topEv * 100).toFixed(1)}% | Outcome: ${topBanker}`;
      })
      .join("\n");
  }

  reset(): void {
    this._store = [];
    this._persist().catch(() => {});
  }

  getStore(): RAGEntry[] {
    return [...this._store];
  }

  // HF-B: Benford audit on stored lambda values; anomalous MAD = data quality issue
  auditStoreBenford(): string | null {
    const lambdas = this._store.flatMap((e) => {
      return [e.lambdaH, e.lambdaA].filter((v): v is number => typeof v === "number" && v > 0);
    });
    const mad = benfordMAD(lambdas);
    if (mad === null) return null;
    if (mad > 0.015)
      return `[BENFORD_ANOMALY_DATA_SOURCE] RAG store lambda Benford MAD=${mad.toFixed(4)} (threshold 0.015). ${lambdas.length} values.`;
    if (mad > 0.006)
      return `[BENFORD_ACCEPTABLE_DATA_SOURCE] RAG store lambda MAD=${mad.toFixed(4)} — within acceptable range.`;
    return null;
  }
}

// ── PostmortemRegistry ────────────────────────────────────────────────────────
//
// [P2-2 hygiene] Dormant — `PostmortemRegistry`/`postmortemRegistry` are exported from the
// barrel (packages/engine/src/index.ts) and pre-seeded with 4 confirmed 2026-03-10 losses,
// but `.check()`/`.formatWarning()` currently have ZERO call sites in `batch/`, `execution/`,
// `decision/`, or anywhere else in `packages/` outside this file's own unit tests
// (verify with a call-site grep before assuming otherwise — this changes fast). Same status
// as `safety/index.ts`'s `weighReversibility` (§5.6 in `.claude/skills/oracle-engine/SKILL.md`):
// defined and self-contained, never wired into a live decision path. Activation would mean a
// caller in the decision/execution pipeline running `check()` against the current fixture and
// surfacing `formatWarning()`'s output as a soft-context postmortem-pattern warning (parallel to
// how `RAGSystem.findSimilar` already feeds ConvergenceScorer's S10 signal) — no walk-forward
// gate is implied here since this is pattern-matching against confirmed past losses, not a
// probability-affecting model variant, but it should not be assumed live without checking first.

export const ROOT_CAUSES = Object.freeze({
  SSSVO_IGNORED: "SSSVO_IGNORED",
  XG_CEILING_BREACH: "XG_CEILING_BREACH",
  DRAW_SUPPRESSED: "DRAW_SUPPRESSED",
  NEGATIVE_EV_SKIPPED: "NEGATIVE_EV_SKIPPED",
  CUPSET_UNDETECTED: "CUPSET_UNDETECTED",
  BTTS_H2H_IGNORED: "BTTS_H2H_IGNORED",
  FATIGUE_UNDERWEIGHTED: "FATIGUE_UNDERWEIGHTED",
});

export type RootCause = keyof typeof ROOT_CAUSES;

export interface PostmortemEntry {
  fixtureId: string;
  date: string;
  homeTeam: string;
  awayTeam: string;
  marketPicked: string;
  marketResult: "win" | "loss";
  failureType: string;
  signalsThatFired: string[];
  signalsThatShouldHaveFired: string[];
  rootCause: RootCause;
  embedding?: number[];
  addedAt?: string;
  similarity?: number;
}

export class PostmortemRegistry {
  static readonly ROOT_CAUSES = ROOT_CAUSES;
  static readonly SIMILARITY_THRESHOLD = 0.82;

  private _entries: PostmortemEntry[] = [];

  add(entry: Omit<PostmortemEntry, "embedding" | "addedAt" | "similarity">): boolean {
    if (!ROOT_CAUSES[entry.rootCause as RootCause]) return false;
    const embedding = this._buildEmbedding(entry);
    this._entries.push({ ...entry, embedding, addedAt: new Date().toISOString() });
    return true;
  }

  private _buildEmbedding(
    e: Omit<PostmortemEntry, "embedding" | "addedAt" | "similarity">
  ): number[] {
    const rootIdx = Object.keys(ROOT_CAUSES).indexOf(e.rootCause) / 7;
    const firedCount = (e.signalsThatFired ?? []).length / 14;
    const shouldCount = (e.signalsThatShouldHaveFired ?? []).length / 14;
    const mp = e.marketPicked?.toLowerCase() ?? "";
    const isHome = mp.includes("home") ? 1 : 0;
    const isAway = mp.includes("away") ? 1 : 0;
    const isOver = mp.includes("over") ? 1 : 0;
    const isUnder = mp.includes("under") ? 1 : 0;
    const isBTTS = mp.includes("btts") ? 1 : 0;
    const isML = mp.includes("ml") || mp.includes("money") ? 1 : 0;
    const isLoss = e.marketResult === "loss" ? 1 : 0;
    const dateHash = new Date(e.date ?? 0).getMonth() / 12;
    const fixtureHash = ((e.homeTeam ?? "").length + (e.awayTeam ?? "").length) / 40;
    return [
      rootIdx,
      firedCount,
      shouldCount,
      isHome,
      isAway,
      isOver,
      isUnder,
      isBTTS,
      isML,
      isLoss,
      dateHash,
      fixtureHash,
    ];
  }

  private _cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom < 1e-10 ? 0 : Math.min(1, dot / denom);
  }

  // B11-03: Check fixture against failure registry; returns matches >= threshold
  check(
    queryEntry: Omit<PostmortemEntry, "embedding" | "addedAt" | "similarity">
  ): PostmortemEntry[] {
    const qEmb = this._buildEmbedding(queryEntry);
    return this._entries
      .map((e) => ({ ...e, similarity: this._cosineSimilarity(qEmb, e.embedding ?? []) }))
      .filter((e) => (e.similarity ?? 0) >= PostmortemRegistry.SIMILARITY_THRESHOLD)
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  }

  formatWarning(matches: PostmortemEntry[]): string {
    if (!matches || matches.length === 0) return "";
    const lines = ["[POSTMORTEM_PATTERN_MATCH] Historical failure patterns detected:"];
    matches.slice(0, 3).forEach((m, i) => {
      lines.push(
        `[${i + 1}] ${m.homeTeam} vs ${m.awayTeam} (${m.date}) — ${m.rootCause} — Market: ${m.marketPicked} -> LOSS (sim:${((m.similarity ?? 0) * 100).toFixed(0)}%)`
      );
    });
    lines.push("ACTION: Verify these failure conditions are NOT present before recommending.");
    return lines.join("\n");
  }

  getAll(): PostmortemEntry[] {
    return [...this._entries];
  }
  reset(): void {
    this._entries = [];
  }
}

// B11-04: Pre-seeded with confirmed 2026-03-10 postmortem losses
export const postmortemRegistry = new PostmortemRegistry();
postmortemRegistry.add({
  fixtureId: "GAL_LIV_20260310",
  date: "2026-03-10",
  homeTeam: "Galatasaray",
  awayTeam: "Liverpool",
  marketPicked: "BTTS Yes",
  marketResult: "loss",
  failureType: "H2H SSSVO analogue ignored",
  signalsThatFired: ["S01", "S03", "S07", "S08"],
  signalsThatShouldHaveFired: ["S10"],
  rootCause: "SSSVO_IGNORED",
});
postmortemRegistry.add({
  fixtureId: "NEW_BAR_20260310",
  date: "2026-03-10",
  homeTeam: "Newcastle",
  awayTeam: "Barcelona",
  marketPicked: "Over 3",
  marketResult: "loss",
  failureType: "xG ceiling breached — combined xG 2.07 vs line 3.0",
  signalsThatFired: ["S01", "S04", "S06"],
  signalsThatShouldHaveFired: ["S14"],
  rootCause: "XG_CEILING_BREACH",
});
postmortemRegistry.add({
  fixtureId: "POR_SWA_20260310",
  date: "2026-03-10",
  homeTeam: "Portsmouth",
  awayTeam: "Swansea",
  marketPicked: "Under 2.5",
  marketResult: "loss",
  failureType: "Negative EV — implied 61.4% vs model 56%, excess 5.4%",
  signalsThatFired: ["S05", "S06", "S07"],
  signalsThatShouldHaveFired: ["S14"],
  rootCause: "NEGATIVE_EV_SKIPPED",
});
postmortemRegistry.add({
  fixtureId: "STO_IPS_20260310",
  date: "2026-03-10",
  homeTeam: "Stoke City",
  awayTeam: "Ipswich Town",
  marketPicked: "Away ML",
  marketResult: "loss",
  failureType: "Draw suppressed — 12 home absences, Championship draw amplifier not applied",
  signalsThatFired: ["S01", "S02", "S05"],
  signalsThatShouldHaveFired: ["S14"],
  rootCause: "DRAW_SUPPRESSED",
});
