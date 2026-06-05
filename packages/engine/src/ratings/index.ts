/** TeamRatingsEngine — ported from ORACLE_v2026_8_0.jsx §4, lines 1323-1371.
 *  Rewrite #1: _safeStorage → StoragePort. Rewrite #2: hydrate-once/persist-at-end pattern. */
import type { StoragePort } from '@oracle/storage';
import { STORAGE_KEYS } from '@oracle/storage';

export interface TeamRating { elo: number; pi: { home: number; away: number }; }
type EloStore  = Record<string, number>;
type PiStore   = Record<string, { home: number; away: number }>;

export class TeamRatingsEngine {
  private _eloCache: EloStore | null = null;
  private _piCache: PiStore  | null = null;

  constructor(private _storage: StoragePort) {}

  async hydrate(): Promise<void> {
    this._eloCache = (await this._storage.get<EloStore>(STORAGE_KEYS.teamsElo)) ?? {};
    this._piCache  = (await this._storage.get<PiStore>(STORAGE_KEYS.teamsPi))  ?? {};
  }

  async persist(): Promise<void> {
    if (this._eloCache) await this._storage.set(STORAGE_KEYS.teamsElo, this._eloCache);
    if (this._piCache)  await this._storage.set(STORAGE_KEYS.teamsPi,  this._piCache);
  }

  private get elo(): EloStore { return this._eloCache ?? {}; }
  private get pi():  PiStore  { return this._piCache  ?? {}; }

  // ── Elo ──────────────────────────────────────────────────────────────────────
  getRating(teamName: string, defaultVal = 1500): number {
    if (!teamName) return defaultVal;
    return this.elo[teamName.toLowerCase().trim()] ?? defaultVal;
  }

  update(hTeam: string, aTeam: string, hG: number, aG: number, exH: number, exA: number) {
    if (!hTeam || !aTeam) return;
    const d = this.elo;
    const upd = 20 * Math.tanh(((hG - aG) - (exH - exA)) / 2);
    d[hTeam.toLowerCase()] = Math.max(1000, Math.min(2000, (d[hTeam.toLowerCase()] ?? 1500) + upd));
    d[aTeam.toLowerCase()] = Math.max(1000, Math.min(2000, (d[aTeam.toLowerCase()] ?? 1500) - upd));
    return { homeRating: d[hTeam.toLowerCase()], awayRating: d[aTeam.toLowerCase()], updateAmount: upd };
  }

  getAllElo(): EloStore { return { ...this.elo }; }

  // ── Pi-ratings (Constantinou & Fenton 2013) ─────────────────────────────────
  getPiRating(teamName: string, venue: 'home' | 'away' = 'home', defaultVal = 0): number {
    if (!teamName) return defaultVal;
    const t = this.pi[teamName.toLowerCase().trim()];
    return t ? (venue === 'home' ? t.home : t.away) : defaultVal;
  }

  /** λ=0.035, γ=0.7 — Constantinou & Fenton 2013 defaults. */
  updatePi(hTeam: string, aTeam: string, hG: number, aG: number, lambda = 0.035, gamma = 0.7) {
    if (!hTeam || !aTeam) return;
    const d = this.pi;
    const hk = hTeam.toLowerCase().trim(), ak = aTeam.toLowerCase().trim();
    d[hk] = d[hk] ?? { home: 0, away: 0 };
    d[ak] = d[ak] ?? { home: 0, away: 0 };
    const expDiff = Math.tanh(((d[hk]!.home) - (d[ak]!.away)) / 3);
    const obsDiff = Math.tanh((hG - aG) / 3);
    const err = obsDiff - expDiff;
    d[hk]!.home  += lambda * err;
    d[hk]!.away  += lambda * gamma * err;
    d[ak]!.away  -= lambda * err;
    d[ak]!.home  -= lambda * gamma * err;
    return { homePi: d[hk], awayPi: d[ak] };
  }
}
