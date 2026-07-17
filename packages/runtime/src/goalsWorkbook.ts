/** goals-market-analysis-prompt-v3 — the LLM-readable workbook (.xlsx) for the
 *  daily goals batch. Complements the fixture-wide workbook (fixtureWorkbook.ts,
 *  sent at 09:30 WAT) with the FULL v3 analysis trail: every market assessed
 *  (done, discarded, capped, noise), the five delivered slips, and the §4.4
 *  capped-selection transparency log — plus a machine-readable schema/
 *  methodology sheet and a JSON mirror of the goals artifact, so an LLM handed
 *  this file can recompute and verify every number without re-deriving the
 *  pipeline from scratch.
 *
 *  xlsx, not xlsm: xlsx's XML structure is what's actually machine-parseable;
 *  VBA macros are an opaque blob to any LLM/exceljs consumer and get flagged by
 *  AV/chat-platform scanners for no benefit (researched decision — see the
 *  goals-v3 plan's Phase I). "Embedded scripts for LLM analysis" is realised as
 *  the LLM_README sheet below, not executable code. */
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { V3FixtureResult } from "@oracle/engine";
import ExcelJS from "exceljs";
import type { GoalsLeg, GoalsSelectionResult } from "./selectGoals.js";

/** Neutralizes CSV/XLSX formula injection (CWE-1236) — same guard as
 *  fixtureWorkbook.ts's sanitizeCell, duplicated rather than imported so this
 *  module has no cross-file coupling on a private helper. */
function sanitizeCell<T>(v: T): T {
  if (typeof v !== "string" || v.length === 0) return v;
  return (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v) as unknown as T;
}

const pct = (v: number | null | undefined) => (v == null ? null : Math.round(v * 1000) / 10);

export interface CappedLogEntry {
  home: string;
  away: string;
  league: string;
  label: string;
  rawEdge: number;
  rationale: string;
}

export interface GoalsWorkbookInput {
  selection: GoalsSelectionResult;
  results: V3FixtureResult[];
  capped: CappedLogEntry[];
  date: string;
  arbiterStatus: "verified" | "unverified";
}

const README_ROWS: Array<[string, string]> = [
  [
    "Sheet: Analysis",
    "One row per (fixture × market) assessed — every candidate the §4 gate saw, DONE and discarded alike.",
  ],
  ["  home / away / league / kickoff", "Fixture identity."],
  [
    "  lambdaHome / lambdaAway / mu",
    "§3.1 expected goals per side and total (Dixon-Coles-corrected joint matrix).",
  ],
  ["  lambdaMethod", '"multiplicative" (attack×defence×league) or "simple-average" fallback.'],
  [
    "  shrunk / xgBlended",
    "Whether §3.1 small-sample shrinkage (n<8) or the 50/50 xG blend moved lambda.",
  ],
  [
    "  matchShapeS / matchShapeSource",
    '§3.5 home-goal-share used for BTTS/team-totals; "odds" = grid-searched against de-vigged 1X2, "ratio" = goals-model fallback.',
  ],
  ["  market / label", 'EVMarket cat/label — e.g. "Goals O/U" / "Over 2.5".'],
  ["  odds / modelP", "Priced decimal odds and the v3 model probability for that outcome."],
  [
    "  q / devigged",
    "§4.1 implied probability and whether it came from a de-vigged two-sided book.",
  ],
  [
    "  rawEdge / penaltyPts / adjustedEdge",
    "§4.2: rawEdge = modelP − q; adjustedEdge = rawEdge − penaltyPts (see the penalty table below).",
  ],
  ["  tier", "§4.3 confidence tier on adjustedEdge: very_high ≥10pts, high ≥7pts, medium ≥5pts."],
  [
    "  outcome",
    "done (entered a slip pool) / below_edge (adjustedEdge<5pts) / noise (|rawEdge|≤2pts) / capped (rawEdge>12pts, §4.4 — never bet).",
  ],
  ["  completeness", "§0.3 weighted data-completeness score (0–100) behind this fixture's inputs."],
  ["  rationale", "One-line §6 rationale naming data sources and limitations."],
  ["", ""],
  ["Sheet: Slips", "One row per leg in each of the five delivered outputs."],
  [
    "  slip",
    "TOP PICKS / 39-LEG LOTTERY / MINI-ACCA / OUTPUT B (odds≥4.00) / OUTPUT C (2.50-3.99).",
  ],
  [
    "  market/odds/modelP/impliedP/adjustedEdge/tier/rationale",
    "Same meaning as the Analysis sheet, for the specific leg selected onto this slip.",
  ],
  [
    "  arbiterFlag",
    "Set when the single slate-level LLM review flagged (but did not drop) this leg — see README row on the slate arbiter below.",
  ],
  ["", ""],
  [
    "Sheet: Capped",
    '§4.4 transparency log — selections auto-discarded for rawEdge > 12pts ("model too hot to trust"). Logged, never bet.',
  ],
  ["", ""],
  [
    "Sheet: META_JSON",
    "Single cell holding the exact JSON goals artifact (.tmp/goals/goals-{date}.json) this workbook was generated from — the canonical machine-parseable source; every other sheet is a denormalised view of this JSON for human/LLM readability.",
  ],
  ["", ""],
  ["Methodology — v3 pipeline", ""],
  [
    "  1. Eligibility",
    'Union whitelist (v3 spec §1.1 ∪ researched goals-rich leagues) + hard discards (SRL/virtual, missing mandatory odds). Youth/women/friendly/cup-final/low-scoring-derby are "heightened" — a higher completeness bar is checked (≥85), not discarded.',
  ],
  [
    "  2. Completeness (sidecar contract: annotated, never gates)",
    "Weighted 0–100 score (odds 15, form 15, scored/90 15, conceded/90 15, O/U hit-rate 10 = 70 mandatory; xG 10, H2H 10, lineups 5, rest 5 = 30 optional). A fixture below the floor (<70, or <85 when heightened) or missing a mandatory field is NOT discarded — every fixture that clears Phase 1 eligibility reaches analysis; thin data is instead recorded as an annotation and handled by the edge gate's own penalty points below (the sidecar's data-richness never decides candidacy).",
  ],
  [
    "  3. Lambda",
    "λ_home = (H_scored/90 ÷ L) × (A_conceded/90 ÷ L) × L, L = league goals per team per game. n<8 shrinks toward the league mean. Optional 50/50 blend with an xG-derived λ (venue-split preferred over season aggregate).",
  ],
  [
    "  4. Matrix",
    "Dixon-Coles-corrected joint Poisson matrix on λ_home/λ_away for O/U; a SECOND matrix on the de-vigged-1X2 match-shape split for BTTS/team totals (independent-Poisson overstates underdog scoring in lopsided matches otherwise).",
  ],
  [
    "  5. Edge gate",
    "rawEdge = modelP − devigged-implied-prob. adjustedEdge = rawEdge − penalties (xG missing −2pts, xG AI-estimated −1pt, H2H missing −1pt, lineups unconfirmed −1pt, rest estimated −1pt, <5-game sample −2pts). Noise gate discards |rawEdge|≤2pts. Cap discards rawEdge>12pts pre-penalty (logged to the Capped sheet, never bet — the fallback tries the fixture's next-best market under the cap). Tier on adjustedEdge: ≥10 very_high, ≥7 high, ≥5 medium, else discard.",
  ],
  [
    "  6. Slate arbiter",
    'ONE local-LLM call reviews the assembled selection (not per-fixture) for dead rubbers, motivation, and news contradictions the deterministic gates can\'t see. Can drop or flag a leg; never adds one. Fail-open: on any timeout/parse failure the slate is delivered unchanged and arbiterStatus="unverified".',
  ],
  ["", ""],
  ["How to analyse this file (for an LLM reader)", ""],
  [
    "  1",
    "Read META_JSON for the exact machine-readable selection; use Analysis/Slips/Capped as human-readable cross-checks of the same numbers.",
  ],
  [
    "  2",
    "To verify a leg's edge: q = Slips.impliedP (or recompute from Analysis.odds via the de-vig formula above); rawEdge = Slips.modelP − q; adjustedEdge should equal rawEdge minus the penalty points implied by Analysis.rationale's stated limitations.",
  ],
  [
    "  3",
    'Treat Capped rows as "the model was too confident to trust", not as missed opportunities — they were never bet by design.',
  ],
  [
    "  4",
    "A leg with arbiterFlag set survived the slate review but was called out — weight it more cautiously than an unflagged leg of the same tier.",
  ],
];

/** Build the in-memory workbook. Pure function — callers write/serialize it. */
export function renderGoalsWorkbook(input: GoalsWorkbookInput): ExcelJS.Workbook {
  const { selection, results, capped, date, arbiterStatus } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = "ORACLE";
  wb.created = new Date();
  wb.title = `ORACLE Goals v3 — ${date}`;

  // ── LLM_README ─────────────────────────────────────────────────────────────
  const readme = wb.addWorksheet("LLM_README");
  readme.columns = [
    { header: "Topic", width: 34 },
    { header: "Explanation", width: 120 },
  ];
  readme.getRow(1).font = { bold: true };
  readme.addRow(["Generated", `${date} — arbiterStatus=${arbiterStatus}`]);
  readme.addRow(["", ""]);
  for (const [topic, explanation] of README_ROWS) {
    readme.addRow([sanitizeCell(topic), sanitizeCell(explanation)]);
  }

  // ── Analysis ───────────────────────────────────────────────────────────────
  const an = wb.addWorksheet("Analysis", { views: [{ state: "frozen", ySplit: 1 }] });
  an.columns = [
    { header: "Home", width: 20 },
    { header: "Away", width: 20 },
    { header: "League", width: 20 },
    { header: "Kickoff (UTC)", width: 18 },
    { header: "lambdaHome", width: 12 },
    { header: "lambdaAway", width: 12 },
    { header: "mu", width: 10 },
    { header: "lambdaMethod", width: 16 },
    { header: "shrunk", width: 9 },
    { header: "xgBlended", width: 10 },
    { header: "matchShapeS", width: 12 },
    { header: "matchShapeSource", width: 14 },
    { header: "market", width: 16 },
    { header: "label", width: 20 },
    { header: "odds", width: 8 },
    { header: "modelP %", width: 10 },
    { header: "q %", width: 8 },
    { header: "devigged", width: 10 },
    { header: "rawEdge pts", width: 12 },
    { header: "penaltyPts pts", width: 13 },
    { header: "adjustedEdge pts", width: 15 },
    { header: "tier", width: 11 },
    { header: "outcome", width: 12 },
    { header: "completeness", width: 12 },
    { header: "rationale", width: 60 },
  ];
  an.getRow(1).font = { bold: true };
  for (const r of results) {
    const j = r.job;
    for (const a of r.assessments) {
      an.addRow(
        [
          j.home,
          j.away,
          j.league,
          j.kickoff,
          r.lambdas.lambdaHome,
          r.lambdas.lambdaAway,
          r.lambdas.mu,
          r.lambdas.method,
          r.lambdas.shrunk ? "yes" : "",
          r.lambdas.xgBlended ? "yes" : "",
          r.shape.s,
          r.shape.source,
          a.cat,
          a.label,
          a.odds,
          pct(a.mp),
          pct(a.q),
          a.devigged ? "yes" : "",
          Math.round(a.rawEdge * 1000) / 10,
          Math.round(a.penaltyPts * 1000) / 10,
          Math.round(a.adjustedEdge * 1000) / 10,
          a.tier ?? "",
          a.outcome,
          j.status === "ok" ? Math.round(r.lambdas.leaguePerTeamAvg * 100) / 100 : null,
          a.rationale,
        ].map((v) => sanitizeCell(v ?? null))
      );
    }
  }
  an.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: an.columns.length } };

  // ── Slips ──────────────────────────────────────────────────────────────────
  const sl = wb.addWorksheet("Slips", { views: [{ state: "frozen", ySplit: 1 }] });
  sl.columns = [
    { header: "Slip", width: 30 },
    { header: "Home", width: 20 },
    { header: "Away", width: 20 },
    { header: "League", width: 20 },
    { header: "Kickoff", width: 18 },
    { header: "Market", width: 24 },
    { header: "Odds", width: 8 },
    { header: "modelP %", width: 10 },
    { header: "impliedP %", width: 11 },
    { header: "adjustedEdge pts", width: 15 },
    { header: "Tier", width: 11 },
    { header: "arbiterFlag", width: 16 },
    { header: "Rationale", width: 60 },
  ];
  sl.getRow(1).font = { bold: true };
  const addSlip = (tag: string, legs: GoalsLeg[]) => {
    for (const l of legs) {
      sl.addRow(
        [
          tag,
          l.home,
          l.away,
          l.league,
          l.kickoff,
          l.side,
          l.odds,
          pct(l.mp),
          pct(l.ip),
          l.adjustedEdge != null ? Math.round(l.adjustedEdge * 1000) / 10 : null,
          l.tier ?? "",
          l.arbiterFlag ?? "",
          l.rationale ?? "",
        ].map((v) => sanitizeCell(v ?? null))
      );
    }
  };
  addSlip("TOP PICKS", selection.shortSlipLegs);
  addSlip("39-LEG LOTTERY", selection.legs);
  addSlip("MINI-ACCA", selection.miniAccaLegs);
  addSlip("OUTPUT B (odds >= 4.00)", selection.outputBLegs);
  addSlip("OUTPUT C (2.50-3.99)", selection.outputCLegs);
  sl.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sl.columns.length } };

  // ── Capped ─────────────────────────────────────────────────────────────────
  const cp = wb.addWorksheet("Capped", { views: [{ state: "frozen", ySplit: 1 }] });
  cp.columns = [
    { header: "Home", width: 20 },
    { header: "Away", width: 20 },
    { header: "League", width: 20 },
    { header: "Label", width: 22 },
    { header: "rawEdge pts", width: 12 },
    { header: "Rationale", width: 70 },
  ];
  cp.getRow(1).font = { bold: true };
  for (const c of capped) {
    cp.addRow(
      [c.home, c.away, c.league, c.label, Math.round(c.rawEdge * 1000) / 10, c.rationale].map((v) =>
        sanitizeCell(v ?? null)
      )
    );
  }

  // ── META_JSON ──────────────────────────────────────────────────────────────
  const mj = wb.addWorksheet("META_JSON");
  mj.getColumn(1).width = 200;
  mj.getCell("A1").value = sanitizeCell(
    JSON.stringify(
      { date, generatedAt: new Date().toISOString(), arbiterStatus, selection },
      null,
      2
    )
  );
  mj.getCell("A1").alignment = { wrapText: false, vertical: "top" };

  return wb;
}

/** Same primary-then-timestamp-suffixed collision pattern as
 *  fixtureWorkbook.ts's writeFixtureWorkbook. */
export async function writeGoalsWorkbook(
  wb: ExcelJS.Workbook,
  date: string,
  outDir = ".tmp/reports"
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const primary = join(outDir, `oracle-goals-${date}.xlsx`);
  let outPath = primary;
  try {
    await access(primary);
    outPath = join(outDir, `oracle-goals-${date}-${Date.now()}.xlsx`);
  } catch {
    // Primary does not exist — claim it
  }
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/** One-call render-and-write for the worker's runGoalsBatchV3 tail. */
export async function generateAndWriteGoalsWorkbook(
  input: GoalsWorkbookInput,
  outDir = ".tmp/reports"
): Promise<string> {
  const wb = renderGoalsWorkbook(input);
  return writeGoalsWorkbook(wb, input.date, outDir);
}
