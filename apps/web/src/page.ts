/** The ORACLE web landing page — a Google-search-styled fixture input.
 *  Zero-dep, all CSS/JS inline (matches the report.ts house style). */
import { SPORT_TO_LEAGUE } from "@oracle/runtime";

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

/** Build the <option> list for the league hint dropdown. */
function leagueOptions(): string {
  const leagues = Array.from(new Set(Object.values(SPORT_TO_LEAGUE))).sort();
  return [
    '<option value="">Any league</option>',
    ...leagues.map((l) => `<option value="${l}">${l}</option>`),
  ].join("");
}

export function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ORACLE</title>
<style>${PAGE_CSS}</style>
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
<script>${PAGE_JS}</script>
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
 *  `state` describes today's prompt/fulfilment; `resultHtml` is an optional rendered result block. */
export function renderPuntPage(
  state: { promptedAt: string | null; fulfilled: boolean; lastCode?: string },
  resultHtml = ""
): string {
  const banner = state.fulfilled
    ? `<div class="banner ok">✅ Today's code processed${state.lastCode ? ` — <code>${esc(state.lastCode)}</code>` : ""}.</div>`
    : state.promptedAt
      ? `<div class="banner wait">⏳ Awaiting today's booking code. Drop it below 👇</div>`
      : `<div class="banner">Paste a SportyBet booking code to run ORACLE counter-analysis.</div>`;

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
