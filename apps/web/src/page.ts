/** The ORACLE web landing page — a Google-search-styled fixture input.
 *  Zero-dep, all CSS/JS inline (matches the report.ts house style). */
import type { GoalsArtifact, GoalsLeg } from "@oracle/runtime";
import {
  GOALS_RICH_LEAGUES,
  ORACLE_PRIORITY_LEAGUES,
  pct,
  REPORT_CSS,
  SPORT_TO_LEAGUE,
} from "@oracle/runtime";

const PAGE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 12vh 20px 40px; }
.logo { font-size: 2.6rem; font-weight: 800; letter-spacing: 0.04em; color: #f1f5f9; margin-bottom: 4px; }
.logo span { color: #3b82f6; }
.tagline { font-size: 0.85rem; color: #64748b; margin-bottom: 32px; }
form { width: 100%; max-width: 640px; }
.searchbar { display: flex; gap: 8px; margin-bottom: 12px; }
.searchbar input[type=text] { flex: 1; background: #1e293b; border: 1px solid #334155; border-radius: 24px; padding: 14px 22px; font-size: 1rem; color: #f1f5f9; outline: none; }
.searchbar input[type=text]:focus { border-color: #3b82f6; }
select { background: #1e293b; border: 1px solid #334155; border-radius: 24px; padding: 0 16px; color: #e2e8f0; font-size: 0.85rem; outline: none; cursor: pointer; }
.btn { background: #3b82f6; border: none; border-radius: 24px; padding: 14px 28px; font-size: 1rem; font-weight: 700; color: #fff; cursor: pointer; }
.btn:hover { background: #2563eb; }
.btn-secondary { background: #1e293b; border: 1px solid #334155; color: #93c5fd; font-size: 0.8rem; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
.toggle { text-align: center; margin-bottom: 12px; }
.list-area { margin-top: 8px; }
.list-area[hidden] { display: none; }
textarea { width: 100%; min-height: 160px; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px; color: #f1f5f9; font-family: ui-monospace, monospace; font-size: 0.82rem; outline: none; resize: vertical; }
textarea:focus { border-color: #3b82f6; }
.row { display: flex; gap: 8px; align-items: center; justify-content: center; flex-wrap: wrap; margin-top: 10px; }
.hint { font-size: 0.72rem; color: #64748b; margin-top: 6px; text-align: center; }
.spinner { display: none; margin: 28px auto 0; width: 28px; height: 28px; border: 3px solid #334155; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.loading .spinner { display: block; }
.loading .btn { opacity: 0.5; pointer-events: none; }
`;

const PAGE_JS = `
const form = document.getElementById('analyze-form');
const fileInput = document.getElementById('file');
const listArea = document.getElementById('list-area');
const listBox = document.getElementById('list');
document.getElementById('toggle-list').addEventListener('click', () => {
  listArea.hidden = !listArea.hidden;
});
fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  if (!f) return;
  listArea.hidden = false;
  listBox.value = await f.text();
});
form.addEventListener('submit', () => { document.body.classList.add('loading'); });
`;

/** Build the <option> list for the league hint dropdown. Union of all three
 *  league sets the runtime knows about — this is a UI autocomplete hint only,
 *  not a fixture-eligibility filter, so widening it is purely additive. */
function leagueOptions(): string {
  const leagues = Array.from(
    new Set([...Object.values(SPORT_TO_LEAGUE), ...ORACLE_PRIORITY_LEAGUES, ...GOALS_RICH_LEAGUES])
  ).sort();
  return [
    '<option value="">Any league</option>',
    ...leagues.map((l) => `<option value="${l}">${l}</option>`),
  ].join("");
}

/** Comment-bar section — lets a user point at a date's already-generated
 *  daily fixture report and type a plain-English instruction (summarize,
 *  filter by league, re-analyze a fixture). The LLM only classifies the
 *  instruction; runCommentBarInstruction() executes it deterministically —
 *  see commentBarOrchestrator.ts. `resultText` (if present) is the prior
 *  instruction's output, rendered above the form. */
function renderCommentBar(resultText?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const result = resultText ? `<div class="comment-result">${esc(resultText)}</div>` : "";
  return `
<div class="comment-bar">
  <div class="toggle">
    <button class="btn-secondary" type="button" id="toggle-comment">▾ point at a fixture report + comment</button>
  </div>
  <div class="comment-area" id="comment-area" hidden>
    <form method="POST" action="/comment">
      <div class="row">
        <input type="date" name="date" value="${today}">
        <input type="text" name="instruction" placeholder="e.g. summarize today's fixtures, or only show Premier League" style="flex:1;min-width:260px">
        <button class="btn" type="submit">Run</button>
      </div>
      <div class="hint">References the daily fixture report already generated for that date — does not re-scrape.</div>
    </form>
  </div>
  ${result}
</div>`;
}

const COMMENT_CSS = `
.comment-bar { width: 100%; max-width: 640px; margin-top: 18px; }
.comment-area { margin-top: 8px; }
.comment-area[hidden] { display: none; }
.comment-area input[type=date] { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; color: #e2e8f0; font-size: 0.85rem; }
.comment-area input[type=text] { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; color: #f1f5f9; font-size: 0.85rem; outline: none; }
.comment-area input[type=text]:focus { border-color: #3b82f6; }
.comment-result { margin-top: 14px; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px; white-space: pre-wrap; font-size: 0.82rem; color: #e2e8f0; max-height: 480px; overflow: auto; }
`;

const COMMENT_JS = `
const ctoggle = document.getElementById('toggle-comment');
const carea = document.getElementById('comment-area');
if (ctoggle) ctoggle.addEventListener('click', () => { carea.hidden = !carea.hidden; });
`;

export function renderPage(commentResultText?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ORACLE</title>
<style>${PAGE_CSS}${COMMENT_CSS}</style>
</head>
<body>
<div class="logo">OR<span>A</span>CLE</div>
<div class="tagline">quantitative football betting analysis</div>
<form id="analyze-form" method="POST" action="/analyze">
  <div class="searchbar">
    <input type="text" name="query" placeholder="Arsenal vs Chelsea" autofocus autocomplete="off">
    <select name="league">${leagueOptions()}</select>
    <button class="btn" type="submit">Analyse</button>
  </div>
  <div class="toggle">
    <button class="btn-secondary" type="button" id="toggle-list">▾ paste / upload a fixture list</button>
  </div>
  <div class="list-area" id="list-area" hidden>
    <textarea name="list" id="list" placeholder="Arsenal vs Chelsea, Premier League, 2026-06-05T15:00:00Z&#10;Real Madrid vs Barca, La Liga, 2026-06-05T20:00:00Z"></textarea>
    <div class="row">
      <input type="file" id="file" accept=".txt,.csv">
      <span class="hint">one fixture per line — "Home vs Away, League, Kickoff"</span>
    </div>
  </div>
  <div class="spinner"></div>
</form>
<div class="hint" style="margin-top:28px">Type a single fixture, or paste/upload a list. Odds are pulled live from the Odds API.</div>
${renderCommentBar(commentResultText)}
<script>${PAGE_JS}${COMMENT_JS}</script>
</body>
</html>`;
}

/** A minimal standalone error/notice page (dark theme). */
/** Escape HTML special chars for safe interpolation into the punt page. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

/** The /punt page — paste a SportyBet booking code; shows the awaiting-state banner and last result.
 *  `state` describes today's two named-slip prompts/fulfilment (order-based matching —
 *  see packages/runtime/src/puntState.ts); `resultHtml` is an optional rendered result block. */
export function renderPuntPage(
  state: {
    slips: Array<{ promptedAt: string | null; fulfilled: boolean; lastCode?: string }>;
  },
  resultHtml = ""
): string {
  const labels = ["39 Billion - Universe", "9z 40 ACCA"];
  const banner = state.slips
    .map((slip, i) => {
      const label = labels[i] ?? `Slip ${i + 1}`;
      if (slip.fulfilled) {
        return `<div class="banner ok">✅ ${esc(label)} processed${slip.lastCode ? ` — <code>${esc(slip.lastCode)}</code>` : ""}.</div>`;
      }
      if (slip.promptedAt) {
        return `<div class="banner wait">⏳ Awaiting ${esc(label)} booking code. Drop it below 👇</div>`;
      }
      return `<div class="banner">${esc(label)} — paste a SportyBet booking code to run ORACLE counter-analysis.</div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ORACLE — Punt Analysis</title>
<style>${PAGE_CSS}
.banner{max-width:640px;width:100%;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:.9rem;color:#cbd5e1}
.banner.wait{border-color:#f59e0b;color:#fbbf24}.banner.ok{border-color:#22c55e;color:#4ade80}
.result{max-width:760px;width:100%;margin-top:24px;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:18px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.82rem;color:#e2e8f0}
code{background:#0f172a;padding:1px 6px;border-radius:4px;color:#93c5fd}</style>
</head><body>
<div class="logo">ORA<span>CLE</span></div>
<div class="tagline">Punt counter-analysis — keep his fixtures, swap weak picks</div>
${banner}
<form id="punt-form" method="POST" action="/punt">
  <div class="searchbar">
    <input type="text" name="code" id="code" placeholder="SportyBet booking code (e.g. BC2A3L9H)" autocomplete="off" required>
    <button class="btn" type="submit">Analyse</button>
  </div>
  <div class="hint">ORACLE loads the slip, analyses every leg, and emits an adjusted booking code.</div>
</form>
<div class="spinner"></div>
${resultHtml ? `<div class="result">${resultHtml}</div>` : ""}
<script>
const f=document.getElementById('punt-form');
f.addEventListener('submit',()=>{document.body.classList.add('loading');});
</script>
</body></html>`;
}

export function renderNotice(title: string, message: string): string {
  const t = esc(title);
  const m = esc(message);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ORACLE — ${t}</title>
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
h1{color:#f1f5f9;margin-bottom:12px}p{color:#94a3b8;max-width:520px;margin-bottom:24px}a{color:#3b82f6;text-decoration:none}</style>
</head><body><h1>${t}</h1><p>${m}</p><a href="/">← back to search</a></body></html>`;
}

const GOALS_CSS = `
.slip { margin-bottom: 28px; }
.slip-title { font-size: 1rem; font-weight: 700; color: #f1f5f9; margin-bottom: 4px; }
.slip-meta { font-size: 0.72rem; color: #64748b; margin-bottom: 10px; }
.leg-table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; border: 1px solid #334155; }
.leg-table th { text-align: left; font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; padding: 8px 10px; border-bottom: 1px solid #334155; }
.leg-table td { font-size: 0.8rem; color: #e2e8f0; padding: 7px 10px; border-bottom: 1px solid #1e293b; }
.leg-table tr:last-child td { border-bottom: none; }
`;

function renderLegRows(legs: GoalsLeg[]): string {
  if (!legs.length)
    return `<tr><td colspan="6" style="color:#64748b">No qualifying legs.</td></tr>`;
  return legs
    .map(
      (l) => `<tr>
  <td>${esc(l.home)} vs ${esc(l.away)}</td>
  <td>${esc(l.league)}</td>
  <td>${esc(l.market)} — ${esc(l.side)}</td>
  <td>${l.odds.toFixed(2)}</td>
  <td>${pct(l.mp)}</td>
  <td>${pct(l.edge)}</td>
</tr>`
    )
    .join("\n");
}

function renderSlip(
  title: string,
  legs: GoalsLeg[],
  combinedProb: number | undefined,
  combinedOdds: number | undefined,
  trueEv?: number
): string {
  const meta =
    combinedProb !== undefined && combinedOdds !== undefined
      ? `${legs.length} leg(s) · combined prob ${pct(combinedProb)} · combined odds ${combinedOdds.toFixed(2)}` +
        // True EV at the combined offered price — surfaces parlay margin
        // compounding (multiplying N marked-up leg odds together compounds
        // each leg's own bookmaker margin) instead of a bare probability/odds
        // pair that reads as more favorable than the combo actually is.
        (trueEv !== undefined ? ` · true EV ${trueEv >= 0 ? "+" : ""}${pct(trueEv)}` : "")
      : `${legs.length} leg(s)`;
  return `
<div class="slip">
  <div class="slip-title">${esc(title)}</div>
  <div class="slip-meta">${meta}</div>
  <table class="leg-table">
    <thead><tr><th>Fixture</th><th>League</th><th>Market</th><th>Odds</th><th>Model prob</th><th>Edge</th></tr></thead>
    <tbody>${renderLegRows(legs)}</tbody>
  </table>
</div>`;
}

/** Renders the daily goals-ACCA selection (top picks / 39-leg lottery /
 *  mini-ACCA / Output B / Output C) — previously worker-> Telegram/email
 *  only, now also visible on the web. `artifact` is null when no run has
 *  happened yet for the requested date. */
export function renderGoalsPage(date: string, artifact: GoalsArtifact | null): string {
  const body = !artifact
    ? `<p class="hint" style="margin-top:40px">No goals-ACCA run found for ${esc(date)} yet.</p>`
    : [
        renderSlip(
          "Top Picks",
          artifact.selection.shortSlipLegs,
          artifact.selection.shortSlipCombinedProb,
          artifact.selection.shortSlipCombinedOdds
        ),
        renderSlip(
          "39-Leg Lottery",
          artifact.selection.legs,
          artifact.selection.combinedProb,
          artifact.selection.combinedOdds
        ),
        renderSlip(
          "Mini-ACCA",
          artifact.selection.miniAccaLegs,
          artifact.selection.miniAccaCombinedProb,
          artifact.selection.miniAccaCombinedOdds,
          artifact.selection.miniAccaTrueEv
        ),
        renderSlip("Output B (odds ≥ 4.00)", artifact.selection.outputBLegs, undefined, undefined),
        renderSlip(
          "Output C (2.50 ≤ odds < 4.00)",
          artifact.selection.outputCLegs,
          undefined,
          undefined
        ),
      ].join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ORACLE — Goals ACCA ${esc(date)}</title>
<style>${REPORT_CSS}${GOALS_CSS}</style>
</head>
<body>
<h1>ORACLE Goals ACCA — ${esc(date)}</h1>
<div class="summary">
  <div class="stat"><span class="stat-label">Date</span><span class="stat-val">${esc(date)}</span></div>
  ${artifact ? `<div class="stat"><span class="stat-label">Analysed</span><span class="stat-val">${artifact.selection.analysed}</span></div>` : ""}
  ${artifact ? `<div class="stat"><span class="stat-label">Generated</span><span class="stat-val">${esc(artifact.generatedAt.slice(0, 16).replace("T", " "))}</span></div>` : ""}
</div>
${body}
</body>
</html>`;
}
