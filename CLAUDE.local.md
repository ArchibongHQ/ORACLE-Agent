# Local Notes (machine-specific, gitignored)

Personal/machine-specific context for this dev box. Not checked in — see `.gitignore`.

- **Shell:** PowerShell is primary on this Windows 11 box; Bash tool is also available for POSIX-style scripts. Don't mix syntax between the two.
- **`pnpm turbo run typecheck test build`** can OOM at default/`--concurrency=4` on this machine — run with `--concurrency=1` instead. Not a code bug, just local resource limits.
- **Quick Heal AV** can stall fresh small-file writes for minutes with ~0 process CPU time — looks like a hang, isn't. Check via `Get-Process` before assuming a script is stuck.
- **`OracleWorker`** runs as a Servy-managed Windows service. Auto-restart is OFF (`recoveryAction: None`) — a crash leaves it stopped until manually restarted; a fix for this was drafted but needs admin approval.
- **Local web UI** binds `127.0.0.1:8787` by default (`HOST`/`PORT` env overrides) via `pnpm --filter @oracle/web start`.
