# @oracle/research

Small web-research utility — currently just scraping Google's "AI Mode" search results via Playwright.

- **Entry points:** `src/index.ts`, `src/googleAiMode.ts`.
- **Key exports:** `scrapeGoogleAiMode`, `GoogleAiModeResult` type. Consumed by `@oracle/llm` (for news intelligence).

**Gotcha:** Uses Playwright directly (real browser automation against Google), so it's more fragile/rate-limit-sensitive than typical API calls.
