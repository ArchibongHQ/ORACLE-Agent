---
name: graphify
description: Build a token-efficient knowledge graph of the ORACLE Agent codebase for fast agent navigation
---

Run `graphify` over a target directory. Output always lands in `graphify-out/` (gitignored).

## Common invocations

```
/graphify .                  # Full repo graph
/graphify packages/          # Packages layer only
/graphify . --wiki           # + Obsidian-compatible wiki at graphify-out/wiki/index.md
/graphify . --mcp            # Start MCP stdio server for agent tool-use navigation
/graphify . --update         # Incremental refresh (changed files only — use after edits)
```

## Outputs

| File | Purpose |
|------|---------|
| `graphify-out/graph.html` | Interactive browser visualization |
| `graphify-out/report.md`  | Plain-English summary with god nodes and surprising connections |
| `graphify-out/graph.json` | Raw graph data (nodes, edges, confidence tiers) |
| `graphify-out/wiki/`      | Markdown articles per cluster + `index.md` entry point |

## Querying the graph

After running with `--wiki`, ask questions like:
- "What calls `ExecutionEngine.run()`?"
- "What connects `skillopt` to `oracle_decision_rubric`?"
- "What are the highest-connectivity nodes in packages/engine?"

Navigate via `graphify-out/wiki/index.md` or let Claude read it directly. Token cost is ~71x lower than raw file reads on a 40–50 file corpus.

## When to run

See `workflows/graphify.md` for the full SOP including update cadence and MCP server setup.
