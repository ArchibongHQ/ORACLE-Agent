/** Notifier contract + the BatchSummary every channel renders. */
import type { BatchJobResult, BatchResult } from "@oracle/engine";

export interface ActionablePick {
  home: string;
  away: string;
  league: string;
  kickoff: string;
  market: string;
  side: string | null;
  odds: number;
  stakePct: number;
  confidence: number;
  /** Model edge (mp − ip) — present on goals-accumulator legs, undefined on
   *  main-batch picks (which use Kelly stake sizing instead). */
  edge?: number;
  /** SportyBet/Sportradar event ID (e.g. "sr:match:66456926") — lets the booking
   *  agent navigate directly to the fixture detail page rather than scanning the
   *  paginated listing DOM, which only renders currently-visible fixtures. */
  eventId?: string;
}

export interface BatchSummary {
  date: string;
  analysed: number;
  actionableCount: number;
  errors: number;
  actionable: ActionablePick[];
  reportUrl?: string;
  bookingCode?: string;
  bookingLoadUrl?: string;
  bookingUnmatched?: ActionablePick[];
  bookingError?: string;
  /** Standalone operational alert (e.g. "worker daemon silent for 40h") — rendered
   *  as a leading banner line ahead of the usual pick summary when present. Used for
   *  out-of-band warnings that aren't tied to a specific batch run. */
  alertText?: string;
  /** Correlation-adjusted joint win probability for the full accumulator slip
   *  (Gaussian-copula cross-fixture correlation — goals-batch summaries only). */
  combinedProb?: number;
  /** Combined decimal odds for the full accumulator slip (product of leg odds). */
  combinedOdds?: number;
  /** Final-analysis model attribution line (goals slips). States which decision-layer
   *  model analysed the picks and, when it wasn't Claude, why Claude wasn't reached.
   *  Built by buildAnalysisModelNote() from the legs' decisionReplay.model values. */
  analysisModelNote?: string;
  /** goals-market-analysis-prompt-v3 slate-arbiter outcome ("verified" = the local
   *  Claude review actually ran and returned parseable verdicts; "unverified" =
   *  fail-open, slate unchanged). Absent on the legacy (non-v3) goals path and on
   *  main-batch summaries, which have no slate arbiter. */
  arbiterStatus?: "verified" | "unverified";
  /** Count of §4.4 implausible-edge-capped selections for this run (logged, never
   *  bet) — surfaced so the slip states how many "too hot to trust" picks it
   *  discarded. v3 goals path only. */
  cappedCount?: number;
  /** Responsible-gambling note (v3 §7 guardrail 8) — rendered once per summary
   *  when the slip carries actionable picks. */
  rgNote?: string;
}

/** Build the "which model did the final analysis" attribution line for a goals
 *  slip, from the per-leg decision models. ORACLE's decision cascade is
 *  Claude (Opus/Fable) → Gemini → OpenRouter (GLM/Qwen) → deterministic; a leg
 *  is "Claude-analysed" only when its decisionReplay.model is a claude-* id.
 *  When some/all legs fell through to a non-Claude tier, the note says so and
 *  gives the implied reason (Claude tier unavailable/unreached for that fixture),
 *  per the owner requirement that the Telegram message state when Claude was and
 *  wasn't used and why. Returns undefined for an empty slip. */
export function buildAnalysisModelNote(models: (string | null | undefined)[]): string | undefined {
  if (models.length === 0) return undefined;
  const isClaude = (m: string | null | undefined) => !!m && m.toLowerCase().startsWith("claude");
  const claudeCount = models.filter(isClaude).length;
  const total = models.length;
  // Distinct non-Claude models actually used, for the "instead" reason.
  const others = [...new Set(models.filter((m) => m && !isClaude(m)) as string[])];
  const noneAttr = models.filter((m) => !m).length;

  if (claudeCount === total) {
    return `🧠 Final analysis: Claude (${[...new Set(models as string[])].join(", ")}) on all ${total} leg(s).`;
  }
  if (claudeCount === 0) {
    const why =
      others.length > 0
        ? `Claude decision tier not reached — analysed by ${others.join(", ")} (cascade fell through: Claude key/quota unavailable or call failed, used next tier).`
        : `no LLM tier ran (deterministic engine only) — Claude unavailable for these fixtures.`;
    return `🧠 Final analysis: Claude NOT used. ${why}`;
  }
  const parts = [
    `🧠 Final analysis: Claude on ${claudeCount}/${total} leg(s).`,
    others.length > 0 ? `${others.join(", ")} on the rest` : "",
    noneAttr > 0 ? `${noneAttr} deterministic-only` : "",
  ].filter(Boolean);
  return `${parts.join("; ")} (non-Claude legs: cascade fell through when Claude tier was unavailable/failed for that fixture).`;
}

/** A delivery channel. Implementations are constructed only when their env is configured. */
export interface Notifier {
  name: string;
  notify(summary: BatchSummary): Promise<void>;
}

/** Derive a channel-agnostic summary (actionable picks only) from a BatchResult.
 *  resolveEventId, when given, looks up the SportyBet sidecar eventId for a fixture
 *  (e.g. via runtime's findSidecarDetail) — without it, picks carry no eventId and
 *  the booking agent skips every leg (this package has no runtime dependency, so
 *  the lookup itself must live in the caller). */
export function summarizeBatch(
  batch: BatchResult,
  reportUrl?: string,
  resolveEventId?: (home: string, away: string) => string | undefined
): BatchSummary {
  const actionable: ActionablePick[] = [];
  for (const j of batch.jobs as BatchJobResult[]) {
    if (j.status !== "ok") continue;
    if (j.decision.grade === "NO_EDGE" || j.decision.grade === "MISSING_DATA") continue;
    const p = j.decision.primaryPick;
    const eventId = resolveEventId?.(j.home, j.away);
    actionable.push({
      home: j.home,
      away: j.away,
      league: j.league,
      kickoff: j.kickoff,
      market: p.market,
      side: p.side ?? null,
      odds: p.odds,
      stakePct: (p.stake ?? 0) * 100,
      confidence: j.decision.confidence,
      ...(eventId ? { eventId } : {}),
    });
  }
  return {
    date: batch.date,
    analysed: batch.completedCount,
    actionableCount: batch.actionableCount,
    errors: batch.errorCount,
    actionable,
    ...(reportUrl ? { reportUrl } : {}),
  };
}

/** Confidence tier label derived from model edge (mp − ip).
 *  Aligns with the industry-standard 5/7/10% edge classification for sports betting. */
function goalsEdgeLabel(edge: number): string {
  if (edge >= 0.1) return "Very High";
  if (edge >= 0.07) return "High";
  if (edge >= 0.05) return "Medium";
  return "Low";
}

/** Plain-text / Markdown rendering for chat channels (Telegram, Slack). */
export function formatSummaryText(s: BatchSummary): string {
  const lines = s.alertText ? [`⚠️ *ORACLE alert* — ${s.alertText}`] : [];
  lines.push(
    `*ORACLE ${s.date}* — ${s.analysed} analysed, ${s.actionableCount} actionable, ${s.errors} errors`
  );
  if (s.actionable.length === 0) {
    lines.push("_No actionable picks today._");
  } else {
    for (const p of s.actionable) {
      const side = p.side ? ` (${p.side})` : "";
      const edgePart =
        p.edge !== undefined
          ? ` · *${goalsEdgeLabel(p.edge)}* edge (+${(p.edge * 100).toFixed(1)}%)`
          : ` · ${p.stakePct.toFixed(1)}% Kelly`;
      lines.push(
        `• ${p.home} vs ${p.away} — ${p.market}${side} @ ${p.odds} · ${(p.confidence * 100).toFixed(0)}% conf${edgePart}`
      );
    }
  }
  if (s.combinedProb !== undefined && s.combinedOdds !== undefined) {
    lines.push(
      `\nCombined: ${(s.combinedProb * 100).toFixed(1)}% win prob · @${s.combinedOdds.toFixed(2)} odds`
    );
  }
  if (s.analysisModelNote) lines.push(`\n${s.analysisModelNote}`);
  if (s.arbiterStatus) {
    lines.push(
      s.arbiterStatus === "verified"
        ? "✅ Slate arbiter: reviewed."
        : "⚠️ Slate arbiter: unverified (review unavailable — slate unchanged)."
    );
  }
  if (s.cappedCount) {
    lines.push(`🧢 ${s.cappedCount} selection(s) capped as implausible edge (never bet).`);
  }
  if (s.bookingCode) {
    lines.push(`\n🎟 SportyBet Booking Code: *${s.bookingCode}*`);
    const loadUrl =
      s.bookingLoadUrl ?? `https://www.sportybet.com/?shareCode=${s.bookingCode}&c=ng`;
    lines.push(`Load: ${loadUrl}`);
    if (s.bookingUnmatched?.length) {
      lines.push(
        `⚠️ Unmatched legs (book manually): ${s.bookingUnmatched.map((p) => `${p.home} vs ${p.away} (${p.market})`).join(", ")}`
      );
    }
  } else if (s.bookingError) {
    lines.push(`\n⚠️ SportyBet booking unavailable: ${s.bookingError}`);
  }
  if (s.reportUrl) lines.push(`\nReport: ${s.reportUrl}`);
  if (s.rgNote && s.actionable.length > 0) lines.push(`\n_${s.rgNote}_`);
  return lines.join("\n");
}

/** HTML rendering for email. */
export function formatSummaryHtml(s: BatchSummary): string {
  const rows = s.actionable.length
    ? s.actionable
        .map(
          (p) =>
            `<tr><td>${p.home} vs ${p.away}</td><td>${p.market}${p.side ? ` (${p.side})` : ""}</td><td>${p.odds}</td><td>${p.stakePct.toFixed(1)}%</td><td>${(p.confidence * 100).toFixed(0)}%</td></tr>`
        )
        .join("")
    : '<tr><td colspan="5">No actionable picks today.</td></tr>';
  return `${s.alertText ? `<p><strong>⚠️ ORACLE alert — ${s.alertText}</strong></p>` : ""}
<h2>ORACLE ${s.date}</h2>
<p>${s.analysed} analysed · ${s.actionableCount} actionable · ${s.errors} errors</p>
<table border="1" cellpadding="6" cellspacing="0">
<tr><th>Fixture</th><th>Market</th><th>Odds</th><th>Stake</th><th>Conf</th></tr>
${rows}
</table>
${
  s.combinedProb !== undefined && s.combinedOdds !== undefined
    ? `<p><strong>Combined: ${(s.combinedProb * 100).toFixed(1)}% win prob · @${s.combinedOdds.toFixed(2)} odds</strong></p>`
    : ""
}
${s.analysisModelNote ? `<p><em>${s.analysisModelNote}</em></p>` : ""}
${
  s.bookingCode
    ? `<p><strong>🎟 SportyBet Booking Code: <code>${s.bookingCode}</code></strong><br>
<a href="${s.bookingLoadUrl ?? `https://www.sportybet.com/?shareCode=${s.bookingCode}&c=ng`}">Load on SportyBet</a>${
        s.bookingUnmatched?.length
          ? `<br><em>⚠️ Unmatched legs (book manually): ${s.bookingUnmatched.map((p) => `${p.home} vs ${p.away} (${p.market})`).join(", ")}</em>`
          : ""
      }</p>`
    : s.bookingError
      ? `<p><em>⚠️ SportyBet booking unavailable: ${s.bookingError}</em></p>`
      : ""
}
${s.reportUrl ? `<p><a href="${s.reportUrl}">Full report</a></p>` : ""}
${s.rgNote && s.actionable.length > 0 ? `<p><small>${s.rgNote}</small></p>` : ""}`;
}

/** v3 §7 guardrail 8 — responsible-gambling note text, shared by every v3 slip. */
export const GOALS_V3_RG_NOTE =
  "These are probability estimates, not predictions; outcomes are uncertain even when the model is right. Stake only what you can afford to lose and keep to sensible unit sizing.";
