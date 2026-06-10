# VISION.md — ORACLE Agent Product Vision

**Reference this in every major task.**

## One-Liner Vision
Build a self-improving AI sports-analytics engine that converts raw match data into profitable,
evidence-backed betting intelligence — autonomously and reliably.

## Core Objectives
- Primary problem solved: Manual analysis of thousands of matches is too slow and error-prone
- Target users: Individual bettor (the owner) and any future subscribers
- Key value proposition: Systematic, model-driven edge discovery with transparent reasoning

## Success Metrics (KPIs)
- GBM gate accuracy ≥ 52% on held-out test set
- End-to-end pipeline runtime < 5 min per run
- Zero job FAILURES in the production worker over 30 days — measured: every cron job logs
  `[worker] <ts> <job>: start/ok/FAILED` and successful batch/resolve runs stamp
  `.tmp/worker_heartbeat.json` (surfaced at web `/health`); a FAILED line or stale heartbeat
  breaks the streak
- All 313+ engine tests green at every merge — enforced by CI (.github/workflows/ci.yml)

## Non-Goals
- Not a general-purpose chatbot or Q&A tool
- Not a live streaming data ingestion platform (batch only for now)
- Not a multi-user SaaS product in the near term

## Architecture & Design Principles
- Tech stack: TypeScript, Node.js, pnpm monorepo (Turborepo), Python tools
- WAT framework: Workflows (instructions) → Agent (decision) → Tools (execution)
- Core principles: deterministic execution layer, probabilistic reasoning layer, strict separation

## Roadmap
- Done: Gemini 3.x SDK swap (Part A), 7 LLM agentic layers B1–B7, split-model GBM,
        H2H enrichment, punt counter-booking pipeline (@oracle/bot), swarm upgrade,
        T0 news cache, Kaggle Phase 1 (SPI/squad-value/odds-timeseries tools + GBM wiring),
        Kaggle Phase 2 (FBref PPDA, injuries, referee strictness, match-xG wired into GBM),
        BTB gzip parser (54k matches), all 15 Kaggle dataset dirs downloaded + processed,
        GBM retrained with 110-feature matrix (top5 delta -0.0009, base delta +0.0000 — advisory),
        API-Football lineups wired into decision-layer soft context (enrichWithLineups + worker pre-batch fetch)
- Now: Top up API credits (Anthropic + Gemini) → run live batch → monitor World Cup window
- Next: Consider Pinnacle odds API for higher-quality OTS coverage (BTB skews non-top5)
- Later: Multi-user tier, live odds feed integration

## Definition of Done
Any feature must: advance the vision, pass `pnpm turbo run typecheck test build`, and maintain
or improve GBM gate accuracy. No feature ships without the verification loop passing.

**Update after major milestones.**
