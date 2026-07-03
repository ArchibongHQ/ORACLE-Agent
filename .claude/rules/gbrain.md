# GBrain Configuration

Configured by `/setup-gbrain`:

- Mode: local-stdio
- Engine: pglite
- Config file: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-06-14
- MCP registered: yes (user scope, gbrain serve)
- Artifacts sync: full → github.com/ArchibongHQ/gstack-artifacts-HP-PC
- Current repo policy: read-write
- Transcript ingest: incremental

Note: the "GBrain Search Guidance" block (how/when to prefer `gbrain` over `Grep`) stays in the root `CLAUDE.md`, not here — `/sync-gbrain` auto-rewrites that block in place between `<!-- gstack-gbrain-search-guidance:start/end -->` markers, and those markers are anchored to `CLAUDE.md` specifically. Moving it here would break the auto-sync.
