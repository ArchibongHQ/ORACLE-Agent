/** TeamRatingsEngine — ported from ORACLE_v2026_8_0.jsx §4, lines 1323-1371.
 *  Rewrite #1: _safeStorage → StoragePort. Rewrite #2: hydrate-once/persist-at-end pattern. */
import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS } from "@oracle/storage";

export interface TeamRating {
  elo: number;
  pi: { home: number; away: number };
}
type EloStore = Record<string, number>;
/** `n` = matches this team's pi-rating has been updated from (Wave 2 WS2-B —
 *  the shrinkage-weight sample count for `ratingsBlendWeight` in
 *  goalsV3/lambda.ts). Optional: pre-Wave-2 persisted stores have no `n` at
 *  all, so every reader must treat a missing `n` as 0, not throw/crash. */
type PiStore = Record<string, { home: number; away: number; n?: number }>;

export class TeamRatingsEngine {
  private _eloCache: EloStore | null = null;
  private _piCache: PiStore | null = null;

  constructor(private _storage: StoragePort) {}

  async hydrate(): Promise<void> {
    this._eloCache = (await this._storage.get<EloStore>(STORAGE_KEYS.teamsElo)) ?? {};
    this._piCache = (await this._storage.get<PiStore>(STORAGE_KEYS.teamsPi)) ?? {};
  }

  async persist(): Promise<void> {
    if (this._eloCache) await this._storage.set(STORAGE_KEYS.teamsElo, this._eloCache);
    if (this._piCache) await this._storage.set(STORAGE_KEYS.teamsPi, this._piCache);
  }

  private get elo(): EloStore {
    return this._eloCache ?? {};
  }
  private get pi(): PiStore {
    return this._piCache ?? {};
  }

  // ── Elo ──────────────────────────────────────────────────────────────────────
  getRating(teamName: string, defaultVal = 1500): number {
    if (!teamName) return defaultVal;
    return this.elo[teamName.toLowerCase().trim()] ?? defaultVal;
  }

  update(hTeam: string, aTeam: string, hG: number, aG: number, exH: number, exA: number) {
    if (!hTeam || !aTeam) return;
    const d = this.elo;
    const upd = 20 * Math.tanh((hG - aG - (exH - exA)) / 2);
    d[hTeam.toLowerCase()] = Math.max(1000, Math.min(2000, (d[hTeam.toLowerCase()] ?? 1500) + upd));
    d[aTeam.toLowerCase()] = Math.max(1000, Math.min(2000, (d[aTeam.toLowerCase()] ?? 1500) - upd));
    return {
      homeRating: d[hTeam.toLowerCase()],
      awayRating: d[aTeam.toLowerCase()],
      updateAmount: upd,
    };
  }

  getAllElo(): EloStore {
    return { ...this.elo };
  }

  // ── Pi-ratings (Constantinou & Fenton 2013) ─────────────────────────────────
  getPiRating(teamName: string, venue: "home" | "away" = "home", defaultVal = 0): number {
    if (!teamName) return defaultVal;
    const t = this.pi[teamName.toLowerCase().trim()];
    return t ? (venue === "home" ? t.home : t.away) : defaultVal;
  }

  /** Matches this team's pi-rating has actually been updated from (Wave 2
   *  WS2-B shrinkage sample count). Missing/pre-Wave-2 entries default to 0 —
   *  never crashes on old persisted data that predates this field. */
  getPiN(teamName: string): number {
    if (!teamName) return 0;
    const t = this.pi[teamName.toLowerCase().trim()];
    return t?.n ?? 0;
  }

  /** λ=0.035, γ=0.7 — Constantinou & Fenton 2013 defaults. */
  updatePi(hTeam: string, aTeam: string, hG: number, aG: number, lambda = 0.035, gamma = 0.7) {
    if (!hTeam || !aTeam) return;
    const d = this.pi;
    const hk = hTeam.toLowerCase().trim(),
      ak = aTeam.toLowerCase().trim();
    d[hk] = d[hk] ?? { home: 0, away: 0, n: 0 };
    d[ak] = d[ak] ?? { home: 0, away: 0, n: 0 };
    const expDiff = Math.tanh((d[hk]?.home - d[ak]?.away) / 3);
    const obsDiff = Math.tanh((hG - aG) / 3);
    const err = obsDiff - expDiff;
    d[hk]!.home += lambda * err;
    d[hk]!.away += lambda * gamma * err;
    d[ak]!.away -= lambda * err;
    d[ak]!.home -= lambda * gamma * err;
    // Wave 2 WS2-B: sample-count tracking for the ratings→lambda shrinkage
    // weight. `?? 0` covers pre-Wave-2 persisted entries that predate `n`.
    d[hk]!.n = (d[hk]!.n ?? 0) + 1;
    d[ak]!.n = (d[ak]!.n ?? 0) + 1;
    return { homePi: d[hk], awayPi: d[ak] };
  }
}

/** Wave 2 WS2-B — derives a lambda-relevant expected-goal-difference-ish
 *  signal from a pair of pi-ratings. Deliberately reuses `updatePi`'s own
 *  internal `/3` tanh normalization (`expDiff = tanh((home.home -
 *  away.away)/3)`, fit every match against the observed `tanh((hG-aG)/3)`
 *  goal difference) rather than inventing a new scale — this IS the model's
 *  own notion of "expected goal-difference" for a head-to-head, just applied
 *  outside the class to two already-resolved ratings instead of during a fit
 *  step. Positive = home side expected stronger. Pure function, no I/O. */
export function ratingsXgd(homePi: number, awayPi: number): number {
  return Math.tanh((homePi - awayPi) / 3);
}

/** Wave 2 WS2-B — integration glue for a future caller (Wave 3's batch
 *  instantiation, NOT built here) to turn a `TeamRatingsEngine` + fixture
 *  into the `{ ratingsXgd, ratingsN }` shape `V3LambdaInput`
 *  (goalsV3/lambda.ts) expects.
 *
 *  Wiring contract for the Wave-3 caller:
 *   1. Gate the whole call behind `ORACLE_V3_RATINGS`. That flag defaults to
 *      `"shadow"` — meaning this function's output should currently be
 *      attached to the lambda input and logged/diagnosed ONLY. Do NOT also
 *      pass `opts.ratingsBlend: true` to `computeV3Lambdas` yet.
 *   2. `opts.ratingsBlend: true` may only be flipped on in production AFTER
 *      the walk-forward harness (ratings/walkForward.ts,
 *      `runRatingsWalkForward`) clears `significanceAcceptGate` against real
 *      historical data — see that module's header for the exact bar (RPS
 *      improvement, minN=300, effectSizeFloor=0.002). Until then this stays
 *      a shadow diagnostic with zero effect on any live λ.
 *   3. `ratingsEngine.hydrate()` must have resolved before this is called —
 *      it reads the in-memory pi cache synchronously, it does not hydrate
 *      itself. */
export function buildRatingsLambdaInput(
  ratingsEngine: TeamRatingsEngine,
  homeTeam: string,
  awayTeam: string
): { ratingsXgd: number; ratingsN: number } {
  const homePi = ratingsEngine.getPiRating(homeTeam, "home");
  const awayPi = ratingsEngine.getPiRating(awayTeam, "away");
  const nHome = ratingsEngine.getPiN(homeTeam);
  const nAway = ratingsEngine.getPiN(awayTeam);
  return {
    ratingsXgd: ratingsXgd(homePi, awayPi),
    ratingsN: Math.min(nHome, nAway),
  };
}
