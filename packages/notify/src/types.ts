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
}

/** A delivery channel. Implementations are constructed only when their env is configured. */
export interface Notifier {
  name: string;
  notify(summary: BatchSummary): Promise<void>;
}

/** Derive a channel-agnostic summary (actionable picks only) from a BatchResult. */
export function summarizeBatch(batch: BatchResult, reportUrl?: string): BatchSummary {
  const actionable: ActionablePick[] = [];
  for (const j of batch.jobs as BatchJobResult[]) {
    if (j.status !== "ok") continue;
    if (j.decision.grade === "NO_EDGE" || j.decision.grade === "MISSING_DATA") continue;
    const p = j.decision.primaryPick;
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
      lines.push(
        `• ${p.home} vs ${p.away} — ${p.market}${side} @ ${p.odds} · ${p.stakePct.toFixed(1)}% Kelly · ${(p.confidence * 100).toFixed(0)}% conf`
      );
    }
  }
  if (s.combinedProb !== undefined && s.combinedOdds !== undefined) {
    lines.push(
      `\nCombined: ${(s.combinedProb * 100).toFixed(1)}% win prob · @${s.combinedOdds.toFixed(2)} odds`
    );
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
${s.reportUrl ? `<p><a href="${s.reportUrl}">Full report</a></p>` : ""}`;
}
