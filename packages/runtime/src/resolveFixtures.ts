/** Result lookup via football-data.org — Phase 4.
 *  Takes yesterday's analysis records, fetches actual match scores,
 *  returns ResolutionRecord[] with RPS, draw-calibration, and CLV. */
import type { AnalysisRecord, ResolutionRecord, ClvSourceQuality } from '@oracle/engine';
import { RESOLUTION_SCHEMA_VERSION } from '@oracle/engine';

const BASE_URL = 'https://api.football-data.org/v4';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// ── football-data.org competition IDs (free tier) ─────────────────────────────

const LEAGUE_TO_COMPETITION: Record<string, string> = {
  'Premier League':    'PL',
  'La Liga':           'PD',
  'Bundesliga':        'BL1',
  'Serie A':           'SA',
  'Ligue 1':           'FL1',
  'Champions League':  'CL',
  'Europa League':     'EL',
  'Primeira Liga':     'PPL',
  'Championship':      'ELC',
  'Eredivisie':        'DED',
};

// Odds API sport keys for CLV-eligible leagues
const LEAGUE_TO_SPORT: Record<string, string> = {
  'Premier League':      'soccer_epl',
  'La Liga':             'soccer_spain_la_liga',
  'Bundesliga':          'soccer_germany_bundesliga',
  'Serie A':             'soccer_italy_serie_a',
  'Ligue 1':             'soccer_france_ligue_one',
  'Champions League':    'soccer_uefa_champs_league',
  'Europa League':       'soccer_uefa_europa_league',
  'Eredivisie':          'soccer_netherlands_eredivisie',
  'Primeira Liga':       'soccer_portugal_primeira_liga',
  'Championship':        'soccer_england_championship',
  'FIFA World Cup':      'soccer_fifa_world_cup',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface FDTeam { name: string; shortName?: string; tla?: string; }

interface FDScore {
  fullTime: { home: number | null; away: number | null };
}

interface FDMatch {
  id: number;
  utcDate: string;
  status: string;
  homeTeam: FDTeam;
  awayTeam: FDTeam;
  score: FDScore;
}

interface FDResponse { matches: FDMatch[]; }

interface OddsH2HOutcome { name: string; price: number; }
interface OddsH2HGame {
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    markets: Array<{ key: string; outcomes: OddsH2HOutcome[]; }>;
  }>;
}

// ── Team name normalisation ───────────────────────────────────────────────────

function normalizeTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+(fc|afc|sc|cf|ac|as|ss|ssc|calcio|futbol club|football club|united|city|athletic|athletico|atlético)\s*$/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsMatch(a: string, b: string): boolean {
  const na = normalizeTeam(a), nb = normalizeTeam(b);
  return na === nb || na.startsWith(nb) || nb.startsWith(na) || na.includes(nb) || nb.includes(na);
}

// ── RPS ───────────────────────────────────────────────────────────────────────

function rpsScore(probs: { home: number; draw: number; away: number }, actual: 'home' | 'draw' | 'away'): number {
  const outcomes = ['home', 'draw', 'away'] as const;
  let cumF = 0, cumA = 0, score = 0;
  for (const out of outcomes) {
    cumF += probs[out];
    cumA += out === actual ? 1 : 0;
    score += (cumF - cumA) ** 2;
  }
  return score / (outcomes.length - 1);
}

// ── football-data.org fetch ───────────────────────────────────────────────────

async function fetchFinishedMatches(apiKey: string, date: string): Promise<FDMatch[]> {
  const params = new URLSearchParams({ dateFrom: date, dateTo: date, status: 'FINISHED' });
  const url = `${BASE_URL}/matches?${params}`;
  const res = await fetch(url, {
    headers: { 'X-Auth-Token': apiKey },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error('football-data.org: rate limited');
    if (res.status === 403) throw new Error('football-data.org: invalid API key');
    throw new Error(`football-data.org: HTTP ${res.status}`);
  }

  const body = await res.json() as FDResponse;
  return body.matches ?? [];
}

// ── Closing odds fetch (Odds API v4, kickoff-proxy CLV) ───────────────────────

async function fetchClosingOdds(
  apiKey: string,
  home: string,
  away: string,
  sportKey: string,
  kickoffIso: string,
): Promise<{ home: number; draw: number; away: number } | null> {
  const kickoff = new Date(kickoffIso);
  const windowFrom = new Date(kickoff.getTime() - 2 * 3_600_000).toISOString();
  const windowTo   = new Date(kickoff.getTime() + 2 * 3_600_000).toISOString();

  const params = new URLSearchParams({
    apiKey,
    regions:          'uk,eu',
    markets:          'h2h',
    oddsFormat:       'decimal',
    bookmakers:       'pinnacle',
    commenceTimeFrom: windowFrom,
    commenceTimeTo:   windowTo,
  });

  try {
    const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const games = await res.json() as OddsH2HGame[];
    const game = games.find(g => teamsMatch(g.home_team, home) && teamsMatch(g.away_team, away));
    if (!game) return null;

    const bk = game.bookmakers.find(b => b.key === 'pinnacle') ?? game.bookmakers[0];
    if (!bk) return null;

    const h2h = bk.markets.find(m => m.key === 'h2h');
    if (!h2h) return null;

    const homeOut = h2h.outcomes.find(o => teamsMatch(o.name, home));
    const awayOut = h2h.outcomes.find(o => teamsMatch(o.name, away));
    const drawOut = h2h.outcomes.find(o => o.name === 'Draw');
    if (!homeOut || !awayOut || !drawOut) return null;

    return { home: homeOut.price, draw: drawOut.price, away: awayOut.price };
  } catch {
    return null;
  }
}

// ── CLV computation ───────────────────────────────────────────────────────────

// Maps EVMarket.label → h2h key for frozenOddsAtAnalysis lookup
const LABEL_TO_SIDE: Record<string, 'home' | 'draw' | 'away'> = {
  Home: 'home', Draw: 'draw', Away: 'away',
  home: 'home', draw: 'draw', away: 'away',
};

/** realisedCLV = closingIP − analysisIP for the top-pick side (home proxy if no 1X2 pick). */
export function computeRealisedClv(
  frozenOdds: Record<string, unknown>,
  closingOdds: { home: number; draw: number; away: number },
  topPickLabel: string | null,
): number | null {
  const side: 'home' | 'draw' | 'away' =
    (topPickLabel != null ? LABEL_TO_SIDE[topPickLabel] : null) ?? 'home';

  const analysisOdds = frozenOdds[side];
  if (typeof analysisOdds !== 'number' || analysisOdds <= 1) return null;

  const closingForSide = closingOdds[side];
  if (closingForSide <= 1) return null;

  return parseFloat(((1 / closingForSide) - (1 / analysisOdds)).toFixed(6));
}

// ── Match + resolve ───────────────────────────────────────────────────────────

function findMatch(record: AnalysisRecord, matches: FDMatch[]): FDMatch | null {
  const kickoffDate = record.kickoff.slice(0, 10);
  return matches.find(m =>
    m.utcDate.startsWith(kickoffDate) &&
    teamsMatch(record.home, m.homeTeam.name) &&
    teamsMatch(record.away, m.awayTeam.name),
  ) ?? null;
}

async function resolveRecord(
  record: AnalysisRecord,
  match: FDMatch,
  runId: string,
  oddsApiKey?: string,
): Promise<ResolutionRecord | null> {
  const { home: hGoals, away: aGoals } = match.score.fullTime;
  if (hGoals == null || aGoals == null) return null;

  const actualResult: 'home' | 'draw' | 'away' =
    hGoals > aGoals ? 'home' : hGoals === aGoals ? 'draw' : 'away';

  const rps = rpsScore(record.probabilities, actualResult);

  const drawCalibrationPoint = {
    league:    record.league,
    predicted: record.probabilities.draw,
    realised:  actualResult === 'draw' ? 1 : 0,
  };

  let realisedCLV: number | null = null;
  let clvSourceQuality: ClvSourceQuality = 'UNKNOWN';
  if (
    record.liquidityTag === 'CLV_ELIGIBLE' &&
    oddsApiKey &&
    record.frozenOddsAtAnalysis
  ) {
    const sportKey = LEAGUE_TO_SPORT[record.league];
    if (sportKey) {
      const closing = await fetchClosingOdds(
        oddsApiKey, record.home, record.away, sportKey, record.kickoff,
      );
      if (closing) {
        const topLabel = record.deterministicTopPick?.label ?? null;
        realisedCLV = computeRealisedClv(record.frozenOddsAtAnalysis, closing, topLabel);
        clvSourceQuality = 'KICKOFF_PROXY'; // Odds API retains upcoming events only — proxy, not tick-level
      }
    }
  }

  return {
    fixtureId:             record.fixtureId,
    runId,
    schemaVersion:         RESOLUTION_SCHEMA_VERSION,
    actualResult,
    homeGoals:             hGoals,
    awayGoals:             aGoals,
    realisedCLV,
    clvSourceQuality,
    rpsContribution:       parseFloat(rps.toFixed(6)),
    drawCalibrationPoint,
    resolvedAt:            new Date().toISOString(),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ResolveResult {
  resolved: ResolutionRecord[];
  unmatched: string[];   // fixtureIds with no match in the API response
}

export async function resolveRecords(
  records: AnalysisRecord[],
  footballDataApiKey: string,
  oddsApiKey?: string,
): Promise<ResolveResult> {
  if (!records.length) return { resolved: [], unmatched: [] };

  const runId = `resolve_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // All records should be from the same date; use kickoff of first record
  const date = records[0]!.kickoff.slice(0, 10);
  let matches: FDMatch[];

  try {
    matches = await fetchFinishedMatches(footballDataApiKey, date);
  } catch (err) {
    console.error('[resolve] Failed to fetch results:', err instanceof Error ? err.message : err);
    return { resolved: [], unmatched: records.map(r => r.fixtureId) };
  }

  console.log(`[resolve] ${matches.length} finished matches for ${date}`);

  const resolved: ResolutionRecord[] = [];
  const unmatched: string[] = [];

  for (const record of records) {
    const match = findMatch(record, matches);
    if (!match) {
      console.warn(`[resolve] No match found for ${record.home} vs ${record.away}`);
      unmatched.push(record.fixtureId);
      continue;
    }

    const rec = await resolveRecord(record, match, runId, oddsApiKey);
    if (rec) {
      resolved.push(rec);
      const clvStr = rec.realisedCLV != null ? ` CLV=${rec.realisedCLV.toFixed(4)}` : '';
      console.log(`[resolve] ${record.home} vs ${record.away}: ${match.score.fullTime.home}-${match.score.fullTime.away} → RPS=${rec.rpsContribution}${clvStr}`);
    } else {
      unmatched.push(record.fixtureId);
    }
  }

  return { resolved, unmatched };
}
