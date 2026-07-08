/** PR-23 review-fix regression: logPickDisagreement (the SkillOpt training
 *  signal) must compare the LLM's primary pick against the TRUE top-EV
 *  candidate, not effectiveEligible[0] — array position only implied EV
 *  rank in "full" LLM-executor scope. Under "unmapped" scope,
 *  decision/index.ts splices the executor's candidate into eligibleBets[0]
 *  regardless of its own EV rank (see decision.test.ts's "splices the
 *  executor pick into effectiveEligible instead of forcing the draft"
 *  test for that half). This file isolates its own mock of decide() in a
 *  dedicated file — a file-scoped vi.mock("../src/decision/index.js")
 *  would otherwise apply to every test in batch.test.ts, most of which
 *  depend on the real decide() implementation. */
import { MemoryAdapter, STORAGE_KEYS } from "@oracle/storage";
import { describe, expect, it, vi } from "vitest";
import type { RunResult } from "../src/types.js";

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));

vi.mock("../src/decision/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/decision/index.js")>();
  return { ...actual, decide: decideMock };
});

const { parseFixtureList, runBatch } = await import("../src/batch/index.js");
const { ExecutionEngine } = await import("../src/execution/index.js");

const RUN_ID = Date.now().toString(36);
const config = { geminiApiKey: "", claudeApiKey: "", bankroll: 1000 };

describe("logPickDisagreement — compares against the true top-EV pick, not array index 0", () => {
  it("does not log a false LLM_DISAGREE when a low-EV candidate is spliced at eligibleBets[0]", async () => {
    const storage = new MemoryAdapter(`.tmp/evsort-disagree-${RUN_ID}`);
    const mockResult: RunResult = {
      fp: { home: 0.45, draw: 0.28, away: 0.27 },
      evMarkets: [
        {
          cat: "Goals O/U",
          label: "Over 2.5",
          market: "Goals O/U",
          side: "Over 2.5",
          mp: 0.55,
          modelProb: 0.55,
          ip: 0.48,
          rawEdge: 0.07,
          ev: 0.07,
          odds: 2.1,
          stake: 0.03,
          stakeAmt: 30,
          rankingScore: 0.6,
          varianceMod: 1.0,
        },
      ],
      oddsAvailable: true,
      bayesian_lH: 1.5,
      bayesian_lA: 1.2,
      expectedScoreline: "1-1",
      portfolioCorrelation: null,
      correlatedParlayRisk: null,
    };
    const runSpy = vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(mockResult);

    // "unmapped"-scope shape: a low-EV executor candidate spliced at index 0,
    // the genuinely higher-EV pre-existing candidate at index 1 — but the LLM's
    // primaryPick correctly names the HIGH-EV market. With the bug
    // (effectiveEligible[0]), this would be compared against the LOW-EV
    // executor market instead and wrongly logged as a disagreement.
    decideMock.mockResolvedValueOnce({
      decision: {
        primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
        confidence: 0.6,
        grade: "LEAN",
        rationale: "top pick",
        rejectedAndWhy: [],
      },
      replay: null,
      shadow: null,
      eligibleBets: [
        {
          cat: "Other",
          label: "Executor pick",
          market: "LLM Market Executor",
          side: "Executor pick",
          mp: 0.5,
          modelProb: 0.5,
          ip: 0.49,
          rawEdge: 0.01,
          ev: 0.01,
          odds: 2.0,
          stake: 0,
          stakeAmt: 0,
          rankingScore: 0.1,
          varianceMod: 1.0,
        },
        {
          cat: "Goals O/U",
          label: "Over 2.5",
          market: "Goals O/U",
          side: "Over 2.5",
          mp: 0.55,
          modelProb: 0.55,
          ip: 0.48,
          rawEdge: 0.07,
          ev: 0.07,
          odds: 2.1,
          stake: 0.03,
          stakeAmt: 30,
          rankingScore: 0.6,
          varianceMod: 1.0,
        },
      ],
    });

    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    await runBatch(jobs, { storage, config });

    const log =
      (await storage.get<Array<Record<string, unknown>>>(STORAGE_KEYS.decisionDisagreementLog)) ??
      [];
    expect(log.some((e) => e.type === "LLM_DISAGREE")).toBe(false);

    runSpy.mockRestore();
  }, 20_000); // CI observed >5s: vi.mock's importOriginal() loads decision/index.ts's real
  // module graph (this file is the ONLY one mocking it), and that one-time transform/eval
  // cost lands entirely on this file's single test instead of amortizing across many tests
  // the way batch.test.ts's 31 tests do. Consistently 800-1200ms locally across repeated
  // runs — not a hang, just cold-start cost a generous CI-safe timeout absorbs.
});
