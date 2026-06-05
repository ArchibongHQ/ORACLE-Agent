/** ORACLE web server — zero-dep node:http.
 *  GET /          → Google-search-styled fixture input page
 *  POST /analyze  → analyse a typed fixture OR a pasted/uploaded list → HTML report
 *  GET /reports/:date → serve a previously generated report
 *  GET /health    → liveness probe
 *
 *  Binds 127.0.0.1 by default (single power user; auth deferred to the cloud stage — PRD §1.3). */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GBrainAdapter } from '@oracle/storage';
import type { StoragePort } from '@oracle/storage';
import { parseFixtureList } from '@oracle/engine';
import type { OracleConfig } from '@oracle/engine';
import { loadEnv, buildConfig, fetchFixtureByName, runAnalysis } from '@oracle/runtime';
import { renderPage, renderNotice } from './page.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../../..');
const REPORTS_DIR = join(ROOT, '.tmp/reports');

export interface WebDeps {
  storage: StoragePort;
  config: OracleConfig;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const html = (status: number, body: string): WebResponse =>
  ({ status, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
const jsonRes = (status: number, obj: unknown): WebResponse =>
  ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

/** Parse a POST body (JSON or form-encoded) into the analyse fields. */
function parseBody(body: string, contentType: string): { query?: string; league?: string; list?: string } {
  if (!body) return {};
  if (contentType.includes('application/json')) {
    try { return JSON.parse(body) as Record<string, string>; } catch { return {}; }
  }
  const params = new URLSearchParams(body);
  const out: { query?: string; league?: string; list?: string } = {};
  const q = params.get('query'); if (q) out.query = q;
  const l = params.get('league'); if (l) out.league = l;
  const list = params.get('list'); if (list) out.list = list;
  return out;
}

function splitFixture(s: string): { home: string; away: string } | null {
  const parts = s.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  const home = parts[0]!.trim(), away = parts[1]!.trim();
  if (!home || !away) return null;
  return { home, away };
}

/** Pure request handler — routing + body. Returns a WebResponse (no socket I/O). */
export async function handleRequest(
  method: string,
  urlPath: string,
  body: string,
  contentType: string,
  deps: WebDeps,
): Promise<WebResponse> {
  if (method === 'GET' && urlPath === '/') return html(200, renderPage());
  if (method === 'GET' && urlPath === '/health') return jsonRes(200, { ok: true });

  if (method === 'GET' && urlPath.startsWith('/reports/')) {
    const date = urlPath.slice('/reports/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return html(400, renderNotice('Bad request', 'Report date must be YYYY-MM-DD.'));
    try {
      const file = await readFile(join(REPORTS_DIR, `oracle-${date}.html`), 'utf8');
      return html(200, file);
    } catch {
      return html(404, renderNotice('Not found', `No report for ${date}.`));
    }
  }

  if (method === 'POST' && urlPath === '/analyze') {
    const { query, league, list } = parseBody(body, contentType);

    let jobs;
    if (list && list.trim()) {
      jobs = parseFixtureList(list);
    } else if (query && query.trim()) {
      const split = splitFixture(query);
      if (!split) return html(400, renderNotice('Could not parse', `Expected "Home vs Away", got "${query}".`));
      const job = await fetchFixtureByName(split.home, split.away, deps.config.oddsApiKey, league || undefined);
      jobs = job ? [job] : [];
    } else {
      return html(400, renderNotice('Nothing to analyse', 'Enter a fixture or paste a list.'));
    }

    if (!jobs.length) {
      return html(200, renderNotice('No odds found', 'Could not find live odds for that fixture. Try a league hint, or paste the fixture into the list box.'));
    }

    const { reportHtml } = await runAnalysis(jobs, deps, {
      trigger: 'manual',
      batchOptions: { rankingMode: deps.config.rankingMode },
    });
    return html(200, reportHtml);
  }

  return html(404, renderNotice('Not found', `No route for ${method} ${urlPath}.`));
}

function readReqBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface ServerOptions {
  port?: number;
  host?: string;
  deps?: WebDeps;
}

/** Start the HTTP server. Owns a single GBrainAdapter unless deps are injected (tests). */
export function startServer(opts: ServerOptions = {}): http.Server {
  const port = opts.port ?? Number(process.env['PORT'] ?? 8787);
  const host = opts.host ?? '127.0.0.1';
  const deps: WebDeps = opts.deps ?? {
    storage: new GBrainAdapter(join(ROOT, '.tmp/gbrain')),
    config: buildConfig(loadEnv(join(ROOT, '.env'))),
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const urlPath = (req.url ?? '/').split('?')[0]!;
        const body = method === 'POST' ? await readReqBody(req) : '';
        const contentType = req.headers['content-type'] ?? '';
        const r = await handleRequest(method, urlPath, body, contentType, deps);
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderNotice('Server error', msg));
      }
    })();
  });

  server.listen(port, host, () => {
    console.log(`[oracle-web] listening on http://${host}:${port}`);
  });
  return server;
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
