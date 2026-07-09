import type { BatchJobResult, EVMarket, PickRefMarket, RunResult } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import type { SportyBetEventDetail } from "../src/selectFixtures.js";
import { sidecarKey } from "../src/selectFixtures.js";
import {
  GOALS_MARKETS,
  goalsDataGate,
  pickSafestGoalsLeg,
  selectGoalsAccumulator,
} from "../src/selectGoals.js";

// ── builders ────────────────────────────────────────────────────────────────

function evm(
  label: string,
  mp: number,
  ip: number,
  odds = 1 / ip,
  cat: PickRefMarket = "Goals O/U"
): EVMarket {
  return {
    cat,
    label,
    market: cat,
    side: label,
    mp,
    modelProb: mp,
    ip,
    rawEdge: mp - ip,
    ev: (mp - ip) * odds,
    odds,
    stake: 0,
    stakeAmt: 0,
    rankingScore: mp,
    varianceMod: 1,
  };
}

function okJob(
  home: string,
  away: string,
  evMarkets: EVMarket[],
  league = "Premier League",
  kickoff = "2026-06-15T15:00:00Z"
): BatchJobResult {
  return {
    status: "ok",
    analysisId: `a_${home}_${away}`,
    runId: "run1",
    fixtureId: `f_${home}_${away}`,
    home,
    away,
    league,
    kickoff,
    result: { evMarkets } as unknown as RunResult,
    decision: {
      primaryPick: { market: "Goals O/U", odds: 1 },
      confidence: 0.5,
      grade: "LEAN",
      rationale: "",
      rejectedAndWhy: [],
    },
    decisionReplay: null,
    eligibleBets: [],
    primaryPick: null,
    llmEligible: true,
  };
}

function errJob(home: string, away: string): BatchJobResult {
  return {
    status: "error",
    fixtureId: `f_${home}_${away}`,
    home,
    away,
    league: "Premier League",
    kickoff: "2026-06-15T15:00:00Z",
    reason: "boom",
    errorCode: "NO_DATA",
    llmEligible: true,
  };
}

/** Detail with both-teams goals + defensive figures (passes the strict gate). */
function richDetail(): SportyBetEventDetail {
  return {
    eventId: "e1",
    odds: null,
    stats: {
      goals: {
        home: { avg_scored: 2.1, avg_conceded: 1.0 },
        away: { avg_scored: 1.8, avg_conceded: 1.2 },
      },
      standings: { home: { ga: 18 }, away: { ga: 22 } },
    },
    statscoverage: null,
  };
}

/** Detail with only a single team's scoring signal (lenient gate only). */
function thinDetail(): SportyBetEventDetail {
  return {
    eventId: "e2",
    odds: null,
    stats: { goals: { home: { avg_scored: 1.6 }, away: null } },
    statscoverage: null,
  };
}

function detailMap(entries: Array<[string, string, SportyBetEventDetail]>) {
  const m = new Map<string, SportyBetEventDetail>();
  for (const [h, a, d] of entries) m.set(sidecarKey(h, a), d);
  return m;
}

// ── goalsDataGate ─────────────────────────────────────────────────────────────

describe("goalsDataGate", () => {
  it("rejects markets outside GOALS_MARKETS", () => {
    expect(goalsDataGate(richDetail(), "Premier League", "Over 3.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "Premier League", "BTTS Yes")).toBe(false);
  });

  it("rejects cup / friendly / derby leagues regardless of data", () => {
    expect(goalsDataGate(richDetail(), "FA Cup", "Over 1.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "Club Friendly", "Over 1.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "Merseyside Derby", "Over 1.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "Copa del Rey", "Over 1.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "DFB Pokal", "Over 1.5")).toBe(false);
  });

  it("does not let a bare 'euro' substring exempt a real domestic cup/friendly from exclusion", () => {
    // Regression test: an earlier version of _INTL_TOURNAMENT_RE's euro
    // alternative had both qualifying groups optional, reducing to a bare
    // /euro/i match that would incorrectly exempt any league merely
    // containing "euro" — these must still be excluded.
    expect(goalsDataGate(richDetail(), "Euro Friendly Cup", "Over 1.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "EuroLeague Youth Friendly", "Over 1.5")).toBe(false);
  });

  it("does NOT reject international tournaments — only the 'cup' substring false-positive", () => {
    expect(goalsDataGate(richDetail(), "FIFA World Cup", "Over 1.5")).toBe(true);
    expect(goalsDataGate(richDetail(), "World Cup Qualification", "Over 1.5")).toBe(true);
    expect(goalsDataGate(richDetail(), "UEFA Euro 2026", "Over 1.5")).toBe(true);
    expect(goalsDataGate(richDetail(), "Copa América", "Over 1.5")).toBe(true);
    expect(goalsDataGate(richDetail(), "UEFA Nations League", "Over 1.5")).toBe(true);
    expect(goalsDataGate(richDetail(), "Africa Cup of Nations", "Over 1.5")).toBe(true);
  });

  it("Over 2.5 (strict): requires both teams goals + a defensive figure", () => {
    expect(goalsDataGate(richDetail(), "Premier League", "Over 2.5")).toBe(true);
    expect(goalsDataGate(thinDetail(), "Premier League", "Over 2.5")).toBe(false);
    expect(goalsDataGate(undefined, "Premier League", "Over 2.5")).toBe(false);
  });

  it("Over 1.5 / Team Over 0.5 (lenient): any single-team scoring signal suffices", () => {
    expect(goalsDataGate(thinDetail(), "Premier League", "Over 1.5")).toBe(true);
    expect(goalsDataGate(thinDetail(), "Premier League", "Home Total Over 0.5")).toBe(true);
    expect(goalsDataGate(undefined, "Premier League", "Over 1.5")).toBe(false);
  });

  it("Over 2.5 strict: standings ga satisfies the defensive figure when avg_conceded is absent", () => {
    const standingsOnlyDef: SportyBetEventDetail = {
      eventId: "e3",
      odds: null,
      stats: {
        goals: { home: { avg_scored: 2.0 }, away: { avg_scored: 1.7 } }, // no avg_conceded
        standings: { home: { ga: 14 }, away: { ga: 19 } },
      },
      statscoverage: null,
    };
    expect(goalsDataGate(standingsOnlyDef, "Premier League", "Over 2.5")).toBe(true);
  });

  it("derives scoring signal from standings gf/played when stats.goals is absent", () => {
    // Production shape: scraper emits form + standings but no goals block.
    const standingsOnly: SportyBetEventDetail = {
      eventId: "e5",
      odds: null,
      stats: {
        standings: {
          home: { played: 12, gf: 16, ga: 5 },
          away: { played: 12, gf: 16, ga: 14 },
        },
      },
      statscoverage: null,
    };
    // Lenient tier: single-team gf/played > 0 suffices.
    expect(goalsDataGate(standingsOnly, "Premier League", "Over 1.5")).toBe(true);
    expect(goalsDataGate(standingsOnly, "Premier League", "Home Total Over 0.5")).toBe(true);
    // Strict tier: both teams score (gf>0) + both have ga → passes.
    expect(goalsDataGate(standingsOnly, "Premier League", "Over 2.5")).toBe(true);
  });

  it("rejects standings with zero gf or zero played (no real signal)", () => {
    const zeroPlayed: SportyBetEventDetail = {
      eventId: "e6",
      odds: null,
      stats: {
        standings: { home: { played: 0, gf: 0, ga: 0 }, away: { played: 0, gf: 0, ga: 0 } },
      },
      statscoverage: null,
    };
    expect(goalsDataGate(zeroPlayed, "Premier League", "Over 1.5")).toBe(false);
  });

  it("Over 2.5 strict: rejects when both teams score but neither defensive figure exists", () => {
    const noDefence: SportyBetEventDetail = {
      eventId: "e4",
      odds: null,
      stats: { goals: { home: { avg_scored: 2.0 }, away: { avg_scored: 1.7 } } }, // no conceded, no standings
      statscoverage: null,
    };
    expect(goalsDataGate(noDefence, "Premier League", "Over 2.5")).toBe(false);
  });
});

// ── pickSafestGoalsLeg ───────────────────────────────────────────────────────

describe("pickSafestGoalsLeg", () => {
  const detailByKey = detailMap([["A", "B", richDetail()]]);

  it("returns null for errored jobs", () => {
    expect(pickSafestGoalsLeg(errJob("A", "B"), { detailByKey })).toBeNull();
  });

  it("returns null when no allowed market clears the bars", () => {
    const job = okJob("A", "B", [evm("Over 2.5", 0.6, 0.55)]); // mp below 0.75
    expect(pickSafestGoalsLeg(job, { detailByKey })).toBeNull();
  });

  it("ignores non-goals markets even at high confidence", () => {
    const job = okJob("A", "B", [evm("AH Home -1", 0.95, 0.9, undefined, "Asian Handicap")]);
    expect(pickSafestGoalsLeg(job, { detailByKey })).toBeNull();
  });

  it("picks the highest-mp qualifying goals leg (safest)", () => {
    const job = okJob("A", "B", [evm("Over 1.5", 0.92, 0.8), evm("Over 2.5", 0.78, 0.72)]);
    const leg = pickSafestGoalsLeg(job, { detailByKey });
    expect(leg?.side).toBe("Over 1.5");
    expect(leg?.mp).toBeCloseTo(0.92);
  });

  it("drops Over 2.5 when strict data gate fails but keeps a passing Over 1.5", () => {
    const thin = detailMap([["A", "B", thinDetail()]]);
    const job = okJob("A", "B", [
      evm("Over 2.5", 0.95, 0.9), // would win on mp, but strict gate fails
      // thinDetail has only a single-team goals signal → completeness floors at
      // 0.5 → required edge = MIN_GOALS_EDGE / 0.5 = 0.10. Give Over 1.5 a 0.12
      // edge so it clears the thin-data haircut and remains the kept leg.
      evm("Over 1.5", 0.84, 0.72), // edge=0.12 — above the 0.10 thin-data bar
    ]);
    const leg = pickSafestGoalsLeg(job, { detailByKey: thin });
    expect(leg?.side).toBe("Over 1.5");
  });

  it("applies the data-completeness haircut: a thin-data leg needs a bigger edge", () => {
    const thin = detailMap([["A", "B", thinDetail()]]); // completeness 0.5 → bar 0.10
    // 0.08 edge clears the plain 5% bar but NOT the thin-data 10% bar → dropped.
    const justUnder = okJob("A", "B", [evm("Over 1.5", 0.8, 0.72)]);
    expect(pickSafestGoalsLeg(justUnder, { detailByKey: thin })).toBeNull();
    // The same leg on a full-data (rich) fixture qualifies — completeness 1.0.
    const rich = detailMap([["A", "B", richDetail()]]);
    expect(
      pickSafestGoalsLeg(okJob("A", "B", [evm("Over 1.5", 0.8, 0.72)]), {
        detailByKey: rich,
      })?.side
    ).toBe("Over 1.5");
  });

  it("respects veto", () => {
    const vetoed = okJob("A", "B", [{ ...evm("Over 1.5", 0.9, 0.8), veto: "X" }]);
    expect(pickSafestGoalsLeg(vetoed, { detailByKey })).toBeNull();
  });

  it("admits a low-implied leg by default (no hard price floor, edge positive)", () => {
    // mp 0.9 over ip 0.6 (odds ~1.67) — rejected under the old ip>=0.70 floor,
    // now qualifies: high confidence + positive model edge (mp > ip).
    const lowIp = okJob("A", "B", [evm("Over 1.5", 0.9, 0.6)]);
    expect(pickSafestGoalsLeg(lowIp, { detailByKey })?.side).toBe("Over 1.5");
  });

  it("requires a positive model edge (mp > ip)", () => {
    // High confidence but the market already prices it higher — no edge, rejected.
    const noEdge = okJob("A", "B", [evm("Over 1.5", 0.8, 0.85)]);
    expect(pickSafestGoalsLeg(noEdge, { detailByKey })).toBeNull();
  });

  it("honours an opt-in implied floor when minImplied is supplied", () => {
    const lowIp = okJob("A", "B", [evm("Over 1.5", 0.9, 0.6)]);
    expect(pickSafestGoalsLeg(lowIp, { detailByKey, minImplied: 0.7 })).toBeNull();
  });

  it("recovers a regional-suffix mismatch via tolerant lookup (Ferroviaria ~ Ferroviaria SP)", () => {
    // Sidecar keyed under the suffixed name; engine job uses the bare name.
    const suffixed = detailMap([["Ferroviaria SP", "Barra FC SC", thinDetail()]]);
    const job = okJob("Ferroviaria", "Barra FC", [evm("Over 1.5", 0.8, 0.62)]);
    const leg = pickSafestGoalsLeg(job, { detailByKey: suffixed });
    expect(leg?.side).toBe("Over 1.5"); // exact key missed; namesMatch scan found it
  });

  it("includes a leg sitting exactly on the confidence floor (>= is inclusive)", () => {
    // ip=0.60 → edge=0.12, well above MIN_GOALS_EDGE; test is about the mp floor only.
    const atBar = okJob("A", "B", [evm("Over 1.5", 0.72, 0.6)]);
    expect(pickSafestGoalsLeg(atBar, { detailByKey })?.side).toBe("Over 1.5");
    const justUnderMp = okJob("A", "B", [evm("Over 1.5", 0.7199, 0.6)]);
    expect(pickSafestGoalsLeg(justUnderMp, { detailByKey })).toBeNull();
  });
});

// ── selectGoalsAccumulator ───────────────────────────────────────────────────

describe("selectGoalsAccumulator", () => {
  it("ranks legs by mp desc and counts markets", () => {
    const detailByKey = detailMap([
      ["A", "B", richDetail()],
      ["C", "D", thinDetail()],
    ]);
    // Staggered kickoffs (>3h apart) — different leagues already imply rho=0,
    // but staggering here too keeps this test about ranking/counting, not
    // correlation rejection (covered separately below).
    // C-D uses thinDetail (completeness 0.5 → required edge 0.10), so give its
    // Over 1.5 a 0.12 edge to clear the haircut; A-B is richDetail (full bar).
    const jobs = [
      okJob("A", "B", [evm("Over 2.5", 0.82, 0.77)], "Premier League", "2026-06-15T12:00:00Z"),
      okJob("C", "D", [evm("Over 1.5", 0.9, 0.78)], "La Liga", "2026-06-15T19:00:00Z"),
    ];
    const res = selectGoalsAccumulator(jobs, { detailByKey });
    expect(res.legs.map((l) => l.side)).toEqual(["Over 1.5", "Over 2.5"]);
    expect(res.counts).toEqual({ over15: 1, over25: 1, teamOver05: 0 });
    expect(res.qualified).toBe(2);
  });

  it("caps at target as a CEILING (does not relax to fill)", () => {
    const detailByKey = detailMap([
      ["A", "B", richDetail()],
      ["C", "D", richDetail()],
      ["E", "F", richDetail()],
    ]);
    const jobs = [
      okJob("A", "B", [evm("Over 1.5", 0.95, 0.9)], "Premier League", "2026-06-15T12:00:00Z"),
      okJob("C", "D", [evm("Over 1.5", 0.9, 0.85)], "La Liga", "2026-06-15T15:00:00Z"),
      okJob("E", "F", [evm("Over 1.5", 0.85, 0.8)], "Bundesliga", "2026-06-15T19:00:00Z"),
    ];
    const res = selectGoalsAccumulator(jobs, { detailByKey, target: 2 });
    expect(res.legs).toHaveLength(2);
    expect(res.qualified).toBe(3); // all qualified, but only 2 fit the ceiling
    expect(res.legs.map((l) => l.mp)).toEqual([0.95, 0.9]); // top-2 by mp
  });

  it("rejects a third same-league, same-kickoff-window leg as overly correlated", () => {
    const detailByKey = detailMap([
      ["A", "B", richDetail()],
      ["C", "D", richDetail()],
      ["E", "F", richDetail()],
    ]);
    // All three same league, all within a 3h kickoff window — pairwise rho=0.35,
    // above CROSS_FIXTURE_CORRELATION_REJECT (0.3). Greedy admission should
    // still take the top-ranked leg, then reject same-cluster legs even though
    // target has room for all three.
    const jobs = [
      okJob("A", "B", [evm("Over 1.5", 0.95, 0.9)], "Premier League", "2026-06-15T15:00:00Z"),
      okJob("C", "D", [evm("Over 1.5", 0.9, 0.85)], "Premier League", "2026-06-15T15:30:00Z"),
      okJob("E", "F", [evm("Over 1.5", 0.85, 0.8)], "Premier League", "2026-06-15T16:00:00Z"),
    ];
    const res = selectGoalsAccumulator(jobs, { detailByKey, target: 10 });
    expect(res.qualified).toBe(3);
    expect(res.legs.length).toBeLessThan(3);
    expect(res.legs[0]?.home).toBe("A"); // highest mp always admitted first
  });

  it("returns fewer than target when fewer qualify (no dilution)", () => {
    const detailByKey = detailMap([["A", "B", richDetail()]]);
    const jobs = [
      okJob("A", "B", [evm("Over 1.5", 0.9, 0.85)]),
      okJob("C", "D", [evm("Over 1.5", 0.5, 0.45)]), // below bar, no detail
    ];
    const res = selectGoalsAccumulator(jobs, { detailByKey, target: 39 });
    expect(res.legs).toHaveLength(1);
    expect(res.analysed).toBe(2);
  });

  it("target 0 yields no legs but still reports all qualifiers", () => {
    const detailByKey = detailMap([["A", "B", richDetail()]]);
    const jobs = [okJob("A", "B", [evm("Over 1.5", 0.95, 0.9)])];
    const res = selectGoalsAccumulator(jobs, { detailByKey, target: 0 });
    expect(res.legs).toHaveLength(0);
    expect(res.qualified).toBe(1);
  });

  describe("short slip sizing", () => {
    // Distinct teams/leagues/kickoffs per fixture so cross-fixture correlation
    // never interferes with these sizing-only assertions.
    function manyFixtures(n: number, mpStart: number, mpStep: number) {
      const leagues = ["Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1"];
      const detailEntries: Array<[string, string, SportyBetEventDetail]> = [];
      const jobs: BatchJobResult[] = [];
      for (let i = 0; i < n; i++) {
        const home = `H${i}`;
        const away = `A${i}`;
        detailEntries.push([home, away, richDetail()]);
        const mp = Math.max(0.1, mpStart - i * mpStep);
        jobs.push(
          okJob(
            home,
            away,
            [evm("Over 1.5", mp, mp - 0.05)],
            leagues[i % leagues.length],
            new Date(Date.UTC(2026, 5, 15, i, 0, 0)).toISOString()
          )
        );
      }
      return { detailByKey: detailMap(detailEntries), jobs };
    }

    it("stays within the normal 4-9 ceiling when fewer than 10 extra high-confidence candidates exist", () => {
      // 12 candidates, mp descending from 0.95 — only ~3 clear the 0.82 high-
      // confidence bar beyond the 9th, well under the FLEX_TRIGGER of 10.
      const { detailByKey, jobs } = manyFixtures(12, 0.95, 0.02);
      const res = selectGoalsAccumulator(jobs, { detailByKey, target: 39 });
      expect(res.shortSlipLegs.length).toBeLessThanOrEqual(9);
      expect(res.shortSlipLegs.length).toBeGreaterThanOrEqual(4);
    });

    it("flexes the short slip past 9 when >=10 candidates beyond the ceiling clear the high-confidence bar", () => {
      // 25 candidates, mp flat at 0.95 (all clear SHORT_SLIP_HIGH_CONFIDENCE_MP
      // of 0.82) — comfortably >=10 beyond the normal 9-leg ceiling.
      const { detailByKey, jobs } = manyFixtures(25, 0.95, 0.001);
      const res = selectGoalsAccumulator(jobs, { detailByKey, target: 39 });
      expect(res.shortSlipLegs.length).toBeGreaterThan(9);
    });

    it("flex path scales past the 15-candidate combinatorial-search ceiling via the greedy fallback", () => {
      // 30 candidates all clearing the high-confidence bar — flexed cap (30)
      // exceeds SHORT_SLIP_SEARCH_POOL (15), so buildShortSlip must use the
      // greedy correlation-aware path, not silently truncate at 15.
      const { detailByKey, jobs } = manyFixtures(30, 0.95, 0.001);
      const res = selectGoalsAccumulator(jobs, { detailByKey, target: 39 });
      expect(res.shortSlipLegs.length).toBeGreaterThan(15);
    });

    it("short slip never includes more legs than qualified", () => {
      const { detailByKey, jobs } = manyFixtures(3, 0.9, 0.05);
      const res = selectGoalsAccumulator(jobs, { detailByKey, target: 39 });
      expect(res.shortSlipLegs.length).toBeLessThanOrEqual(res.qualified);
    });

    it("flex cap never exceeds `target` — the short ('top picks') slip must never outgrow the long ('lottery') slip", () => {
      // 50 candidates all clearing the high-confidence bar would flex the short
      // slip cap to 50 uncapped — but target=10 here, so the short slip must be
      // bounded at 10, never larger than the long slip's own ceiling.
      const { detailByKey, jobs } = manyFixtures(50, 0.95, 0.0005);
      const res = selectGoalsAccumulator(jobs, { detailByKey, target: 10 });
      expect(res.shortSlipLegs.length).toBeLessThanOrEqual(10);
      expect(res.shortSlipLegs.length).toBeLessThanOrEqual(res.legs.length || 10);
    });
  });

  describe("mini-ACCA kickoff-gap (audit fix: was v3-only, now unconditional)", () => {
    it("rejects a same-kickoff-window leg even though it's a different league, in legacy (non-v3) mode", () => {
      const detailByKey = detailMap([
        ["A", "B", richDetail()],
        ["C", "D", richDetail()],
        ["E", "F", richDetail()],
      ]);
      const jobs = [
        // Highest edge (mp-ip=0.15), kicks off 15:00.
        okJob("A", "B", [evm("Over 1.5", 0.9, 0.75)], "Premier League", "2026-06-15T15:00:00Z"),
        // 2nd-highest edge (0.10), DIFFERENT league, but only 1h after A-B —
        // must NOT both land in the mini-ACCA now that the gap is
        // unconditional. Before this fix (gap=0 in non-v3 mode),
        // computeMiniAccaStats's jointProb() would then see a real non-zero
        // cross-league same-window correlation (pairwiseCrossFixtureCorrelation's
        // SAME_WINDOW_BONUS is NOT conditional on same-league) and inflate
        // miniAccaCombinedProb above the independent product it's supposed
        // to represent.
        okJob("C", "D", [evm("Over 1.5", 0.85, 0.75)], "La Liga", "2026-06-15T16:00:00Z"),
        // 3rd-highest edge (0.05), DIFFERENT league AND >3h clear of A-B —
        // should fill the 2nd mini-ACCA slot instead.
        okJob("E", "F", [evm("Over 1.5", 0.8, 0.75)], "Bundesliga", "2026-06-15T20:00:00Z"),
      ];
      const res = selectGoalsAccumulator(jobs, { detailByKey });
      const miniAccaFixtures = res.miniAccaLegs.map((l) => `${l.home}-${l.away}`);
      expect(miniAccaFixtures).toContain("A-B");
      expect(miniAccaFixtures).not.toContain("C-D"); // clashes with A-B's kickoff window
      expect(miniAccaFixtures).toContain("E-F"); // clear window, different league — admitted instead
    });
  });
});

describe("GOALS_MARKETS", () => {
  it("contains exactly the four allowed labels", () => {
    expect([...GOALS_MARKETS].sort()).toEqual(
      ["Away Total Over 0.5", "Home Total Over 0.5", "Over 1.5", "Over 2.5"].sort()
    );
  });
});
