# One-shot diagnostic check for PR #25's callClaudeCode() logging, run via a
# Windows Scheduled Task shortly after the 08:35 WAT daily-batch cron job.
# Read-only: greps the worker's stderr log + heartbeat file, writes a summary.
# See memory/oracle_claude_code_cli_diagnostics_fix.md for full context.

# Best-effort diagnostic - a read failure on one section (e.g. a transient
# sharing violation reading a log file OracleWorker, running as LocalSystem,
# is actively writing to) must not abort the whole script before the final
# Out-File runs. A prior version set $ErrorActionPreference = "Stop" globally
# with Out-File only at the very end, so any mid-script throw produced zero
# output and a bare exit code 1 (confirmed live: LastTaskResult 1, no file) -
# each risky read is now scoped and caught individually instead.
#
# NOTE: this file must stay plain ASCII and be saved WITH a UTF-8 BOM. Task
# Scheduler invokes this via Windows PowerShell 5.1 (powershell.exe -File),
# which reads BOM-less .ps1 files using the system ANSI codepage, not UTF-8 -
# a non-ASCII character (e.g. an em dash) silently mangles into multi-byte
# garbage and breaks string-literal parsing. This was a real, reproduced
# root cause of the task's LastTaskResult=1/no-output failure, independent
# of the ErrorActionPreference fix above.
$root = "c:\Users\HP PC\Documents\ORACLE\ORACLE Agent"
$stderrLog = Join-Path $root ".tmp\servy_worker_stderr.log"
$heartbeat = Join-Path $root ".tmp\worker_heartbeat.json"
$outFile = Join-Path $root ".tmp\callclaudecode_diagnostic_20260702.txt"

$lines = @()
$lines += "=== callClaudeCode diagnostic check ==="
$lines += "Run at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
$lines += ""

try {
    if (Test-Path $stderrLog) {
        $tail = Get-Content $stderrLog -Tail 500 -ErrorAction Stop
        $callClaudeMatches = $tail | Select-String "\[callClaudeCode\]"
        $lines += "--- [callClaudeCode] lines in last 500 lines of servy_worker_stderr.log ---"
        if ($callClaudeMatches) {
            $lines += ($callClaudeMatches | ForEach-Object { $_.Line })
        } else {
            $lines += "(none found - either no failures occurred, or logging didn't fire)"
        }
    } else {
        $lines += "--- servy_worker_stderr.log NOT FOUND at $stderrLog ---"
    }
} catch {
    $lines += "--- ERROR reading servy_worker_stderr.log: $($_.Exception.Message) ---"
}

$lines += ""

try {
    if (Test-Path $heartbeat) {
        $lines += "--- worker_heartbeat.json ---"
        $lines += (Get-Content $heartbeat -Raw -ErrorAction Stop)
    } else {
        $lines += "--- worker_heartbeat.json NOT FOUND at $heartbeat ---"
    }
} catch {
    $lines += "--- ERROR reading worker_heartbeat.json: $($_.Exception.Message) ---"
}

try {
    $lines | Out-File -FilePath $outFile -Encoding utf8 -ErrorAction Stop
    Write-Output "Diagnostic summary written to $outFile"
} catch {
    # Dropping $ErrorActionPreference = "Stop" (see NOTE above) means a write
    # failure here would otherwise print a non-terminating error and still
    # exit 0 - exactly the silent-failure mode this script exists to avoid.
    # Force a non-zero exit so Task Scheduler's LastTaskResult reflects it.
    Write-Error "Failed to write diagnostic output to $outFile : $($_.Exception.Message)"
    exit 1
}
