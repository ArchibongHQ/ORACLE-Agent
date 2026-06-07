/** Swarm tests — Level-2 sub-agent orchestration.
 *  Guarantees: swarm is disabled without a key/flag; aggregation is confidence-weighted;
 *  high divergence is flagged; swarm output is advisory softContext only (augment, not replace). */
import { describe, it, expect, vi } from 'vitest';
import { runSwarm, swarmWorkersForTier, swarmToSoftContext } from '../src/swarm/index.js';
import type { SwarmResult } from '../src/swarm/index.js';
import type { EVMarket, OracleConfig } from '../src/types.js';

const baseConfig: OracleConfig = { geminiApiKey: '', claudeApiKey: '', bankroll: 1000 };
const fixture = { home: 'Arsenal', away: 'Chelsea', league: 'Premier League', kickoff: '2026-06-05T15:00:00Z' };

const mkMarket = (label: string, ev = 0.06): EVMarket => ({
  cat: 'Goals O/U', label, market: 'Goals O/U', side: label,
  mp: 0.55, modelProb: 0.55, ip: 0.48, rawEdge: 0.07, ev,
  odds: 2.1, stake: 0.03, stakeAmt: 30, rankingScore: 0.6, varianceMod: 1.0,
});

describe('swarmWorkersForTier', () => {
  it('scales workers by tier; none for MARGINAL/NOISE', () => {
    expect(swarmWorkersForTier('APEX')).toBe(7);
    expect(swarmWorkersForTier('PRIME')).toBe(5);
    expect(swarmWorkersForTier('VIABLE')).toBe(3);
    expect(swarmWorkersForTier('MARGINAL')).toBe(0);
    expect(swarmWorkersForTier('NOISE')).toBe(0);
    expect(swarmWorkersForTier('UNKNOWN')).toBe(0);
  });
});

describe('runSwarm — guards', () => {
  it('returns null when swarm disabled', async () => {
    const r = await runSwarm(5, fixture, [mkMarket('Over 2.5')], { ...baseConfig, enableSwarm: false, kimiApiKey: 'k' });
    expect(r).toBeNull();
  });

  it('returns null when no Kimi key', async () => {
    const r = await runSwarm(5, fixture, [mkMarket('Over 2.5')], { ...baseConfig, enableSwarm: true });
    expect(r).toBeNull();
  });

  it('returns null when no eligible bets', async () => {
    const r = await runSwarm(5, fixture, [], { ...baseConfig, enableSwarm: true, kimiApiKey: 'k' });
    expect(r).toBeNull();
  });

  it('returns null when zero workers requested', async () => {
    const r = await runSwarm(0, fixture, [mkMarket('Over 2.5')], { ...baseConfig, enableSwarm: true, kimiApiKey: 'k' });
    expect(r).toBeNull();
  });
});

describe('runSwarm — aggregation', () => {
  it('confidence-weighted consensus + low divergence when workers agree', async () => {
    vi.doMock('@oracle/llm', () => ({
      callKimiVote: vi.fn().mockResolvedValue({ pick: 'Over 2.5', confidence: 0.8, rationale: 'x', model: 'kimi-k2.6' }),
    }));
    const { runSwarm: rs } = await import('../src/swarm/index.js');
    const r = await rs(5, fixture, [mkMarket('Over 2.5'), mkMarket('Under 2.5')], { ...baseConfig, enableSwarm: true, kimiApiKey: 'k' });
    expect(r).not.toBeNull();
    expect(r!.consensusPick).toBe('Over 2.5');
    expect(r!.divergence).toBeLessThan(0.01);
    expect(r!.highDivergence).toBe(false);
    vi.doUnmock('@oracle/llm');
  });

  it('flags high divergence when workers split', async () => {
    let call = 0;
    vi.doMock('@oracle/llm', () => ({
      callKimiVote: vi.fn().mockImplementation(async () => {
        call++;
        return call % 2 === 0
          ? { pick: 'Over 2.5', confidence: 0.7, rationale: 'a', model: 'kimi-k2.6' }
          : { pick: 'Under 2.5', confidence: 0.7, rationale: 'b', model: 'kimi-k2.6' };
      }),
    }));
    const { runSwarm: rs } = await import('../src/swarm/index.js');
    const r = await rs(6, fixture, [mkMarket('Over 2.5'), mkMarket('Under 2.5')], { ...baseConfig, enableSwarm: true, kimiApiKey: 'k' });
    expect(r).not.toBeNull();
    expect(r!.divergence).toBeGreaterThan(0.4);
    expect(r!.highDivergence).toBe(true);
    vi.doUnmock('@oracle/llm');
  });

  it('returns null when all workers fail', async () => {
    vi.doMock('@oracle/llm', () => ({ callKimiVote: vi.fn().mockResolvedValue(null) }));
    const { runSwarm: rs } = await import('../src/swarm/index.js');
    const r = await rs(5, fixture, [mkMarket('Over 2.5')], { ...baseConfig, enableSwarm: true, kimiApiKey: 'k' });
    expect(r).toBeNull();
    vi.doUnmock('@oracle/llm');
  });
});

describe('swarmToSoftContext — augment, not replace', () => {
  it('emits advisory news items only (never a PickRef / primaryPick)', () => {
    const result: SwarmResult = {
      consensusPick: 'Over 2.5', divergence: 0.1, votes: [], workers: 5, model: 'kimi-k2.6', highDivergence: false,
    };
    const items = swarmToSoftContext(result);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.kind).toBe('news');
      expect(item.source).toBe('swarm-consensus');
      // Soft-context items carry advisory text only — no decision authority.
      expect(item).not.toHaveProperty('primaryPick');
      expect(item).not.toHaveProperty('stake');
    }
  });

  it('adds an explicit high-divergence caution item when workers disagree', () => {
    const result: SwarmResult = {
      consensusPick: 'Over 2.5', divergence: 0.6, votes: [], workers: 6, model: 'kimi-k2.6', highDivergence: true,
    };
    const items = swarmToSoftContext(result);
    expect(items.some(i => i.text.includes('SWARM_HIGH_DIVERGENCE'))).toBe(true);
  });
});
