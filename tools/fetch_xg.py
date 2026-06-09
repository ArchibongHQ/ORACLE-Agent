"""fetch_xg.py — Download per-match xG data from Understat and cache to .tmp/xg/.

Understat covers the top 5 European leagues: EPL, La Liga, Bundesliga, Serie A, Ligue 1.
Data is free, no API key required. Extracted via Playwright from the window.datesData global.

Output: .tmp/xg/{div}_{fdco_season}.csv
  Columns: date, home, away, xg_home, xg_away, goals_home, goals_away
  Filename uses football-data.co.uk conventions (e.g. E0_2324.csv) for easy join in gbm_residual.py.

Usage:
    python tools/fetch_xg.py                          # all leagues, all available seasons
    python tools/fetch_xg.py --leagues EPL Bundesliga  # specific leagues
    python tools/fetch_xg.py --seasons 2023 2022       # specific seasons (year = season start)
    python tools/fetch_xg.py --dry-run                 # print counts without writing
    python tools/fetch_xg.py --force                   # re-fetch even if cached
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

try:
    from playwright.async_api import async_playwright, Browser
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

OUTPUT_DIR = Path(".tmp/xg")

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

# Understat league slugs → football-data.co.uk div code
LEAGUE_MAP: dict[str, str] = {
    "EPL":        "E0",
    "La_liga":    "SP1",
    "Bundesliga": "D1",
    "Serie_A":    "I1",
    "Ligue_1":    "F1",
}

# Understat seasons: year = season start (e.g. 2023 = 2023/24)
SEASONS = list(range(2014, 2025))


def season_to_fdco(season: int) -> str:
    """2023 → '2324'  (football-data.co.uk naming convention)"""
    return f"{str(season)[2:]}{str(season + 1)[2:]}"


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = "date,home,away,xg_home,xg_away,goals_home,goals_away\n"
    lines = [
        f"{r['date']},{r['home']},{r['away']},{r['xg_home']:.4f},{r['xg_away']:.4f},{r['goals_home']},{r['goals_away']}\n"
        for r in rows
    ]
    path.write_text(header + "".join(lines), encoding="utf-8")


async def fetch_league_season(browser: "Browser", league_slug: str, season: int) -> list[dict]:
    """Extract match xG data from window.datesData on the Understat league page."""
    url = f"https://understat.com/league/{league_slug}/{season}"
    page = await browser.new_page()
    rows: list[dict] = []
    try:
        await page.goto(url, wait_until="networkidle", timeout=40_000)
        await page.wait_for_timeout(1_000)

        raw = await page.evaluate(
            "() => typeof datesData !== 'undefined' ? JSON.stringify(datesData) : '[]'"
        )
        matches = json.loads(raw)

        for m in matches:
            if not m.get("isResult"):
                continue
            try:
                rows.append({
                    "date":       m["datetime"][:10],
                    "home":       m["h"]["title"],
                    "away":       m["a"]["title"],
                    "xg_home":   float(m["xG"]["h"]),
                    "xg_away":   float(m["xG"]["a"]),
                    "goals_home": int(m["goals"]["h"]),
                    "goals_away": int(m["goals"]["a"]),
                })
            except (KeyError, ValueError, TypeError):
                continue
    except Exception as exc:
        print(f"[xg] WARN: {league_slug}/{season}: {exc}", file=sys.stderr)
    finally:
        await page.close()
    return rows


async def run(args: argparse.Namespace) -> None:
    if not HAS_PLAYWRIGHT:
        print("[xg] ERROR: Playwright not installed. Run: pip install playwright && python -m playwright install chromium")
        sys.exit(1)

    total_rows = 0
    total_files = 0

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            user_agent=_UA,
            viewport={"width": 1280, "height": 800},
            locale="en-GB",
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )

        for league_slug in args.leagues:
            if league_slug not in LEAGUE_MAP:
                print(f"[xg] Unknown league: {league_slug}. Available: {list(LEAGUE_MAP)}")
                continue
            div = LEAGUE_MAP[league_slug]

            for season in sorted(args.seasons):
                fdco_season = season_to_fdco(season)
                out_path = OUTPUT_DIR / f"{div}_{fdco_season}.csv"

                if out_path.exists() and not args.force:
                    n = sum(1 for _ in out_path.read_text().splitlines()) - 1
                    print(f"[xg] CACHED {league_slug} {season}/{season+1}: {n} matches -> {out_path.name}")
                    total_rows += n
                    total_files += 1
                    continue

                print(f"[xg] Fetching {league_slug} {season}/{season+1}...", end=" ", flush=True)
                # Create a fresh page per request using the shared context
                page = await ctx.new_page()
                rows: list[dict] = []
                try:
                    url = f"https://understat.com/league/{league_slug}/{season}"
                    await page.goto(url, wait_until="networkidle", timeout=40_000)
                    await page.wait_for_timeout(800)
                    raw = await page.evaluate(
                        "() => typeof datesData !== 'undefined' ? JSON.stringify(datesData) : '[]'"
                    )
                    matches = json.loads(raw)
                    for m in matches:
                        if not m.get("isResult"):
                            continue
                        try:
                            rows.append({
                                "date":       m["datetime"][:10],
                                "home":       m["h"]["title"],
                                "away":       m["a"]["title"],
                                "xg_home":   float(m["xG"]["h"]),
                                "xg_away":   float(m["xG"]["a"]),
                                "goals_home": int(m["goals"]["h"]),
                                "goals_away": int(m["goals"]["a"]),
                            })
                        except (KeyError, ValueError, TypeError):
                            continue
                except Exception as exc:
                    print(f"WARN: {exc}", file=sys.stderr)
                finally:
                    await page.close()

                print(f"{len(rows)} matches")

                if rows and not args.dry_run:
                    write_csv(rows, out_path)
                    total_files += 1

                total_rows += len(rows)
                time.sleep(0.5)

        await browser.close()

    print(f"\n[xg] Done — {total_rows} total match rows across {total_files} files")
    if not args.dry_run:
        print(f"[xg] Output: {OUTPUT_DIR.resolve()}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch Understat xG data via Playwright")
    parser.add_argument("--leagues", nargs="*", default=list(LEAGUE_MAP.keys()),
                        help="Understat league slugs (default: all 5)")
    parser.add_argument("--seasons", nargs="*", type=int, default=SEASONS,
                        help="Season start years e.g. 2023 2022")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print row counts without writing files")
    parser.add_argument("--force", action="store_true",
                        help="Re-fetch even if cache file exists")
    args = parser.parse_args()

    asyncio.run(run(args))


if __name__ == "__main__":
    main()
