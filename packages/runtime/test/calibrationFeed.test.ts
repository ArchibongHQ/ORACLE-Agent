import type { AnalysisRecord, BetRecord, EVMarket, ResolutionRecord } from "@oracle/engine";
import type { StoragePort } from "@oracle/storage";
import { _resetKeyLocks, STORAGE_KEYS } from "@oracle/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { appendResolvedToLedger, loadLedgerState, settlePick } from "../src/calibrationFeed.js";

// ── Minimal in-memory StoragePort — only get/set are exercised by calibrationFeed ──
class MockStore {
  private map = new Map<string, unknown>();
  throwOnGet = false;
  async get<T>(key: string): Promise<T | null> {
    if (this.throwOnGet) throw new Error("simulated PGlite corruption");
    return (this.map.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  seed(key: string, value: unknown): void {
    this.map.set(key, value);
  }
}

function mockStorage(m: MockStore): StoragePort {
  return m as unknown as StoragePort;
}

function pick(family: string, label: string, over: Partial<EVMarket> = {}): EVMarket {
  return {
    cat: "test",
    label,
    market: "test",
    family: family as EVMarket["family"],
    mp: 0.55,
    modelProb: 0.55,
    ip: 0.5,
    rawEdge: 0.05,
    ev: 0.1,
    odds: 2.0,
    stake: 0.02,
    stakeAmt: 20,
    rankingScore: 1,
    varianceMod: 1,
    ...over,
  };
}

describe("settlePick", () => {
  it("settles match_result home/draw/away", () => {
    expect(settlePick(pick("match_result", "Home"), 2, 0)).toBe("win");
    expect(settlePick(pick("match_result", "Home"), 0, 2)).toBe("loss");
    expect(settlePick(pick("match_result", "Draw"), 1, 1)).toBe("win");
    expect(settlePick(pick("match_result", "Away"), 0, 3)).toBe("win");
  });

  it("settles double_chance cover sets (word + compact forms)", () => {
    expect(settlePick(pick("double_chance", "Home/Draw"), 1, 1)).toBe("win"); // draw covered
    expect(settlePick(pick("double_chance", "Home/Draw"), 0, 2)).toBe("loss"); // away not covered
    expect(settlePick(pick("double_chance", "12"), 2, 1)).toBe("win"); // home/away, home won
    expect(settlePick(pick("double_chance", "X2"), 1, 1)).toBe("win"); // draw/away, draw
    expect(settlePick(pick("double_chance", "X2"), 3, 0)).toBe("loss"); // home not covered
  });

  it("settles dnb with push on draw", () => {
    expect(settlePick(pick("dnb", "Home"), 2, 0)).toBe("win");
    expect(settlePick(pick("dnb", "Home"), 1, 1)).toBe("push");
    expect(settlePick(pick("dnb", "Home"), 0, 1)).toBe("loss");
    expect(settlePick(pick("dnb", "Away"), 1, 1)).toBe("push");
  });

  it("settles goals_ou over/under with push on the line", () => {
    expect(settlePick(pick("goals_ou", "Over 2.5"), 2, 1)).toBe("win"); // total 3 > 2.5
    expect(settlePick(pick("goals_ou", "Over 2.5"), 1, 1)).toBe("loss"); // total 2 < 2.5
    expect(settlePick(pick("goals_ou", "Under 2.5"), 1, 0)).toBe("win");
    expect(settlePick(pick("goals_ou", "Over 2"), 1, 1)).toBe("push"); // integer line, total==2
  });

  it("settles team_total for the named side", () => {
    expect(settlePick(pick("team_total", "Home Over 1.5"), 2, 0)).toBe("win");
    expect(settlePick(pick("team_total", "Home Over 1.5"), 1, 3)).toBe("loss");
    expect(settlePick(pick("team_total", "Away Under 1.5"), 2, 1)).toBe("win");
  });

  it("settles btts yes/no", () => {
    expect(settlePick(pick("btts", "Yes"), 1, 1)).toBe("win");
    expect(settlePick(pick("btts", "Yes"), 2, 0)).toBe("loss");
    expect(settlePick(pick("btts", "No"), 2, 0)).toBe("win");
  });

  it("returns null for families it cannot settle from the 1x2 score", () => {
    expect(settlePick(pick("corners", "Over 9.5"), 3, 2)).toBeNull();
    expect(settlePick(pick("cards", "Over 4.5"), 3, 2)).toBeNull();
    expect(settlePick(pick("asian_handicap", "AH Home -0.5"), 2, 0)).toBeNull();
    expect(settlePick(pick("correct_score", "2-1"), 2, 1)).toBeNull();
  });

  it("returns null on ambiguous descs rather than guessing", () => {
    expect(settlePick(pick("double_chance", "combo"), 1, 1)).toBeNull(); // no 2 outcomes named
    expect(settlePick(pick("goals_ou", "Over/Under"), 2, 1)).toBeNull(); // no direction
  });
});

// ── Fixtures for the append path ──────────────────────────────────────────────
function analysisRecord(id: string, topPick: EVMarket): AnalysisRecord {
  return {
    analysisId: id,
    runId: "run1",
    schemaVersion: 1,
    calibrationSnapshotId: "calib_test",
    fixtureId: id,
    home: "Home FC",
    away: "Away FC",
    league: "Premier League",
    kickoff: "2026-07-01T15:00:00.000Z",
    lambdaH: 1.5,
    lambdaA: 1.1,
    probabilities: { home: 0.5, draw: 0.25, away: 0.25 },
    regime: "STANDARD",
    rankingMode: "CONFIDENCE_WEIGHTED",
    liquidityTag: "CALIBRATION_ONLY",
    evMarkets: [],
    llmPick: null,
    deterministicTopPick: topPick,
    decisionReplay: null,
    frozenOddsAtAnalysis: null,
    analysedAt: "2026-07-01T09:00:00.000Z",
  };
}

function resolution(fixtureId: string, hg: number, ag: number): ResolutionRecord {
  return {
    fixtureId,
    runId: "resolve1",
    schemaVersion: 1,
    actualResult: hg > ag ? "home" : hg < ag ? "away" : "draw",
    homeGoals: hg,
    awayGoals: ag,
    realisedCLV: null,
    clvSourceQuality: "UNKNOWN",
    rpsContribution: 0,
    drawCalibrationPoint: null,
    resolvedAt: "2026-07-02T10:00:00.000Z",
  };
}

describe("appendResolvedToLedger", () => {
  beforeEach(() => _resetKeyLocks());

  it("settles resolvable picks and writes them to the ledger", async () => {
    const store = new MockStore();
    const records = [
      analysisRecord("f1", pick("goals_ou", "Over 2.5")),
      analysisRecord("f2", pick("match_result", "Home")),
      analysisRecord("f3", pick("corners", "Over 9.5")), // unsettleable → skipped
    ];
    const resolved = [resolution("f1", 2, 1), resolution("f2", 0, 2), resolution("f3", 3, 3)];

    const { appended, skipped, metrics } = await appendResolvedToLedger(
      mockStorage(store),
      resolved,
      records
    );
    expect(appended).toBe(2);
    expect(skipped).toBe(1);
    expect(metrics.resolvedCount).toBe(2);

    const ledger = (await store.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger))!;
    expect(ledger).toHaveLength(2);
    expect(ledger.find((b) => b.id === "f1")!.outcome).toBe("win"); // Over 2.5 hit
    expect(ledger.find((b) => b.id === "f2")!.outcome).toBe("loss"); // Home lost
  });

  it("is idempotent on re-resolve (id = analysisId, upsert not duplicate)", async () => {
    const store = new MockStore();
    const records = [analysisRecord("f1", pick("goals_ou", "Over 2.5"))];
    await appendResolvedToLedger(mockStorage(store), [resolution("f1", 2, 1)], records);
    await appendResolvedToLedger(mockStorage(store), [resolution("f1", 2, 1)], records);
    const ledger = (await store.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger))!;
    expect(ledger).toHaveLength(1);
  });

  it("prunes the ledger to maxLedger, keeping the most recent", async () => {
    const store = new MockStore();
    // seed 3 pre-existing bets
    store.seed(STORAGE_KEYS.calibrationLedger, [
      { id: "old1", status: "resolved", outcome: "win" },
      { id: "old2", status: "resolved", outcome: "loss" },
      { id: "old3", status: "resolved", outcome: "win" },
    ]);
    const records = [analysisRecord("new1", pick("match_result", "Home"))];
    await appendResolvedToLedger(mockStorage(store), [resolution("new1", 2, 0)], records, {
      maxLedger: 2,
    });
    const ledger = (await store.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger))!;
    expect(ledger).toHaveLength(2);
    expect(ledger[ledger.length - 1]!.id).toBe("new1"); // newest retained
  });
});

describe("loadLedgerState (read side, fail-open)", () => {
  it("returns null when the ledger read throws (corruption) — engine keeps calibFactor 1.0", async () => {
    const store = new MockStore();
    store.throwOnGet = true;
    expect(await loadLedgerState(mockStorage(store))).toBeNull();
  });

  it("returns null when the stored ledger is not an array", async () => {
    const store = new MockStore();
    store.seed(STORAGE_KEYS.calibrationLedger, { corrupt: true });
    expect(await loadLedgerState(mockStorage(store))).toBeNull();
  });

  it("returns bets + metrics for a valid ledger", async () => {
    const store = new MockStore();
    const records = [analysisRecord("f1", pick("match_result", "Home"))];
    await appendResolvedToLedger(mockStorage(store), [resolution("f1", 2, 0)], records);
    const state = await loadLedgerState(mockStorage(store));
    expect(state).not.toBeNull();
    expect(state!.bets).toHaveLength(1);
    expect(state!.metrics.resolvedCount).toBe(1);
  });
});
