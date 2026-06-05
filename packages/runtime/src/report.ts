/** Self-contained HTML report renderer — Phase 3.
 *  No external deps; all CSS inline. One card per fixture. */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchResult, BatchJobResult, FixtureJobSuccess } from '@oracle/engine';
import type { PickRef } from '@oracle/engine';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(n: number, dec = 1): string {
  return `${(n * 100).toFixed(dec)}%`;
}

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 1400px; margin: 0 auto; }
h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 16px; color: #f1f5f9; }
.summary { background: #1e293b; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; display: flex; gap: 28px; flex-wrap: wrap; align-items: center; border: 1px solid #334155; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
.stat-val { font-size: 1.1rem; font-weight: 700; color: #f1f5f9; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.card { background: #1e293b; border-radius: 10px; padding: 16px; border-left: 4px solid #3b82f6; border: 1px solid #334155; border-left: 4px solid #3b82f6; }
.card-error { border-left-color: #ef4444 !important; }
.card-no-bet { border-left-color: #64748b !important; opacity: 0.75; }
.card-actionable { border-left-color: #22c55e !important; }
.card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; gap: 8px; }
.teams { font-size: 0.95rem; font-weight: 700; color: #f1f5f9; }
.meta { font-size: 0.7rem; color: #64748b; text-align: right; flex-shrink: 0; }
.lambda-row { font-size: 0.78rem; color: #94a3b8; margin-bottom: 10px; }
.probs { display: flex; gap: 6px; margin-bottom: 10px; }
.prob { flex: 1; background: #0f172a; border-radius: 6px; padding: 7px 4px; text-align: center; border: 1px solid #1e293b; }
.prob-label { font-size: 0.6rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
.prob-val { font-size: 1.05rem; font-weight: 700; }
.flags { margin-bottom: 8px; display: flex; gap: 4px; flex-wrap: wrap; }
.flag { font-size: 0.62rem; padding: 2px 7px; border-radius: 4px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.flag-warn { background: #422006; color: #fde68a; }
.flag-info { background: #0c2a4a; color: #93c5fd; }
.flag-danger { background: #3b0000; color: #fca5a5; }
.picks { margin-bottom: 8px; border-top: 1px solid #334155; padding-top: 8px; }
.pick-row { font-size: 0.82rem; margin-bottom: 5px; display: flex; align-items: baseline; gap: 6px; }
.pick-label { font-size: 0.62rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; min-width: 38px; }
.pick-val { font-weight: 600; color: #f1f5f9; }
.pick-stake { font-size: 0.7rem; color: #22c55e; }
.confidence { font-size: 0.7rem; color: #94a3b8; }
.adversary { font-size: 0.75rem; color: #fb923c; border-left: 2px solid #7c2d12; padding-left: 8px; margin-bottom: 6px; }
.adv-label { font-weight: 700; margin-right: 4px; }
.rationale { font-size: 0.72rem; color: #64748b; margin-top: 4px; font-style: italic; }
.error-body { color: #fca5a5; font-size: 0.82rem; margin-top: 6px; }
`;

function cardClass(job: BatchJobResult): string {
  if (job.status === 'error') return 'card card-error';
  if (job.decision.primaryPick === 'NO_BET') return 'card card-no-bet';
  return 'card card-actionable';
}

function renderCard(job: BatchJobResult): string {
  if (job.status === 'error') {
    return `
<div class="card card-error">
  <div class="card-header"><span class="teams">${esc(job.home)} vs ${esc(job.away)}</span></div>
  <div class="error-body">Error: ${esc(job.reason)}</div>
</div>`;
  }

  const r = job.result;
  const d = job.decision;
  const fp = r.fp;
  const lH = (r.bayesian_lH as number | undefined) ?? 0;
  const lA = (r.bayesian_lA as number | undefined) ?? 0;

  // Regime flags
  const flags: string[] = [];
  const lowScore = (r['lowScoreRegime'] as Record<string, unknown> | undefined)?.regime === 'LOW_SCORING';
  if (lowScore) flags.push('<span class="flag flag-warn">LOW_SCORING</span>');
  if (r.portfolioCorrelation !== null && (r.portfolioCorrelation as number) > 0.5)
    flags.push('<span class="flag flag-warn">HIGH_CORR</span>');
  if (!r.oddsAvailable) flags.push('<span class="flag flag-info">NO_ODDS</span>');
  const mlFilter = r['mlFilter'] as Record<string, unknown> | undefined;
  if (mlFilter?.mlAllowed === false) flags.push('<span class="flag flag-danger">ML_BLOCKED</span>');

  // Primary pick
  const pick = d.primaryPick === 'NO_BET' ? null : (d.primaryPick as PickRef);
  const pickStr = pick
    ? `${esc(pick.market)}${pick.side ? ` — ${esc(pick.side)}` : ''} <span style="color:#fbbf24">@ ${pick.odds}</span>`
    : '<span style="color:#64748b">NO_BET</span>';
  const stakeStr = pick?.stake ? `<span class="pick-stake">${pct(pick.stake)} Kelly</span>` : '';
  const altPick = d.altPick;
  const altStr = altPick
    ? `${esc(altPick.market)} @ ${altPick.odds}`
    : '—';

  // Adversary objection from debate
  const debate = r['debate'] as Record<string, unknown> | undefined;
  const rounds = debate?.['rounds'] as Array<Record<string, unknown>> | undefined;
  const adversary = rounds && rounds.length > 0
    ? String(rounds[rounds.length - 1]!['adversaryArg'] ?? '')
    : '';

  return `
<div class="${cardClass(job)}">
  <div class="card-header">
    <span class="teams">${esc(job.home)} vs ${esc(job.away)}</span>
    <span class="meta">${esc(job.league)}<br>${esc(job.kickoff.slice(0, 16).replace('T', ' '))}</span>
  </div>
  <div class="lambda-row">λH <strong>${lH.toFixed(2)}</strong> · λA <strong>${lA.toFixed(2)}</strong> · xScore <strong>${esc(r.expectedScoreline ?? '?')}</strong></div>
  <div class="probs">
    <div class="prob"><div class="prob-label">Home</div><div class="prob-val">${pct(fp.home)}</div></div>
    <div class="prob"><div class="prob-label">Draw</div><div class="prob-val">${pct(fp.draw)}</div></div>
    <div class="prob"><div class="prob-label">Away</div><div class="prob-val">${pct(fp.away)}</div></div>
  </div>
  ${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}
  <div class="picks">
    <div class="pick-row"><span class="pick-label">Primary</span><span class="pick-val">${pickStr}</span>${stakeStr}${pick ? `<span class="confidence">${pct(d.confidence)} conf</span>` : ''}</div>
    <div class="pick-row"><span class="pick-label">Alt</span><span class="pick-val" style="color:#94a3b8">${altStr}</span></div>
  </div>
  ${adversary ? `<div class="adversary"><span class="adv-label">Adversary:</span>${esc(adversary)}</div>` : ''}
  ${d.rationale ? `<div class="rationale">${esc(d.rationale)}</div>` : ''}
</div>`;
}

export function renderReport(batch: BatchResult): string {
  const hasHighCorr = (batch.jobs as BatchJobResult[]).some(
    j => j.status === 'ok' && j.result.portfolioCorrelation !== null && (j.result.portfolioCorrelation as number) > 0.5,
  );

  const cards = batch.jobs.map(renderCard).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ORACLE Report — ${esc(batch.date)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>ORACLE Daily Report</h1>
<div class="summary">
  <div class="stat"><span class="stat-label">Date</span><span class="stat-val">${esc(batch.date)}</span></div>
  <div class="stat"><span class="stat-label">Mode</span><span class="stat-val">${esc(batch.rankingMode)}</span></div>
  <div class="stat"><span class="stat-label">Fixtures</span><span class="stat-val">${batch.jobs.length}</span></div>
  <div class="stat"><span class="stat-label">Actionable</span><span class="stat-val" style="color:#22c55e">${batch.actionableCount}</span></div>
  <div class="stat"><span class="stat-label">Errors</span><span class="stat-val"${batch.errorCount > 0 ? ' style="color:#ef4444"' : ''}>${batch.errorCount}</span></div>
  <div class="stat"><span class="stat-label">Total Stake</span><span class="stat-val">${batch.totalRecommendedStakePct.toFixed(1)}%</span></div>
  ${hasHighCorr ? '<div class="stat"><span class="stat-label">Portfolio</span><span class="stat-val" style="color:#f97316">HIGH_CORR</span></div>' : ''}
</div>
<div class="cards">
${cards}
</div>
</body>
</html>`;
}

/** Write the report to .tmp/reports/oracle-{date}.html. Returns the output path. */
export async function writeReport(batch: BatchResult, outDir = '.tmp/reports'): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `oracle-${batch.date}.html`);
  await writeFile(outPath, renderReport(batch), 'utf8');
  return outPath;
}
