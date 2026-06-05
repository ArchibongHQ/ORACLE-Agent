/** Maps ORACLE market category + side labels to SportyBet search terms and selection text.
 *  Update selectors here when SportyBet changes their UI — isolated by design. */

export interface MarketMapping {
  /** Text to type into SportyBet's market filter / tab */
  sportyMarket: string;
  /** Text to match against the selection button label on SportyBet */
  sportySelection: string;
}

/** Normalise a string for fuzzy comparison (lowercase, strip punctuation). */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

/** Return true if `candidate` contains all words in `query` (order-independent). */
export function fuzzyMatch(query: string, candidate: string): boolean {
  const words = normalise(query).split(/\s+/);
  const norm = normalise(candidate);
  return words.every(w => norm.includes(w));
}

/** Map an ORACLE (cat, side) pair to a SportyBet market+selection string.
 *  Returns null when no mapping exists — caller adds pick to unmatched[]. */
export function mapMarket(cat: string, side: string | null): MarketMapping | null {
  const c = normalise(cat);
  const s = normalise(side ?? '');

  // ── 1x2 / Match Result ───────────────────────────────────────────────────
  if (c.includes('1x2') || c.includes('match result') || c.includes('full time result')) {
    if (s.includes('home') || s.includes('1'))  return { sportyMarket: '1X2', sportySelection: '1' };
    if (s.includes('draw') || s === 'x')        return { sportyMarket: '1X2', sportySelection: 'X' };
    if (s.includes('away') || s.includes('2'))  return { sportyMarket: '1X2', sportySelection: '2' };
  }

  // ── Goals Over/Under ─────────────────────────────────────────────────────
  if (c.includes('goal') || c.includes('o/u') || c.includes('over under') || c.includes('total')) {
    const lineMatch = s.match(/([\d.]+)/);
    const line = lineMatch ? lineMatch[1] : null;
    if (line) {
      if (s.includes('over') || s.startsWith('o'))  return { sportyMarket: 'Over/Under', sportySelection: `Over ${line}` };
      if (s.includes('under') || s.startsWith('u')) return { sportyMarket: 'Over/Under', sportySelection: `Under ${line}` };
    }
  }

  // ── Both Teams to Score ───────────────────────────────────────────────────
  if (c.includes('btts') || c.includes('both teams') || c.includes('gg')) {
    if (s.includes('yes') || s.includes('gg'))  return { sportyMarket: 'Both Teams to Score', sportySelection: 'Yes' };
    if (s.includes('no') || s.includes('ng'))   return { sportyMarket: 'Both Teams to Score', sportySelection: 'No' };
  }

  // ── Asian Handicap ────────────────────────────────────────────────────────
  if (c.includes('asian') || c.includes('handicap') || c.includes('ah')) {
    const lineMatch = s.match(/([+-]?[\d.]+)/);
    const line = lineMatch ? lineMatch[1] : '0';
    if (s.includes('home') || s.includes('ah home')) return { sportyMarket: 'Asian Handicap', sportySelection: `Home ${line}` };
    if (s.includes('away') || s.includes('ah away')) return { sportyMarket: 'Asian Handicap', sportySelection: `Away ${line}` };
  }

  // ── Double Chance ─────────────────────────────────────────────────────────
  if (c.includes('double chance') || c.includes('dc')) {
    if (s.includes('1x') || (s.includes('home') && s.includes('draw'))) return { sportyMarket: 'Double Chance', sportySelection: '1X' };
    if (s.includes('x2') || (s.includes('away') && s.includes('draw'))) return { sportyMarket: 'Double Chance', sportySelection: 'X2' };
    if (s.includes('12') || (s.includes('home') && s.includes('away'))) return { sportyMarket: 'Double Chance', sportySelection: '12' };
  }

  // ── Draw No Bet ───────────────────────────────────────────────────────────
  if (c.includes('draw no bet') || c.includes('dnb')) {
    if (s.includes('home')) return { sportyMarket: 'Draw No Bet', sportySelection: 'Home' };
    if (s.includes('away')) return { sportyMarket: 'Draw No Bet', sportySelection: 'Away' };
  }

  return null;
}
