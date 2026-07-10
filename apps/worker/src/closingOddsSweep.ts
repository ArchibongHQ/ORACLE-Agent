/** PR-8a — pure sweep-window + dedup logic for the T-30m closing-odds capture.
 *  Extracted standalone (no cron/execFile/storage imports) so the window math
 *  and rerun-dedup rules are unit-testable in isolation, same rationale as
 *  acquireChain.ts.
 *
 *  Design: persisted-state, periodically-swept — NOT an in-memory setTimeout
 *  per fixture. The worker is long-running but Servy restarts it on crash
 *  unconditionally and can do so repeatedly in quick succession (see
 *  index.ts's crash-loop guard) — an in-memory timer queue would silently
 *  lose pending snapshots on any such restart. This module instead re-derives
 *  "who's due right now" fresh from storage on every tick, so a restart mid-
 *  window just means the next tick (<=5min later) still catches it. */

export const SNAPSHOT_WINDOW_MIN_MINUTES = 25;
export const SNAPSHOT_WINDOW_MAX_MINUTES = 35;

/** Minimal shape the sweep needs from an AnalysisRecord — kept narrow so this
 *  module doesn't import @oracle/engine types (stays dependency-free). */
export interface SweepCandidate {
  fixtureId: string;
  home: string;
  away: string;
  kickoff: string; // ISO-8601 UTC
  analysedAt: string; // ISO-8601 — used to pick the latest of duplicate fixtureIds (reruns)
}

export interface DueFixture {
  fixtureId: string;
  home: string;
  away: string;
  kickoff: string;
}

/** Pure epoch-instant math — NEVER wall-clock/WAT string comparison. Both
 *  `kickoffIso` (UTC ISO-8601) and `now` are absolute instants; the cron's own
 *  WAT timezone pin (cosmetic for an every-5-minutes schedule — minutes are
 *  timezone-invariant) must not leak into this calculation. */
export function minutesToKickoff(kickoffIso: string, now: Date): number {
  const kickoffMs = new Date(kickoffIso).getTime();
  if (Number.isNaN(kickoffMs)) return Number.NaN;
  return (kickoffMs - now.getTime()) / 60_000;
}

export function isDueForSnapshot(minsToKO: number): boolean {
  return (
    Number.isFinite(minsToKO) &&
    minsToKO >= SNAPSHOT_WINDOW_MIN_MINUTES &&
    minsToKO <= SNAPSHOT_WINDOW_MAX_MINUTES
  );
}

/** Dedupe candidates by fixtureId first (a fixture re-analysed across reruns
 *  appears multiple times in AnalysisRecords with different analysisIds but
 *  the SAME fixtureId — keep only the most-recently-analysed one per
 *  fixtureId), THEN filter to the 25-35min window, THEN exclude fixtureIds
 *  that already have a closingOddsSnapshots entry. */
export function selectDueFixtures(
  candidates: SweepCandidate[],
  alreadySnapshotted: ReadonlySet<string>,
  now: Date = new Date()
): DueFixture[] {
  const latestByFixture = new Map<string, SweepCandidate>();
  for (const c of candidates) {
    const existing = latestByFixture.get(c.fixtureId);
    if (!existing || c.analysedAt > existing.analysedAt) latestByFixture.set(c.fixtureId, c);
  }

  const due: DueFixture[] = [];
  for (const c of latestByFixture.values()) {
    if (alreadySnapshotted.has(c.fixtureId)) continue;
    if (!isDueForSnapshot(minutesToKickoff(c.kickoff, now))) continue;
    due.push({ fixtureId: c.fixtureId, home: c.home, away: c.away, kickoff: c.kickoff });
  }
  return due;
}

// ── Sharp-reference fair-price capture at T-30m (P1-4, Wave 2) ──────────────
// Rides the SAME 25-35min pre-kickoff window as the SportyBet odds-only
// snapshot above, but is a fully separate pure selection: a fixture only
// needs a sharp_fair_at_close capture if it already has a sharp_fair_at_pick
// record (dailyAcquisition.ts's captureSharpFairAtPick) AND we know which
// market/side/price to re-price. Kept here (not inline in dailyAcquisition.ts)
// for the same reason selectDueFixtures is: pure epoch-instant math, no
// cron/execFile/storage imports, unit-testable in isolation.

/** SweepCandidate plus the top-pick identity needed to re-price it via the
 *  sharp feed. market/side/pickOdds are optional because not every
 *  AnalysisRecord necessarily carries a resolvable deterministic top pick at
 *  sweep time — a candidate missing any of them simply can't be sharp-swept
 *  (selectDueSharpFixtures drops it, never throws). */
export interface SharpSweepCandidate extends SweepCandidate {
  league?: string;
  market?: string;
  side?: string;
  pickOdds?: number;
}

export interface DueSharpFixture extends DueFixture {
  league?: string;
  market: string;
  side: string;
  pickOdds: number;
}

/** Same dedup-by-fixtureId + 25-35min window logic as selectDueFixtures,
 *  additionally requiring a resolvable market/side/pickOdds (nothing to
 *  re-price without them) and excluding fixtureIds whose SharpOddsRecord
 *  already has a sharp_fair_at_close (alreadySharpClosed) — independent of
 *  alreadySnapshotted above, since the two captures live in separate
 *  storage. */
export function selectDueSharpFixtures(
  candidates: SharpSweepCandidate[],
  alreadySharpClosed: ReadonlySet<string>,
  now: Date = new Date()
): DueSharpFixture[] {
  const latestByFixture = new Map<string, SharpSweepCandidate>();
  for (const c of candidates) {
    const existing = latestByFixture.get(c.fixtureId);
    if (!existing || c.analysedAt > existing.analysedAt) latestByFixture.set(c.fixtureId, c);
  }

  const due: DueSharpFixture[] = [];
  for (const c of latestByFixture.values()) {
    if (alreadySharpClosed.has(c.fixtureId)) continue;
    if (!isDueForSnapshot(minutesToKickoff(c.kickoff, now))) continue;
    if (!c.market || !c.side || c.pickOdds == null) continue;
    due.push({
      fixtureId: c.fixtureId,
      home: c.home,
      away: c.away,
      kickoff: c.kickoff,
      league: c.league,
      market: c.market,
      side: c.side,
      pickOdds: c.pickOdds,
    });
  }
  return due;
}
