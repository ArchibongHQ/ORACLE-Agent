---
name: webperf
description: Run a live Core Web Vitals / web performance audit against apps/web (or any browser-facing page). Use for performance-focused audits, CWV analysis (LCP/INP/CLS), and structural performance anti-patterns — not for utility libraries, CLIs, or server-only code with no browser output.
triggers: /webperf
---

# Web Performance Audit

Vendored and adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (`web-performance-auditor` persona), standalone — no subagent/plugin architecture required.

For static-diff performance checks during `/review` (N+1 queries, bundle size, algorithmic complexity as part of a PR review), use the existing `.claude/skills/review/specialists/performance.md` instead. This skill is for a dedicated, live performance audit of a running page.

## Operating Modes

**Quick mode (default — no tool artifacts provided):** Scan source code directly for structural anti-patterns. Every finding is tagged **potential impact**, never as a measurement. The scorecard is marked `not measured` and left empty.

**Deep mode (activated when tool artifacts or live measurement are available):** Interpret performance data from one or more of:

- **Lighthouse JSON report**: `npx lighthouse <url> --output json --output-path ./report.json`, or `npx -p chrome-devtools-mcp chrome-devtools lighthouse_audit --output-format=json` (no install required, no MCP server needed — CLI works standalone).
- **PageSpeed Insights JSON**: full response from `pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed`. Contains `lighthouseResult` (lab) and `loadingExperience` (CrUX field data). Parse both.
- **CrUX API response**: field data (p75, last 28 days). Requires `CRUX_API_KEY` or `GOOGLE_API_KEY`.
- **DevTools performance trace** (Perfetto JSON): summarize what's extractable, flag the rest unparsed.

Populate the scorecard only with values backed by these sources. Mark unmeasured fields `not measured`.

## Metric-Honesty Rule

**Never fabricate metrics.** Static source reading cannot measure real-world LCP, INP, or CLS. If no tool data is provided, return a source-level findings report, mark the entire scorecard `not measured`, and label every finding `potential impact`.

When data IS provided, label each scorecard value with its source (`Field (CrUX)`, `Lab (Lighthouse)`, `Trace (DevTools)`). Field and lab data are not interchangeable — field is real users, lab is one synthetic run. Violating this rule is worse than returning no scorecard.

## Review Scope

Identify the actual stack first — `apps/web` is a plain `node:http` server (`src/server.ts` + `src/page.ts`), not a framework SPA. Don't recommend React/Vue/Next.js idioms against it.

1. **Core Web Vitals** — LCP element and timing, layout shift sources, long tasks blocking INP, image/iframe explicit dimensions.
2. **Loading** — TTFB, preconnect/dns-prefetch, render-blocking `<head>` scripts, font loading strategy, response compression.
3. **Rendering** — layout thrashing, `content-visibility`, animation compositing (transform/opacity only).
4. **Network** — caching headers, HTTP/2+, pagination on any API responses, redundant sequential fetches that should be `Promise.all`.

## Severity

| Severity | Criteria | Action |
|---|---|---|
| Critical | Directly fails a CWV "Good" threshold | Fix before release |
| High | Likely degrades a CWV or causes significant slowdown | Fix before release |
| Medium | Suboptimal pattern, contained impact | Fix this sprint |
| Low | Best-practice gap, minor/speculative impact | Backlog |
| Info | Improvement opportunity, no evidence of impact | Consider |

## Output Format

```markdown
## Web Performance Audit

### Scorecard
| Metric | Value | Source | Target | Status |
|--------|-------|--------|--------|--------|
| LCP | [value or "not measured"] | [Field/Lab/Trace/—] | ≤ 2.5s | [Good/Needs Work/Poor/—] |
| INP | [value or "not measured"] | [Field/Lab/Trace/—] | ≤ 200ms | [Good/Needs Work/Poor/—] |
| CLS | [value or "not measured"] | [Field/Lab/Trace/—] | ≤ 0.1 | [Good/Needs Work/Poor/—] |
| Lighthouse Performance | [score or "not measured"] | [Lab/—] | ≥ 90 | [Pass/Fail/—] |

> Artifacts used: [list, or "none — source analysis only"]
> Stack detected: [e.g. vanilla node:http + static page]

### Findings
#### [SEVERITY] [Finding title]
- **Area:** CWV / Loading / Rendering / Network
- **Location:** file:line or URL
- **Description / Impact / Recommendation**

### Positive Observations
### Recommendations
```

## Rules

1. Lead with the scorecard; state explicitly if unmeasured.
2. Never present lab values as field values or vice versa.
3. Tag static-analysis findings `potential impact`, never as measurement.
4. Identify the actual stack before recommending stack-specific patterns.
5. Every finding needs a specific, actionable fix.
6. No micro-optimizations without evidence they affect a measurable metric.
7. Acknowledge good practices already in place.
