---
name: sportybet-stats-probe
description: Discover/verify new SportyBet-Sportradar gismo stats endpoints via non-headless Playwright capture, then wire them through the existing no-auth gismo host
triggers: /sportybet-stats-probe, /sir-token-harvest
---

# SportyBet/Sportradar Stats Endpoint Discovery

**Goal**: Find new data points (stats, markets, anything) exposed by SportyBet's
mobile site beyond what `tools/scrape_fixtures.py` already scrapes, and get them
into production with the least new infrastructure.

**Context (discovered 2026-06-23)**: SportyBet's mobile Stats tab renders via a
third-party Sportradar "SIR" (Sport Info Reseller) widget
(`widgets.sir.sportradar.com/638846b93b23ecfc94ce1a6d45b1dbe6/widgetloader`). That
widget calls a token-gated gismo host
(`widgets.fn.sportradar.com/common/en/Etc:UTC/gismo/{query}?T=...`). Probing it
with Playwright is how you find out *what queries exist* — but the **same
gismo query namespace is also served, identically, with zero auth**, by the
host `tools/scrape_fixtures.py` already calls:
`stats.fn.sportradar.com/sportybet/en/Etc:UTC/gismo/{query}` (just a
`User-Agent` header — see `_SB_HDR`/`_SB_GISMO`/`_sb_get()`/`_gismo_doc()` in
`tools/scrape_fixtures.py`). Verified side-by-side for
`stats_season_uniqueteamstats` and `stats_team_lastxextended`: identical field
shapes and values from both hosts.

**Implication — mandatory ordering for any endpoint this skill finds**:
1. Try the endpoint on the no-auth `stats.fn.sportradar.com/sportybet/...` host
   first via plain `urllib.request` (reuse `_gismo_doc()`).
2. Only fall back to the SIR-token-harvest mechanism (Step 3-5 below) if a
   query genuinely 404s/exceptions on the no-auth host — this has not
   happened yet for any query checked to date.
Never wire the token-harvest path into production as the *first* attempt —
it requires a non-headless browser process per harvest, which is strictly
more infrastructure than a host that already works.

## Workflow

1. **Find a fresh pre-match fixture.** Query SportyBet's `pcUpcomingEvents` API
   for an event kicking off hours from now (stale/live fixtures redirect away
   from the pre-match Stats tab and produce empty captures).

2. **Capture with non-headless Chromium — this is the critical flag.**
   `headless=True` (even with `--disable-web-security` and friends) gets
   `ERR_BLOCKED_BY_ORB`/`ERR_ABORTED` on the SIR widget's cross-origin
   requests. `headless=False` with only baseline flags (`--no-sandbox`,
   `--disable-blink-features=AutomationControlled`) eliminates the block
   entirely — this is a legacy-headless-Chromium networking-stack issue, not
   a flag or CORS problem. Click through every Stats sub-tab
   (H2H/Comparison/Probability/Standings/Lineups) to trigger all underlying
   XHR/fetch calls; capture every JSON response whose host matches
   `sportybet.com` or `sportradar.com`.

3. **Inspect captured URLs for new `gismo/{query}/...` paths** not already
   called in `tools/scrape_fixtures.py`. Decode the signed token structure if
   present: `T=exp={unix_ts}~acl=/*~data={base64 JSON}~hmac={hex}` — the
   `data` segment is an origin/account-scoped credential
   (`{"o": "https://mobile.sportybet.com", "a": "<widget_id>", "act":
   "origincheck", "osrc": "origin"}`), valid ~25h for ANY gismo query once
   harvested, reusable outside the browser via plain HTTP with
   `Referer`/`Origin` headers set to `mobile.sportybet.com`. (This token
   mechanic is useful to know exists, but per the ordering rule above, only
   actually use it if step 4 fails.)

4. **Test the same query on the no-auth host**:
   `https://stats.fn.sportradar.com/sportybet/en/Etc:UTC/gismo/{query}` with
   just `_SB_HDR`. Diff the response against the token-gated capture. If
   identical (the expected outcome so far), this is the production path —
   skip the token entirely.

5. **Verify field semantics before parsing** — IDs are NOT interchangeable
   across endpoints. `match_info` exposes both a team `_id` (doctype id) and
   `uid` (uniqueteam id) per side; some endpoints key by one, some by the
   other (e.g. `stats_season_overunder` is `uid`-keyed,
   `stats_season_uniqueteamstats` is `_id`-keyed — confirmed by testing both
   against a live match, never assumed). Always confirm against a real
   response before writing the parser.

6. **Wire into `_fetch_fixture_detail()`** following the established pattern:
   a `_gismo_doc(f"{query}/{id}")` call → a new `_parse_X()` function
   (mirrors the style of `_parse_overunder`/`_parse_rest_congestion`, with a
   docstring stating the live-verified key/shape gotchas) → merged into the
   `stats` dict under a new key only if non-empty. Add the matching field to
   `SportyBetStats` in `packages/runtime/src/selectFixtures.ts`. Update
   `workflows/scrape_fixtures.md`'s endpoint table.

## Confirmed findings (2026-06-23, do not re-probe — reuse directly)

- No real `xG`/expected-goals field exists anywhere in SportyBet/Sportradar's
  gismo API. `shots_on_goal`/`shots_off_goal` (→ `shots_on_target_avg`/
  `shots_off_target_avg`) from `stats_season_uniqueteamstats` is the closest
  available proxy — label it as a shot-volume proxy, never as real xG.
- `gismo/stats_season_uniqueteamstats/{seasonId}` — one call covers every
  team in the competition: `shots_on_goal`, `shots_off_goal`, `corner_kicks`,
  `shots_blocked`, `ball_possession`, `goals_scored`, `goals_conceded`, plus
  cards/freekicks/offside/woodwork — each `{average, total, matches}`. Keyed
  by team `_id`.
- `gismo/stats_team_lastxextended/{teamId}` — per-match recent list with a
  per-match `corners: {home, away}` field (no shots/possession at this
  granularity, only the season aggregate has those).
- Both endpoints already wired into `tools/scrape_fixtures.py` as calls
  10–11 of `_fetch_fixture_detail()` (`_parse_possession_value()` /
  `_parse_recent_form_corners()`), using the no-auth host — no token harvest
  needed in production.

## Confirmed findings (2026-07-20, do not re-probe — reuse directly)

- `gismo/stats_team_squad/{uid}` — **`uid`-keyed, NOT `_id`-keyed** (confirmed
  live against a real MLS Next Pro fixture: passing the team doctype `_id`
  returns an empty `players[]` list, not an error — the same silent-mismatch
  trap as `stats_season_overunder`). Returns a full roster (`_id`/name/
  `birthdate.uts`/`height`/`weight`/position/shirtnumber per player, ~46KB for
  a 13-26 player squad). Now wired as call #16 of `_fetch_fixture_detail()`
  (`_parse_squad_averages()`) → `SportyBetStats.squadAverages`.
- **`height`/`weight` use `0` as a null sentinel**, not real measurements —
  confirmed on a real lower-tier roster (4/13 and 4/19 players had
  `height=0`). Any consumer must filter zero-valued height/weight before
  averaging; `birthdate` had no equivalent gap on the same rosters (100%
  populated), so age has no parallel filter.
- **`stats_team_versusrecent`'s (H2H) per-match objects carry NO
  corners/cards fields at all** — confirmed live against a real fixture with
  24 H2H entries; exact key list is `{_doc, _doctype, _id, _rcid, _seasonid,
  _sid, _tid, _utid, bestof, canceled, comment, disqualified, inlivescore,
  neutralground, numberofperiods, periods, postponed, result, retired,
  round, roundname, stadiumid, status, teams, time, tobeannounced, walkover,
  week}`. This is a materially different shape from
  `stats_team_lastxextended`'s match objects, which DO carry a per-match
  `corners` field — do not assume H2H inherits the same per-match richness
  as recent-form; verify each endpoint's match-object shape independently.
- **Venue/stadium name/capacity: RESOLVED 2026-07-21 — there is NO separate
  gismo venue query; the data is embedded in `match_info` itself.** The 8
  prior guesses (`venue/{id}`, `stadium/{id}`, `stats_venue/{id}`,
  `venueinfo/{id}`, `stats_stadium/{id}`, `stadiuminfo/{id}`,
  `stats_venue_info/{id}`, `stats_venue_details/{id}`) all failed because
  they assumed a standalone endpoint that does not exist. `match_info/{mid}`'s
  `doc[0].data` carries a **top-level `stadium` object** whose `_id` IS the
  `match.stadiumid` value (verified equal live: `2322`==`2322` for Kalmar FF's
  "Guldfageln Arena", `72069`==`72069` for Rapid Bucuresti's "Stadionul
  Rapid-Giulesti"). So `stadiumid` was always just a pointer into an object
  already present in the same response. Shape (live-verified against real
  **CLUB** fixtures — Allsvenskan/Superliga, the club test the 2026-07-20
  national-team check lacked): `stadium = {_id, name, description, city,
  country, cc:{...}, capacity, hometeams:[...], googlecoords, pitchsize,
  constryear}`. Gotchas: **`capacity` is a STRING** (`"12500"`), not an int;
  the whole `stadium` object is **absent (None)** for neutral-ground /
  venue-unknown fixtures (a club friendly returned `stadium=None`);
  `match.coverage.venue` was `false` on all sampled league games yet the
  `stadium` object was still fully populated — do NOT gate on
  `coverage.venue`. `stats_team_info/{uid}` (uid-keyed; `_id` returns
  `exception`) ALSO carries the same `stadium` object — the 2026-07-20 note
  that it "doesn't carry a venue field" was a false negative from testing a
  national team (no home ground). Now wired as `_parse_venue(mi_data)` in
  `tools/scrape_fixtures.py` (reuses the already-fetched `match_info` response,
  no new gismo call) → `SportyBetStats.venue` → rendered report-only in BOTH
  `dailyFixtureReport.ts` (Venue line) and `fixtureWorkbook.ts` (Venue/
  VenueCity/VenueCountry/VenueCapacity columns). No engine coefficient: venue
  capacity has no established predictive value beyond home-field advantage
  (Pollard HFA literature attributes the effect to crowd/travel/familiarity,
  not raw seat count), so it stays descriptive context, not a pricing signal.
- `packages/runtime/src/selectFixtures.ts`'s `computeH2hAggregate()` derives
  BTTS%/Over1.5%/Over2.5% from `stats_team_versusrecent`'s existing
  `matches[]` scorelines — a pure TS-side computation, not a new gismo call.
  This generalizes a report-only `h2hOversRate` function that used to exist
  in `reportPatterns.ts`; that function's disconnection from the live picker
  was traced to a stale/incorrect blocking comment (claimed it needed "the
  separate rate-limited h2h.ts external-API module," which it never actually
  touched) — now reconnected. See `packages/engine/src/marketsV3/
  analyzeFixtureMarkets.ts`'s `V3AllMarketsInput.h2hOversRate` doc comment.
