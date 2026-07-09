/** PR-21: loads the runtime catalog overlay — markets observed since
 *  catalog.generated.ts was last regenerated (tools/build_market_catalog.py's
 *  weekly --diff-only --json-out run) — and feeds it to @oracle/engine's
 *  extendCatalog(). Extracted as its own small module (mirrors
 *  xgCoverageNote.ts's convention) with the file path as an explicit
 *  parameter, not a ROOT-derived constant, so it's testable with tmp paths.
 *  Never throws — a missing/corrupt overlay file (no weekly run yet, or the
 *  flag was just turned on) is a valid, common outcome, not an error. */
import { readFileSync } from "node:fs";
import { extendCatalog, type MarketCatalogEntry } from "@oracle/engine";

export function loadCatalogOverlay(path: string): number {
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
  if (!Array.isArray(entries)) return 0;
  return extendCatalog(entries as MarketCatalogEntry[]);
}
