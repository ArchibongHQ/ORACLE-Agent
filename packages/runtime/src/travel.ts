/** Travel-friction + altitude telemetry from the static venue table.
 *
 *  The engine already consumes RunState.telemetry.travelKm / altitudeM
 *  (packages/engine/src/execution/index.ts → applyTravelFriction) but the
 *  runtime never populated them from a deterministic source — only an optional
 *  LLM extraction. This module loads the team→venue table built by
 *  tools/fetch_travel.py (.tmp/travel/venues.json) and computes the away team's
 *  great-circle travel distance to the home venue, plus the home venue altitude.
 *
 *  Output is BOTH engine telemetry (travelKm/altitudeM — read directly by the
 *  engine) AND an advisory SoftContextItem so the Claude arbiter sees the same
 *  signal in its prompt (the scalars alone are not printed). Pure except for the
 *  one cached JSON read. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SoftContextItem } from "@oracle/engine";

interface Venue {
  lat: number;
  lon: number;
  altitude: number;
}

const __dir = dirname(fileURLToPath(import.meta.url));
const VENUES_PATH = join(__dir, "../../..", ".tmp", "travel", "venues.json");

let _cache: Record<string, Venue> | null = null;
let _loaded = false;

/** Same normalisation contract as tools/lib/team_names.normalise_team:
 *  lowercase → strip non-alphanumerics (keep spaces) → collapse whitespace.
 *  The Python table is keyed with that canonical form, so we must match it. */
function normaliseKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadVenues(): Record<string, Venue> {
  if (_loaded) return _cache ?? {};
  _loaded = true;
  try {
    const data = JSON.parse(readFileSync(VENUES_PATH, "utf8")) as unknown;
    _cache = data && typeof data === "object" ? (data as Record<string, Venue>) : {};
  } catch {
    _cache = {}; // missing/corrupt → no travel features (fail-open)
  }
  return _cache;
}

/** Test seam — reset the module cache so a fixture can inject a fresh table. */
export function _resetVenueCache(): void {
  _cache = null;
  _loaded = false;
}

function haversineKm(a: Venue, b: Venue): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface TravelResult {
  /** Engine telemetry scalars — merged into RunState.telemetry. */
  telemetry: { travelKm?: number; altitudeM?: number };
  /** Advisory item so the arbiter prompt sees the same signal. */
  soft?: SoftContextItem;
}

/** Derive travel + altitude for one fixture.
 *  - neutralVenue (e.g. World Cup): travel is undefined (no home base), but the
 *    home-listed team's venue altitude is still used as the match-site altitude.
 *  - Either team missing from the venue table → that feature is simply omitted.
 *  Returns empty telemetry when nothing could be derived (caller spreads it). */
export function buildTravel(
  home: string,
  away: string,
  opts: { neutralVenue?: boolean; observedAt?: string } = {}
): TravelResult {
  const venues = loadVenues();
  const hv = venues[normaliseKey(home)];
  const av = venues[normaliseKey(away)];
  if (!hv) return { telemetry: {} };

  const telemetry: { travelKm?: number; altitudeM?: number } = {};
  // typeof check, not a falsy check — a sea-level venue (altitude === 0) is
  // real data and must not be treated the same as a missing/malformed entry
  // from the cached venues.json.
  if (typeof hv.altitude === "number") telemetry.altitudeM = Math.round(hv.altitude);

  if (!opts.neutralVenue && av) {
    telemetry.travelKm = Math.round(haversineKm(hv, av));
  }

  if (telemetry.travelKm === undefined && telemetry.altitudeM === undefined)
    return { telemetry: {} };

  const parts: string[] = [];
  if (telemetry.travelKm !== undefined) parts.push(`away travel ≈ ${telemetry.travelKm} km`);
  if (telemetry.altitudeM !== undefined) parts.push(`venue altitude ≈ ${telemetry.altitudeM} m`);
  const soft: SoftContextItem = {
    kind: "news",
    text: `Travel/venue — ${parts.join(", ")}${opts.neutralVenue ? " (neutral venue)" : ""}.`,
    source: "travel-table",
    observedAt: opts.observedAt ?? new Date().toISOString(),
  };

  return { telemetry, soft };
}
