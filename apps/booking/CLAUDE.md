# @oracle/booking

Anonymous SportyBet accumulator "booking" agent — generates a shareable booking code by calling SportyBet's internal REST API directly (no login, no stake, no real money).

- **Entry points:** `src/index.ts` (main API logic: `mapMarket`, booking flow), `src/loadCode.ts` (loads/parses an existing booking code, uses Playwright), `src/marketMap.ts`, `src/page.ts`.
- **Exports:** `loadBookingCode`, `LoadedSlip`, `RawLeg` types (re-exported from `index.ts`); consumed by `apps/worker` and `apps/bot`.

**Gotcha:** API-first — direct REST calls to `sportybet.com/api/ng`; Playwright is only used by `loadCode.ts`, not for booking itself. The directory root also has scratch `probe_*.mjs` scripts (ad hoc scraping investigations) that aren't part of the build.
