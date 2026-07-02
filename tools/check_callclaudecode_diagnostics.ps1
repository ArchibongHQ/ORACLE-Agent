# One-shot diagnostic check for PR #25's callClaudeCode() logging, run via a
# Windows Scheduled Task shortly after the 08:35 WAT daily-batch cron job.
# Read-only: greps the worker's stderr log + heartbeat file, writes a summary.
# See memory/oracle_claude_code_cli_diagnostics_fix.md for full context.

$ErrorActionPreference = "Stop"
$root = "c:\Users\HP PC\Documents\ORACLE\ORACLE Agent"
$stderrLog = Join-Path $root ".tmp\servy_worker_stderr.log"
$heartbeat = Join-Path $root ".tmp\worker_heartbeat.json"
$outFile = Join-Path $root ".tmp\callclaudecode_diagnostic_20260702.txt"

$lines = @()
$lines += "=== callClaudeCode diagnostic check ==="
$lines += "Run at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
$lines += ""

if (Test-Path $stderrLog) {
    $tail = Get-Content $stderrLog -Tail 500
    $matches = $tail | Select-String "\[callClaudeCode\]"
    $lines += "--- [callClaudeCode] lines in last 500 lines of servy_worker_stderr.log ---"
    if ($matches) {
        $lines += ($matches | ForEach-Object { $_.Line })
    } else {
        $lines += "(none found — either no failures occurred, or logging didn't fire)"
    }
} else {
    $lines += "--- servy_worker_stderr.log NOT FOUND at $stderrLog ---"
}

$lines += ""

if (Test-Path $heartbeat) {
    $lines += "--- worker_heartbeat.json ---"
    $lines += (Get-Content $heartbeat -Raw)
} else {
    $lines += "--- worker_heartbeat.json NOT FOUND at $heartbeat ---"
}

$lines | Out-File -FilePath $outFile -Encoding utf8
Write-Output "Diagnostic summary written to $outFile"
