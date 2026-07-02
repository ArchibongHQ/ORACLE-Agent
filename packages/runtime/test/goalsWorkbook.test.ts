import { describe, expect, it } from "vitest";
import { renderGoalsWorkbook } from "../src/goalsWorkbook.js";
import type { GoalsLeg, GoalsSelectionResult } from "../src/selectGoals.js";

function leg(overrides: Partial<GoalsLeg> = {}): GoalsLeg {
  return {
    home: "=cmd|'/c calc'!A1", // formula-injection probe (CWE-1236)
    away: "Away FC",
    league: "Premier League",
    kickoff: "2026-08-01T15:00:00Z",
    market: "Goals O/U",
    side: "Over 2.5",
    odds: 1.9,
    mp: 0.6,
    ip: 0.5,
    edge: 0.1,
    adjustedEdge: 0.08,
    tier: "high",
    rationale: "test rationale",
    sources: ["sportybet-gismo"],
    ...overrides,
  };
}

function emptySelection(): GoalsSelectionResult {
  return {
    legs: [],
    shortSlipLegs: [],
    target: 39,
    analysed: 0,
    qualified: 0,
    counts: { over15: 0, over25: 0, teamOver05: 0 },
    combinedProb: 0,
    combinedOdds: 1,
    shortSlipCombinedProb: 0,
    shortSlipCombinedOdds: 1,
    outputBLegs: [],
    outputCLegs: [],
    miniAccaLegs: [],
    miniAccaCombinedProb: 0,
    miniAccaCombinedOdds: 1,
  };
}

describe("renderGoalsWorkbook", () => {
  it("creates the five documented sheets", () => {
    const wb = renderGoalsWorkbook({
      selection: emptySelection(),
      results: [],
      capped: [],
      date: "2026-08-01",
      arbiterStatus: "verified",
    });
    const names = wb.worksheets.map((s) => s.name);
    expect(names).toEqual(["LLM_README", "Analysis", "Slips", "Capped", "META_JSON"]);
  });

  it("neutralizes formula-injection in leg text fields (CWE-1236)", () => {
    const selection = { ...emptySelection(), shortSlipLegs: [leg()] };
    const wb = renderGoalsWorkbook({
      selection,
      results: [],
      capped: [],
      date: "2026-08-01",
      arbiterStatus: "verified",
    });
    const slips = wb.getWorksheet("Slips")!;
    const homeCell = slips.getRow(2).getCell(2).value as string;
    expect(homeCell.startsWith("'=")).toBe(true);
  });

  it("neutralizes formula-injection in the Capped sheet", () => {
    const wb = renderGoalsWorkbook({
      selection: emptySelection(),
      results: [],
      capped: [
        {
          home: "+SUM(1,2)",
          away: "Away FC",
          league: "Premier League",
          label: "Over 2.5",
          rawEdge: 0.15,
          rationale: "too hot",
        },
      ],
      date: "2026-08-01",
      arbiterStatus: "verified",
    });
    const capped = wb.getWorksheet("Capped")!;
    const homeCell = capped.getRow(2).getCell(1).value as string;
    expect(homeCell.startsWith("'+")).toBe(true);
  });

  it("META_JSON round-trips the exact selection passed in", () => {
    const selection = { ...emptySelection(), shortSlipLegs: [leg({ home: "Clean Home FC" })] };
    const wb = renderGoalsWorkbook({
      selection,
      results: [],
      capped: [],
      date: "2026-08-01",
      arbiterStatus: "unverified",
    });
    const raw = wb.getWorksheet("META_JSON")!.getCell("A1").value as string;
    const parsed = JSON.parse(raw);
    expect(parsed.selection.shortSlipLegs[0].home).toBe("Clean Home FC");
    expect(parsed.arbiterStatus).toBe("unverified");
    expect(parsed.date).toBe("2026-08-01");
  });
});
