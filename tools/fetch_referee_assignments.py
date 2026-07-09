#!/usr/bin/env python3
"""fetch_referee_assignments.py — EPL referee-assignment scraper (PR-25 item 2).

Scrapes premierleague.com's "Match Officials for Matchweek N" articles
(e.g. https://www.premierleague.com/en/news/4658324/match-officials-for-matchweek-38)
— the only pre-match, keyless, no-login source found for advance referee
appointments (verified real-time research: FBref only publishes the referee
name in the POST-match report; Sofascore's pre-match referee.name field is
too unreliable). Plain HTML, ~4-7 days ahead of kickoff.

REAL STRUCTURE, verified live 2026-07-09 against Matchweek 38's article (NOT
guessed — fetched the actual HTML and Playwright-rendered the actual page
before writing this):

  Each referee assignment is a plain, un-nested <p> in the article body:
    <p><strong>Referee</strong>: Sam Barrott. <strong>Assistants</strong>:
    Simon Bennett, Blake Antrobus. <strong>Fourth official</strong>: Ruebyn
    Ricardo. <strong>VAR</strong>: Stuart Attwell. <strong>Assistant VAR</strong>:
    Steve Meredith.</p>

  Each referee <p> is immediately preceded by an EMPTY widget div:
    <div class="articleWidget full-width">
      <div data-d2c class="embeddable-match-card"
           data-widget="match-card/embeddable-match-card"
           data-match-reference="2562265" data-title=""></div>
    </div>

  THE CRITICAL GOTCHA: the fixture (home/away team names) is NOT anywhere in
  the static HTML — the widget div is empty and gets its content (team
  names, score/kickoff-time, competition, date) filled in CLIENT-SIDE by JS
  after page load (same "loads entirely client-side" pattern already
  documented for BBC Sport in scrape_fixtures.py — that's why this module
  needs Playwright, not requests+regex/BeautifulSoup, despite the referee
  text itself being static). Confirmed by rendering the SAME real article
  with Playwright: `.embeddable-match-card` elements resolve to innerText
  like "See all\\nBrighton\\n0 - 3\\nMan Utd\\nFT\\nPremier League•Sun 24 May"
  (a COMPLETED match's card — an upcoming/scheduled one would show a kickoff
  time in place of the score/"FT", not yet independently verified — see the
  KNOWN LIMITATION below).

  Pairing: within the rendered DOM, each match-card widget appears
  immediately before its corresponding referee <p>, in the SAME order — so
  zipping the two lists by position (after Playwright resolves the widgets)
  correctly associates referee -> fixture. This is verified against the real
  Matchweek 38 page: 10 widgets, 10 referee paragraphs, same order.

KNOWN LIMITATION — discovery is NOT implemented (documented honestly, not
silently glossed over, per this repo's own convention for partial features
— see e.g. the GBM residual model or ClubElo write-ups). This module can
resolve a GIVEN article URL into a fixture->referee mapping reliably, but
there is no automated "find this week's Matchweek article URL" step:

  - premierleague.com's own news listing (/en/news) and search
    (/en/search?query=...) pages are ALSO client-side rendered with no
    stable server-side link list or discoverable JSON API found in the
    research budget for this PR (verified: a plain-HTML fetch of /en/news
    returns zero "officials-for-matchweek" links; a Playwright-rendered
    site search for "match officials" surfaces generic/unrelated news, not
    officiating articles specifically).
  - This can't be independently re-verified against a LIVE upcoming
    matchweek right now either — as of this PR (2026-07-09) the Premier
    League is in its summer off-season with no current/upcoming matchweek
    officials article to test discovery against.

  Extension path for a future PR: either (a) a scheduled/manually-updated
  config value for "this week's article URL" (simplest, matches this
  scraper's actual current usage: pass --url explicitly), or (b) a spike
  into whether premierleague.com's Next.js bundle exposes a stable
  news-by-category or news-by-tag JSON endpoint (common on Pulse Live sites
  but not confirmed here), or (c) extending the widget-resolution approach
  above to whatever page eventually surfaces the current week's link.
  EPL-ONLY: extending to other leagues (Bundesliga/DFB, Ligue 1/FFF, La
  Liga/CTA-RFEF, Serie A/AIA) means finding each federation's own equivalent
  advance-appointment page and writing a new per-league parser/resolver —
  none of that research was in scope for this PR.

Output (when a URL IS given, --url or explicitly wired): .tmp/oracle-store/
referee_assignments.json:
  {
    "computedAt": ISO8601, "source": "<article url>", "league": "Premier League",
    "assignments": [
      {"home": "Brighton", "away": "Man Utd", "referee": "Sam Barrott",
       "dateRaw": "Sun 24 May"}, ...
    ]
  }

Fails OPEN on any failure (network error, Playwright unavailable, structure
mismatch, length mismatch between referees and cards) — writes an empty
assignments list and exits 0, matching this repo's "missing data is never a
blocker" convention. Never crashes the caller.

Usage:
    python tools/fetch_referee_assignments.py --url <matchweek officials URL>
    python tools/fetch_referee_assignments.py --url <URL> --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

try:
    from playwright.async_api import async_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / ".tmp" / "oracle-store" / "referee_assignments.json"

_CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# Matches "<strong>Referee</strong>: NAME. <strong>Assistants</strong>: A, B. ..."
# text extracted from each referee <p> (via Playwright's inner_text, which
# strips the <strong> tags but keeps the labels as plain text next to their
# values — verified against the real rendered paragraph text).
_REFEREE_LINE_RE = re.compile(
    r"Referee:\s*([^.]+)\.\s*"
    r"Assistants:\s*([^.]+)\.\s*"
    r"Fourth official:\s*([^.]+)\.\s*"
    r"VAR:\s*([^.]+)\.\s*"
    r"Assistant VAR:\s*([^.]+)\.?",
    re.IGNORECASE,
)


def _warn(msg: str) -> None:
    print(f"[referee-assignments] WARN: {msg}", file=sys.stderr)


@dataclass
class RefereeBlock:
    referee: str
    assistants: list[str]
    fourth_official: str
    var: str
    assistant_var: str


def parse_referee_text(text: str) -> Optional[RefereeBlock]:
    """Parse one referee <p>'s rendered inner text (e.g. "Referee: Sam
    Barrott. Assistants: Simon Bennett, Blake Antrobus. Fourth official:
    Ruebyn Ricardo. VAR: Stuart Attwell. Assistant VAR: Steve Meredith.")
    into a RefereeBlock. Strips a trailing "(pictured)" annotation
    (premierleague.com convention for the matchweek's marquee referee photo).
    Returns None when the text doesn't match the expected shape — a
    malformed/changed block must not crash the batch, just be skipped."""
    m = _REFEREE_LINE_RE.search(text)
    if not m:
        return None
    referee = re.sub(r"\s*\(pictured\)\s*", "", m.group(1)).strip()
    assistants = [a.strip() for a in m.group(2).split(",") if a.strip()]
    return RefereeBlock(
        referee=referee,
        assistants=assistants,
        fourth_official=m.group(3).strip(),
        var=m.group(4).strip(),
        assistant_var=m.group(5).strip(),
    )


@dataclass
class MatchCard:
    home: str
    away: str
    date_raw: str
    status_raw: str


def parse_match_card_text(text: str) -> Optional[MatchCard]:
    """Parse a rendered `.embeddable-match-card` widget's inner text into a
    MatchCard. Verified real shape (completed matchweek, Playwright-rendered
    2026-07-09): "See all\\nBrighton\\n0 - 3\\nMan Utd\\nFT\\nPremier
    League•Sun 24 May" -> 6 lines after the leading "See all" button label:
    [home, mid(score/time), away, status, "League•date"].

    KNOWN LIMITATION: only verified against a COMPLETED matchweek's cards
    (status "FT"). An upcoming/not-yet-played matchweek's card is expected to
    show a scheduled kickoff time instead of a score and a different status
    token in the same line positions, based on premierleague.com's fixture
    list card widget elsewhere on the site, but this exact shape has not
    been independently confirmed for the embeddable-match-card component on
    an officials article (the site was in its off-season, no live upcoming
    matchweek article existed to test against at write-time). The line-count
    based parse below is deliberately POSITION-based (5 lines after "See
    all", not content-based pattern matching on the middle token), so it
    should tolerate a score vs. a kickoff-time in that slot without a code
    change — but this assumption needs a live re-check once the season
    resumes and a genuine upcoming-matchweek article is available.

    Returns None when the text doesn't have the expected 5-line shape after
    stripping "See all" — a malformed/changed card must not crash the batch."""
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    if lines and lines[0].lower() == "see all":
        lines = lines[1:]
    if len(lines) != 5:
        return None
    home, _mid, away, status, league_date = lines
    date_raw = league_date.split("•", 1)[-1].strip() if "•" in league_date else league_date
    return MatchCard(home=home, away=away, date_raw=date_raw, status_raw=status)


@dataclass
class RefereeAssignment:
    home: str
    away: str
    referee: str
    date_raw: str


def pair_assignments(
    referee_blocks: list[RefereeBlock], cards: list[MatchCard]
) -> list[RefereeAssignment]:
    """Zip referee blocks with match cards by POSITION (verified: on the
    real page, each widget immediately precedes its referee paragraph, same
    document order). Length mismatch (a widget or paragraph failed to parse)
    degrades to pairing only the overlapping prefix — never raises, never
    silently mispairs the tail past the shorter list."""
    n = min(len(referee_blocks), len(cards))
    if len(referee_blocks) != len(cards):
        _warn(
            f"referee/card count mismatch ({len(referee_blocks)} referees, "
            f"{len(cards)} cards) — pairing only the first {n}"
        )
    out: list[RefereeAssignment] = []
    for i in range(n):
        rb, card = referee_blocks[i], cards[i]
        out.append(
            RefereeAssignment(
                home=card.home, away=card.away, referee=rb.referee, date_raw=card.date_raw
            )
        )
    return out


async def _fetch_rendered(url: str) -> tuple[list[str], list[str]]:
    """Playwright-render `url`, returning (referee_paragraph_texts,
    match_card_texts) in document order. Returns ([], []) on ANY failure —
    fail-open, never raises past this function."""
    if not HAS_PLAYWRIGHT:
        _warn("playwright not installed — skipping")
        return [], []
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            try:
                page = await browser.new_page(user_agent=_CHROME_UA)
                await page.goto(url, wait_until="networkidle", timeout=45_000)
                await page.wait_for_timeout(1500)
                # Referee paragraphs: the article body's <p> tags that mention
                # "Referee:" — matches this repo's tolerant-selector convention
                # (BBC/Flashscore scrapers filter broad selectors in JS, not a
                # narrow CSS-only selector that a markup tweak could break).
                referee_texts: list[str] = await page.eval_on_selector_all(
                    ".article__content p",
                    "els => els.map(e => e.innerText).filter(t => t.includes('Referee:'))",
                )
                card_texts: list[str] = await page.eval_on_selector_all(
                    ".embeddable-match-card", "els => els.map(e => e.innerText)"
                )
                return referee_texts, card_texts
            finally:
                await browser.close()
    except Exception as exc:
        _warn(f"fetch/render failed: {exc}")
        return [], []


async def fetch_referee_assignments(url: str) -> list[RefereeAssignment]:
    """Fetch + parse one Matchweek officials article into fixture->referee
    assignments. Fail-open: any stage failing returns []."""
    referee_texts, card_texts = await _fetch_rendered(url)
    if not referee_texts or not card_texts:
        return []
    referee_blocks = [b for t in referee_texts if (b := parse_referee_text(t)) is not None]
    cards = [c for t in card_texts if (c := parse_match_card_text(t)) is not None]
    if not referee_blocks or not cards:
        return []
    return pair_assignments(referee_blocks, cards)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape a premierleague.com Match Officials article (EPL only)"
    )
    parser.add_argument(
        "--url", type=str, default=None,
        help="Match Officials article URL (required — no automated discovery, see module docstring)",
    )
    parser.add_argument("--dry-run", action="store_true", help="print without writing the JSON")
    args = parser.parse_args()

    if not args.url:
        _warn("no --url given and automated discovery is not implemented (see module docstring) "
              "— writing an empty assignments list")
        assignments: list[RefereeAssignment] = []
        source = ""
    else:
        assignments = asyncio.run(fetch_referee_assignments(args.url))
        source = args.url

    print(f"[referee-assignments] {len(assignments)} fixture(s) resolved from {source or '(none)'}")

    if args.dry_run:
        for a in assignments:
            print(f"  {a.home} vs {a.away}: {a.referee} ({a.date_raw})")
        print("[referee-assignments] Dry run — nothing written.")
        return

    payload = {
        "computedAt": datetime.now(tz=timezone.utc).isoformat(),
        "source": source,
        "league": "Premier League",
        "assignments": [
            {"home": a.home, "away": a.away, "referee": a.referee, "dateRaw": a.date_raw}
            for a in assignments
        ],
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[referee-assignments] -> {OUT_PATH}  ({len(assignments)} fixtures)")


if __name__ == "__main__":
    main()
