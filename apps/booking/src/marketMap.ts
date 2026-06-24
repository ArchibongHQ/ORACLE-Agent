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
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

/** Return true if `candidate` contains all words in `query` (order-independent). */
export function fuzzyMatch(query: string, candidate: string): boolean {
  const words = normalise(query).split(/\s+/);
  const norm = normalise(candidate);
  return words.every((w) => norm.includes(w));
}

/** Map an ORACLE (cat, side) pair to a SportyBet market+selection string.
 *  Returns null when no mapping exists — caller adds pick to unmatched[]. */
export function mapMarket(cat: string, side: string | null): MarketMapping | null {
  const c = normalise(cat);
  const s = normalise(side ?? "");
  // Goal/handicap LINES must come from the RAW side — normalise() strips the
  // decimal point, so "Over 0.5" → "over 05" and a line regex on `s` yields
  // "05" instead of "0.5", producing a SportyBet selection that never matches.
  const lineFrom = (raw: string | null): string | null =>
    raw?.match(/(\d+(?:\.\d+)?)/)?.[1] ?? null;

  // ── 1x2 / Match Result ───────────────────────────────────────────────────
  if (c.includes("1x2") || c.includes("match result") || c.includes("full time result")) {
    if (s.includes("home") || s.includes("1")) return { sportyMarket: "1X2", sportySelection: "1" };
    if (s.includes("draw") || s === "x") return { sportyMarket: "1X2", sportySelection: "X" };
    if (s.includes("away") || s.includes("2")) return { sportyMarket: "1X2", sportySelection: "2" };
  }

  // ── Team Total (e.g. "Home Total Over 0.5") ──────────────────────────────
  // Must precede the generic goals/total branch below — cat "team total"
  // contains "total" and would otherwise misroute to the match-total market.
  if (c.includes("team total")) {
    const line = lineFrom(side);
    if (line && (s.includes("over") || s.includes("under"))) {
      const dir = s.includes("under") ? "Under" : "Over";
      if (s.includes("home"))
        return { sportyMarket: "Home Team Total", sportySelection: `${dir} ${line}` };
      if (s.includes("away"))
        return { sportyMarket: "Away Team Total", sportySelection: `${dir} ${line}` };
    }
  }

  // ── Asian 2 Goals (e.g. "Asian Over 2 Goals" / "Asian Under 2 Goals") ────
  // Must precede both the generic Goals Over/Under branch below (cat "Asian 2
  // Goals" contains "goal" and would otherwise be misrouted to the match-total
  // market) and the Asian Handicap branch (which only recognises home/away
  // sides and would silently drop this market).
  // NOTE: sportyMarket/sportySelection labels are best-effort, unverified live
  // against sportybet.com — confirm against the actual market tab text before
  // relying on this in production (see apps/booking/test/marketMap.test.ts).
  if (c.includes("asian") && c.includes("goal")) {
    const line = lineFrom(side);
    if (line && s.includes("over"))
      return { sportyMarket: "Asian Total Goals", sportySelection: `Over ${line}` };
    if (line && s.includes("under"))
      return { sportyMarket: "Asian Total Goals", sportySelection: `Under ${line}` };
  }

  // ── Goals Over/Under ─────────────────────────────────────────────────────
  if (c.includes("goal") || c.includes("o/u") || c.includes("over under") || c.includes("total")) {
    const line = lineFrom(side);
    if (line) {
      if (s.includes("over") || s.startsWith("o"))
        return { sportyMarket: "Over/Under", sportySelection: `Over ${line}` };
      if (s.includes("under") || s.startsWith("u"))
        return { sportyMarket: "Over/Under", sportySelection: `Under ${line}` };
    }
  }

  // ── Both Teams to Score ───────────────────────────────────────────────────
  if (c.includes("btts") || c.includes("both teams") || c.includes("gg")) {
    if (s.includes("yes") || s.includes("gg"))
      return { sportyMarket: "Both Teams to Score", sportySelection: "Yes" };
    if (s.includes("no") || s.includes("ng"))
      return { sportyMarket: "Both Teams to Score", sportySelection: "No" };
  }

  // ── Asian Handicap ────────────────────────────────────────────────────────
  if (c.includes("asian") || c.includes("handicap") || c.includes("ah")) {
    const lineMatch = s.match(/([+-]?[\d.]+)/);
    const line = lineMatch ? lineMatch[1] : "0";
    if (s.includes("home") || s.includes("ah home"))
      return { sportyMarket: "Asian Handicap", sportySelection: `Home ${line}` };
    if (s.includes("away") || s.includes("ah away"))
      return { sportyMarket: "Asian Handicap", sportySelection: `Away ${line}` };
  }

  // ── Double Chance ─────────────────────────────────────────────────────────
  if (c.includes("double chance") || c.includes("dc")) {
    if (s.includes("1x") || (s.includes("home") && s.includes("draw")))
      return { sportyMarket: "Double Chance", sportySelection: "1X" };
    if (s.includes("x2") || (s.includes("away") && s.includes("draw")))
      return { sportyMarket: "Double Chance", sportySelection: "X2" };
    if (s.includes("12") || (s.includes("home") && s.includes("away")))
      return { sportyMarket: "Double Chance", sportySelection: "12" };
  }

  // ── Draw No Bet ───────────────────────────────────────────────────────────
  if (c.includes("draw no bet") || c.includes("dnb")) {
    if (s.includes("home")) return { sportyMarket: "Draw No Bet", sportySelection: "Home" };
    if (s.includes("away")) return { sportyMarket: "Draw No Bet", sportySelection: "Away" };
  }

  // ── Win Either Half (e.g. "Win Either Half (H)" / "Win Either Half (A)") ──
  // NOTE: label unverified live — see Asian 2 Goals note above.
  if (c.includes("win either half")) {
    // normalise() strips parens, so "Win Either Half (H)" → "win either half h"
    if (s.endsWith(" h") || s.includes("home"))
      return { sportyMarket: "Win Either Half", sportySelection: "Home" };
    if (s.endsWith(" a") || s.includes("away"))
      return { sportyMarket: "Win Either Half", sportySelection: "Away" };
  }

  // ── First Half (e.g. "FH Under 1.5 Goals" / "FH Draw") ───────────────────
  // NOTE: label unverified live — see Asian 2 Goals note above.
  if (c.includes("first half")) {
    if (s.includes("draw")) return { sportyMarket: "1st Half Result", sportySelection: "X" };
    const line = lineFrom(side);
    if (line && (s.includes("over") || s.includes("under"))) {
      const dir = s.includes("under") ? "Under" : "Over";
      return { sportyMarket: "1st Half Goals", sportySelection: `${dir} ${line}` };
    }
  }

  return null;
}

/** How to find a market's outcome on the SportyBet fixture detail page.
 *  Bridges `MarketMapping` (ORACLE's internal convention, exercised by
 *  marketMap.test.ts) to the page's real header text and selection labels —
 *  several diverge from the internal sportyMarket/sportySelection strings
 *  (e.g. "Both Teams to Score" → "GG/NG"), so the translation happens here,
 *  at the page.ts boundary, rather than by changing mapMarket()'s output. */
export interface PageTarget {
  /** Returns true if a detail-page block's header text is this market. */
  headerMatches: (headerText: string) => boolean;
  /** Returns true if an outcome's first .m-table-cell-item label is the target selection. */
  labelMatches: (labelText: string) => boolean;
  /** Optional: when a market repeats across multiple same-header blocks (lines),
   *  filter to the block containing this specific line. */
  lineFilter?: (blockText: string) => boolean;
}

const exact = (want: string) => (text: string) => text.trim() === want;

/** Resolve a MarketMapping + pick into real page header/selection predicates.
 *  Returns null when the market has no confirmed live mapping (see Asian Total
 *  Goals note below) — callers must treat that as "leg cannot be booked", not retry. */
export function resolvePageTarget(
  mapping: MarketMapping,
  pick: { home: string; away: string }
): PageTarget | null {
  const { sportyMarket, sportySelection } = mapping;
  const sel = sportySelection.toLowerCase();

  switch (sportyMarket) {
    case "1X2":
      // Detail-page 1X2 block (decoys "1X2 - 1UP"/"1X2 - 2UP"/"1X2 - Never Down"
      // share the prefix, so match the header exactly).
      return { headerMatches: exact("1X2"), labelMatches: exact(sportySelection) };

    case "Over/Under": {
      // sportySelection is "Over {line}" / "Under {line}" — line carries the literal
      // .5, so match the label exactly; the header "Over/Under" repeats per line,
      // so the caller must scan all matching blocks for the one with this label.
      return { headerMatches: exact("Over/Under"), labelMatches: exact(sportySelection) };
    }

    case "Both Teams to Score":
      // Real header is "GG/NG", not "Both Teams to Score" (decoy: "GG/NG 2+").
      return { headerMatches: exact("GG/NG"), labelMatches: exact(sportySelection) };

    case "Asian Handicap": {
      // sportySelection is "Home {signedLine}" / "Away {signedLine}". The header
      // embeds the HOME-relative signed line (e.g. "Asian Handicap -0.5" pairs
      // "Home (-0.5)" with "Away (+0.5)"); an Away-side pick's line is mirrored
      // (negated) to find the matching header.
      const m = sportySelection.match(/^(Home|Away)\s+([+-]?\d+(?:\.\d+)?)/i);
      if (!m) return null;
      const side = (m[1] ?? "").toLowerCase();
      const lineNum = parseFloat(m[2] ?? "0");
      const homeLine = side === "home" ? lineNum : -lineNum;
      // Header line text has no redundant leading "+" (e.g. "Asian Handicap 0.5",
      // not "Asian Handicap +0.5") but keeps "-" — `${homeLine}` already does this.
      return {
        headerMatches: exact(`Asian Handicap ${homeLine}`),
        // Cell label is "Home (-0.5)" / "Away (+0.5)" — match by side + numeric line,
        // tolerant of the page's fixed one-decimal formatting (e.g. "(-1.0)" vs "-1").
        labelMatches: (labelText) => {
          const lm = labelText.match(/^(Home|Away)\s*\(([+-]?\d+(?:\.\d+)?)\)/i);
          if (!lm) return false;
          const lSide = (lm[1] ?? "").toLowerCase();
          const lLine = parseFloat(lm[2] ?? "0");
          return lSide === side && Math.abs(lLine - lineNum) < 1e-6;
        },
      };
    }

    case "Home Team Total":
    case "Away Team Total": {
      // Real header is "{ActualTeamName} Over/Under" — built dynamically from the
      // pick's own team name (fuzzy, since ORACLE's name may not byte-match
      // SportyBet's), not the literal "Home Team Total"/"Away Team Total".
      const teamName = sportyMarket === "Home Team Total" ? pick.home : pick.away;
      const teamWords = normalise(teamName)
        .split(" ")
        .filter((w) => w.length > 2);
      return {
        headerMatches: (headerText) => {
          if (!/ Over\/Under$/.test(headerText.trim())) return false;
          const headerNorm = normalise(headerText.replace(/Over\/Under$/, ""));
          return teamWords.length > 0 && teamWords.some((w) => headerNorm.includes(w));
        },
        labelMatches: exact(sportySelection),
      };
    }

    case "Double Chance": {
      // Real labels are NOT "1X"/"X2"/"12" — translate to the page's actual text.
      const labelBySelection: Record<string, string> = {
        "1x": "Home or Draw",
        x2: "Draw or Away",
        "12": "Home or Away",
      };
      const realLabel = labelBySelection[sel];
      if (!realLabel) return null;
      // Decoy "Double Chance - 1UP" shares the prefix — match header exactly.
      return { headerMatches: exact("Double Chance"), labelMatches: exact(realLabel) };
    }

    case "Draw No Bet":
      // Decoys "1st Half - Draw No Bet"/"2nd Half - Draw No Bet" are full separate
      // strings, not substrings of "Draw No Bet" — exact match is safe.
      return { headerMatches: exact("Draw No Bet"), labelMatches: exact(sportySelection) };

    case "Win Either Half": {
      // Two separate blocks (one per team), each with Yes/No — not one block with
      // Home/Away outcomes as the internal mapping's "Home"/"Away" selection implies.
      const header =
        sel === "home" ? "Home Team to Win Either Half" : "Away Team to Win Either Half";
      return { headerMatches: exact(header), labelMatches: exact("Yes") };
    }

    case "1st Half Result":
      // Follows the confirmed "1st Half - {market}" prefix pattern; outcomes are
      // presumably Home/Draw/Away like match 1X2 (not independently re-probed).
      return { headerMatches: exact("1st Half - 1X2"), labelMatches: exact(sportySelection) };

    case "1st Half Goals":
      return {
        headerMatches: exact("1st Half - Over/Under"),
        labelMatches: exact(sportySelection),
      };

    case "Asian Total Goals":
      // NOT FOUND live: probed Premier League (Arsenal v Coventry City) + two World
      // Cup fixtures (Portugal v Uzbekistan, Switzerland v Canada) on 2026-06-23 —
      // no "Asian Total Goals"/"Asian 2 Goals"-shaped header exists on any of them.
      // Leaving unmapped rather than guessing a header string that might silently
      // match the wrong market.
      return null;

    default:
      return null;
  }
}
