"""scrape_google_ai.py — universal data-acquisition fallback for ORACLE.

Standing rule (CLAUDE.md §6, [[oracle-no-data-blocker-playwright]]): a missing
API key MUST NEVER block ORACLE. Any data point (odds, stats, xG, lineups,
results, even Kaggle listings) can be acquired by querying Google.com's "AI Mode"
or scraping an arbitrary JS-rendered URL via Playwright. This tool is that
universal last-resort tier.

Reuses the exact Playwright conventions from tools/scrape_fixtures.py:
headless chromium, --disable-gpu on local Windows (prevents driver-crash reboots),
masked automation flag, JSON-LD / __NEXT_DATA__ extraction.

Usage:
    # Google AI Mode answer for an arbitrary question (returns AI-mode prose + sources)
    python tools/scrape_google_ai.py --query "Manchester City vs Arsenal xG last 5 games"

    # Scrape a specific JS-rendered URL, dump structured JSON (text + embedded JSON blobs)
    python tools/scrape_google_ai.py --url "https://www.kaggle.com/search?q=Football+prediction+in%3Anotebooks"

    # Write result to a file instead of stdout
    python tools/scrape_google_ai.py --query "..." --out .tmp/scrape/result.json

    # Tune wait for slow client-rendered pages
    python tools/scrape_google_ai.py --url "..." --wait-ms 6000

Exit codes: 0 ok, 2 playwright missing, 3 scrape failed (no terminal BLOCK — caller
should treat empty result as "try a different query/url", never as fatal).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

try:
    from playwright.async_api import async_playwright, BrowserContext, Page
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

# ── Config (mirror scrape_fixtures.py conventions) ─────────────────────────────

ROOT = Path(__file__).resolve().parent.parent

_CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# Google AI Mode is the udm=50 surface (AI-generated answer + cited sources).
_GOOGLE_AI_MODE = "https://www.google.com/search?udm=50&q={q}"


def _warn(msg: str) -> None:
    print(f"[scrape-ai] WARN: {msg}", file=sys.stderr)


def _launch_args() -> list[str]:
    """Same GPU-safety logic as scrape_fixtures.py: disable GPU on local Windows
    to prevent driver crashes that hard-reboot the box; keep it on VPS/non-Windows."""
    is_local_windows = (
        sys.platform == "win32"
        and os.environ.get("ORACLE_IS_VPS", "").lower() != "true"
    )
    args = ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
    if is_local_windows:
        args += ["--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer"]
    return args


# ── Extraction ─────────────────────────────────────────────────────────────────

# Pull embedded JSON blobs (__NEXT_DATA__, JSON-LD) — the same recursive-walk
# trick scrape_fixtures.py uses for OneFootball/365Scores client-rendered data.
_EXTRACT_JS = """
() => {
    const out = { nextData: null, jsonLd: [], title: document.title || '' };
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd && nd.textContent) {
        try { out.nextData = JSON.parse(nd.textContent); } catch (e) {}
    }
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { out.jsonLd.push(JSON.parse(s.textContent)); } catch (e) {}
    }
    return out;
}
"""


async def _scrape_url(ctx: BrowserContext, url: str, wait_ms: int) -> dict[str, Any]:
    page: Page = await ctx.new_page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        # Let client-side rendering settle (Google AI Mode + SPAs stream content in).
        await page.wait_for_timeout(wait_ms)
        try:
            await page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass  # networkidle is best-effort; many SPAs never reach it

        text = await page.evaluate("() => document.body ? document.body.innerText : ''")
        embedded = await page.evaluate(_EXTRACT_JS)
        # Visible links — useful for listing pages (Kaggle search, SERPs).
        links = await page.evaluate(
            """() => Array.from(document.querySelectorAll('a[href]'))
                .map(a => ({ text: (a.innerText || '').trim(), href: a.href }))
                .filter(l => l.text && l.href.startsWith('http'))
                .slice(0, 200)"""
        )
        return {
            "url": url,
            "title": embedded.get("title", ""),
            "text": text,
            "links": links,
            "nextData": embedded.get("nextData"),
            "jsonLd": embedded.get("jsonLd", []),
        }
    finally:
        await page.close()


async def _run(target_url: str, wait_ms: int) -> Optional[dict[str, Any]]:
    if not HAS_PLAYWRIGHT:
        _warn("Playwright not installed — run: pip install playwright && python -m playwright install chromium")
        return None

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=_launch_args())
        ctx = await browser.new_context(
            user_agent=_CHROME_UA,
            viewport={"width": 1280, "height": 900},
            locale="en-GB",
            extra_http_headers={"Accept-Language": "en-GB,en;q=0.9"},
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )
        try:
            result = await _scrape_url(ctx, target_url, wait_ms)
        except Exception as exc:
            _warn(f"scrape failed for {target_url}: {exc}")
            result = None
        finally:
            await browser.close()
        return result


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Universal Google-AI-Mode / URL scraper (ORACLE data fallback).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--query", help="Question to ask Google AI Mode")
    g.add_argument("--url", help="Arbitrary JS-rendered URL to scrape")
    ap.add_argument("--wait-ms", type=int, default=4000, help="Extra render wait (default 4000)")
    ap.add_argument("--out", help="Write JSON here instead of stdout")
    args = ap.parse_args()

    if args.query:
        target = _GOOGLE_AI_MODE.format(q=urllib.parse.quote_plus(args.query))
        mode = "google_ai_mode"
    else:
        target = args.url
        mode = "url"

    result = asyncio.run(_run(target, args.wait_ms))

    payload = {
        "mode": mode,
        "query": args.query,
        "scraped_at": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ok": result is not None and bool(result.get("text")),
        "result": result,
    }
    out_json = json.dumps(payload, ensure_ascii=False, indent=1)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = out_path.with_suffix(out_path.suffix + ".tmp")
        tmp.write_text(out_json, encoding="utf-8")
        os.replace(tmp, out_path)
        print(f"[scrape-ai] wrote {out_path} (ok={payload['ok']})", flush=True)
    else:
        print(out_json)

    return 0 if payload["ok"] else 3


if __name__ == "__main__":
    sys.exit(main())
