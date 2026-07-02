"""fetch_sofascore.py — per-team stats via Sofascore (Playwright, non-headless).

Confirmed live 2026-06-23 (see oracle_market_capture_and_swarm_scope memory):
api.sofascore.com 403s on plain unauthenticated HTTP (TLS/JS fingerprinting,
not a visible CAPTCHA), and — unlike most sites in this codebase —
`headless=True` ALSO fails the fingerprint check here (not just the
ORB-blocked-request issue `--disable-blink-features` normally fixes
elsewhere). `headless=False` is REQUIRED for this site specifically. No other
scraper in this codebase needs that; don't copy this flag elsewhere without
re-verifying it's actually needed (non-headless launches are slower & can't
run on a true headless VPS without a virtual display like Xvfb).

Team-ID resolution: api.sofascore.com/api/v1/search/* itself also 403s even
through the browser (didn't get past the homepage's live-search XHR in
several attempts), but the SITE's own search box renders result links
straight into the DOM (`a[href*="/team/"]`) after typing a query — no API
interception needed for this step at all. Filters out women/U-age variants
the same way Transfermarkt search needs to (multiple suffix variants returned
for the same club name).

Once on the resolved team page, the page's own XHRs to api.sofascore.com
(player-statistics/seasons, standings/seasons, events/last/0, events/next/0)
are captured via Playwright response interception — the real browser's TLS/JS
fingerprint passes where a bare requests.get() doesn't.

GPU-safety: Playwright/browser-page workload (see
oracle_swarm_gpu_bsod_incident memory) — call sites MUST run this
sequentially, never fan it out concurrently with other browser-page swarms
on local Windows.

Usage:
    python tools/fetch_sofascore.py --team "Arsenal"
    python tools/fetch_sofascore.py --team "Arsenal" --out .tmp/sofascore/arsenal.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any, Optional

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

try:
    from playwright.async_api import async_playwright, BrowserContext
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xg_extract import best_team_xg  # noqa: E402

try:
    from scrape_fixtures import normalise
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import normalise

ROOT = Path(__file__).resolve().parent.parent
SOFASCORE_DIR = ROOT / ".tmp" / "sofascore"
XG_OUTPUT_PATH = ROOT / ".tmp" / "xg" / "sofascore_xg.json"

_CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

_CONSENT_SELECTORS = [
    "#onetrust-accept-btn-handler",
    "button:has-text('Accept all')",
    "button:has-text('Accept All')",
    "button:has-text('I Accept')",
    "button:has-text('Agree')",
    "button:has-text('Consent')",
]

# Same disambiguation principle as scrape_transfermarkt_live.py — Sofascore's
# search returns women/U-age sides under the same club name (e.g.
# "Arsenal Women", "Arsenal U21") alongside the senior team.
_YOUTH_WOMEN_RE = re.compile(r"-(women|u1[5-9]|u2[0-3])(/|$)", re.IGNORECASE)

_TARGET_API_PATHS = ("player-statistics/seasons", "standings/seasons", "events/last/0", "events/next/0")


def _warn(msg: str) -> None:
    print(f"[fetch-sofascore] WARN: {msg}", file=sys.stderr)


async def _dismiss_consent(page: Any) -> None:
    for sel in _CONSENT_SELECTORS:
        try:
            loc = page.locator(sel).first
            if await loc.is_visible(timeout=1500):
                await loc.click()
                await page.wait_for_timeout(600)
                return
        except Exception:
            pass


async def _resolve_team_path(ctx: BrowserContext, team: str) -> Optional[str]:
    """Type `team` into Sofascore's own search box and read the first senior
    men's team result straight out of the rendered DOM — no API call needed
    for this step (api.sofascore.com/search 403s even through the browser)."""
    page = await ctx.new_page()
    try:
        await page.goto("https://www.sofascore.com/", wait_until="domcontentloaded", timeout=20000)
        await _dismiss_consent(page)
        await page.wait_for_timeout(1500)
        await page.click('input[placeholder*="Search"]', timeout=5000)
        await page.keyboard.type(team, delay=120)
        await page.wait_for_timeout(2500)
        hrefs: list[str] = await page.evaluate(
            "() => Array.from(document.querySelectorAll('a[href*=\"/team/\"]'))"
            ".map(a => a.getAttribute('href'))"
        )
        for href in hrefs or []:
            if not href or "/team/" not in href:
                continue
            if _YOUTH_WOMEN_RE.search(href):
                continue
            return href
        return None
    except Exception as exc:
        _warn(f"team search failed for {team!r}: {exc}")
        return None
    finally:
        await page.close()


async def _fetch_team_stats(ctx: BrowserContext, team_path: str) -> dict[str, Any]:
    """Navigate to the resolved team page and capture the stats/standings/
    fixtures JSON the page's own XHRs pull from api.sofascore.com."""
    captured: dict[str, str] = {}

    async def _on_response(resp: Any) -> None:
        try:
            url = resp.url
            if "sofascore.com/api/v1" in url and any(p in url for p in _TARGET_API_PATHS):
                if resp.status == 200 and url not in captured:
                    captured[url] = await resp.text()
        except Exception:
            pass

    page = await ctx.new_page()
    page.on("response", lambda r: asyncio.ensure_future(_on_response(r)))
    try:
        url = f"https://www.sofascore.com{team_path}"
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        await _dismiss_consent(page)
        await page.wait_for_timeout(4000)
    except Exception as exc:
        _warn(f"team page load failed for {team_path}: {exc}")
    finally:
        await page.close()

    parsed: dict[str, Any] = {}
    for url, body in captured.items():
        try:
            parsed[url] = json.loads(body)
        except ValueError:
            continue
    return parsed


async def fetch_sofascore_team(team: str) -> Optional[dict[str, Any]]:
    """Single-team fetch: launches its OWN browser. Convenient for the CLI/
    one-off case, but do NOT call this in a loop for multiple teams — each
    call is a full Chromium process, and this site needs headless=False (see
    module docstring), so N teams means N visible browser windows. Use
    fetch_sofascore_batch for more than one team (shared browser, one page
    per worker, properly capped)."""
    if not HAS_PLAYWRIGHT:
        _warn("Playwright not installed — skipping Sofascore")
        return None

    async with async_playwright() as pw:
        # headless=False is required for THIS site specifically — see module
        # docstring. Every other browser-based scraper in this codebase runs
        # headless=True; do not copy this flag onto them without re-verifying.
        browser = await pw.chromium.launch(
            headless=False,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            user_agent=_CHROME_UA,
            viewport={"width": 1280, "height": 800},
            locale="en-GB",
            extra_http_headers={"Accept-Language": "en-GB,en;q=0.9"},
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )
        try:
            team_path = await _resolve_team_path(ctx, team)
            if not team_path:
                return None
            stats = await _fetch_team_stats(ctx, team_path)
            if not stats:
                return None
            return {"team": team, "team_path": team_path, "stats": stats}
        finally:
            await browser.close()


async def _fetch_one_in_ctx(ctx: BrowserContext, team: str) -> Optional[dict[str, Any]]:
    team_path = await _resolve_team_path(ctx, team)
    if not team_path:
        return None
    stats = await _fetch_team_stats(ctx, team_path)
    if not stats:
        return None
    return {"team": team, "team_path": team_path, "stats": stats}


async def fetch_sofascore_batch(teams: list[str], max_workers: Optional[int] = None) -> dict[str, dict[str, Any]]:
    """Multi-team fetch: ONE shared non-headless browser context (all pages
    share the same visible window), bounded concurrency via
    swarm_dispatch.browser_swarm_max_workers — mirrors enrich_news.py's
    _fetch_google_ai_batch pattern instead of one browser process per team
    (the GPU-overload pattern that caused the 2026-06-23 BSOD incident, see
    oracle_swarm_gpu_bsod_incident memory).

    Requires a real display — headless=False can't run on a true headless
    VPS without a virtual display (e.g. Xvfb). On a VPS deployment without
    one configured, this returns {} for the whole batch (Playwright's launch
    raises immediately) rather than partially crashing — callers should treat
    that exactly like "Sofascore unavailable this run," never a block.

    A team's fetch failure degrades to that team being absent from the result
    dict — never raises, never blocks the rest of the batch."""
    out: dict[str, dict[str, Any]] = {}
    if not HAS_PLAYWRIGHT or not teams:
        return out

    try:
        from swarm_dispatch import browser_swarm_max_workers
    except ImportError:  # repo root on sys.path instead of tools/
        from tools.swarm_dispatch import browser_swarm_max_workers

    cap = max_workers if max_workers is not None else browser_swarm_max_workers(len(teams))
    sem = asyncio.Semaphore(max(1, cap))

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=False,
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            )
            ctx = await browser.new_context(
                user_agent=_CHROME_UA,
                viewport={"width": 1280, "height": 800},
                locale="en-GB",
                extra_http_headers={"Accept-Language": "en-GB,en;q=0.9"},
            )
            await ctx.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
            )

            async def _one(team: str) -> None:
                async with sem:
                    try:
                        result = await _fetch_one_in_ctx(ctx, team)
                        if result:
                            out[team] = result
                    except Exception as exc:
                        _warn(f"batch fetch failed for {team!r}: {exc}")

            try:
                await asyncio.gather(*(_one(t) for t in teams))
            finally:
                await browser.close()
    except Exception as exc:
        _warn(f"batch launch failed (no display? VPS without Xvfb?): {exc}")
        return {}

    return out


async def fetch_sofascore_xg_table(teams: list[str], max_workers: Optional[int] = None) -> dict[str, dict]:
    """goals-market-analysis-prompt-v3 gap-closure: per-team xG via Sofascore,
    merged below FotMob in build_xg_table.py's priority order (Understat >
    FotMob > Sofascore > FBref). Reuses fetch_sofascore_batch's captured
    player-statistics/standings/events payloads and applies xg_extract's
    best-effort key-walk (see xg_extract.py's docstring — no live Sofascore
    session was available to verify the exact team-xG JSON path). A team with
    no xG-shaped key anywhere in its captured payload is simply absent from
    the result, never fatal."""
    if not HAS_PLAYWRIGHT or not teams:
        return {}
    raw = await fetch_sofascore_batch(teams, max_workers=max_workers)
    table: dict[str, dict] = {}
    for team, payload in raw.items():
        xg = best_team_xg(payload.get("stats", {}))
        if not xg:
            continue
        key = normalise(team)
        if not key:
            continue
        table[key] = {"xgf": xg["xgf"], "xga": xg["xga"], "n": None, "div": "", "src": "sofascore"}
    return table


def main() -> int:
    ap = argparse.ArgumentParser(description="Sofascore per-team stats fetch (Playwright, non-headless).")
    ap.add_argument("--team", help="Single team name, e.g. 'Arsenal' (stats fetch mode)")
    ap.add_argument("--out", help="Write JSON here instead of stdout")
    ap.add_argument(
        "--xg-teams", help="Comma-separated team names — xG-extraction mode instead of the stats fetch"
    )
    ap.add_argument("--xg-out", default=str(XG_OUTPUT_PATH), help="Output path for --xg-teams mode")
    args = ap.parse_args()

    if args.xg_teams:
        teams = [t.strip() for t in args.xg_teams.split(",") if t.strip()]
        table = asyncio.run(fetch_sofascore_xg_table(teams))
        out_path = Path(args.xg_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(table, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"[fetch-sofascore-xg] {len(table)}/{len(teams)} teams matched -> {out_path}")
        return 0

    if not args.team:
        ap.error("either --team or --xg-teams is required")

    result = asyncio.run(fetch_sofascore_team(args.team))
    if result is None:
        print("[fetch-sofascore] no data captured", file=sys.stderr)
        return 3

    payload = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(payload, encoding="utf-8")
        print(f"[fetch-sofascore] wrote {out_path}")
    else:
        # Windows console codepage can't encode every character Sofascore's
        # JSON may contain — same fix as fetch_fotmob.py.
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.write(b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
