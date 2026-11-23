#Requires -Version 5.1
# CI self-test for scripts/dev-startup-diagnostic.ps1, the helper handed to developers verbatim.
# Runs the helper under the GENUINE Windows PowerShell 5.1 engine (powershell.exe) on fixture
# repos and proves: apply, idempotence, secret masking, hash-guarded restore (refuses files
# changed after the patch), byte-exact clean restore, and abort-safe pre-validation. No docker.
# DIAG_ENGINE overrides the engine (local smoke runs only; CI must use the real 5.1).
param()
$ErrorActionPreference = 'Stop'
$Engine = if ($env:DIAG_ENGINE) { $env:DIAG_ENGINE } else { 'powershell.exe' }
$Diag = Join-Path $PSScriptRoot 'dev-startup-diagnostic.ps1'
$work = Join-Path (Get-Location) 'fixture-diag'
$script:failures = @()

function Note([string]$m) { Write-Host $m }
function Fail([string]$m) { throw $m }
function Invoke-Diag([string[]]$rest) {
  $ep = @()
  if ((Split-Path -Leaf $Engine) -like 'powershell*') { $ep = @('-ExecutionPolicy', 'Bypass') }
  $out = & $Engine -NoProfile @ep -File $Diag @rest 2>&1 | Out-String
  return @{ Output = $out; Code = $LASTEXITCODE }
}
function New-Fixture([string]$name) {
  $dir = Join-Path $work $name
  New-Item -ItemType Directory -Force -Path (Join-Path $dir 'apps/api/src'), (Join-Path $dir 'infra') | Out-Null
  $main = @'
import { NestFactory } from '@nestjs/core';
// his own local edit must survive the patch and the restore
async function bootstrap() { const app = await NestFactory.create({}); await app.listen(3000); }
bootstrap().catch(() => { console.error('[startup] startup failed; preserve migration journal and backups, no automatic seed/reset'); process.exit(1); });
'@
  [System.IO.File]::WriteAllText((Join-Path $dir 'apps/api/src/main.ts'), $main, (New-Object System.Text.UTF8Encoding($false)))
  $compose = @'
environment:
  IAM_WORKSPACE_MODE: "1"
  IAM_DEMO_DATA_SEED: "1"
  IAM_PLUGIN_STORE: dolt
'@
  [System.IO.File]::WriteAllText((Join-Path $dir 'infra/docker-compose.dev.yml'), $compose, (New-Object System.Text.UTF8Encoding($false)))
  return $dir
}

try {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $work | Out-Null

  $engineVersion = (& $Engine -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' 2>&1 | Out-String).Trim()
  Note ("helper engine: " + $Engine + ' -> PS ' + $engineVersion)
  if ((Split-Path -Leaf $Engine) -like 'powershell*' -and -not $engineVersion.StartsWith('5.1')) {
    Fail "the CI proof must run under the real 5.1 engine, got $engineVersion"
  }

  # 1) apply + backups + state + instructions use the real script path
  $fx1 = New-Fixture 'fx1'
  $r = Invoke-Diag @('-FixtureRoot', $fx1)
  if ($r.Code -ne 0) { Fail ('apply exit=' + $r.Code + ' output: ' + $r.Output) }
  $main1 = [System.IO.File]::ReadAllText((Join-Path $fx1 'apps/api/src/main.ts'))
  if ($main1 -notlike '*startup failed:*e instanceof Error*') { Fail 'main.ts patch missing' }
  if ($main1 -notlike '*his own local edit must survive*') { Fail 'pre-existing edit lost' }
  if ([System.IO.File]::ReadAllText((Join-Path $fx1 'infra/docker-compose.dev.yml')) -notlike '*IAM_DEMO_DATA_SEED: "0"*') { Fail 'seed not disabled' }
  foreach ($b in 'main.ts.orig', 'docker-compose.dev.yml.orig', 'state.txt') {
    if (-not (Test-Path (Join-Path $fx1 (Join-Path '.startup-diagnostic-backup' $b)))) { Fail "backup/$b missing" }
  }
  if ($r.Output -notlike '*dev-startup-diagnostic.ps1*') { Fail 'instructions do not use the real script path' }

  # 2) idempotence: second apply is a no-op and never refreshes the original backups
  $r = Invoke-Diag @('-FixtureRoot', $fx1)
  if ($r.Code -ne 0) { Fail ('second apply exit=' + $r.Code) }
  if ([System.IO.File]::ReadAllText((Join-Path $fx1 'apps/api/src/main.ts')) -cne $main1) { Fail 'second apply changed main.ts (not idempotent)' }
  if ([System.IO.File]::ReadAllText((Join-Path $fx1 '.startup-diagnostic-backup/main.ts.orig')) -like '*instanceof Error*') { Fail 'backup overwritten by second apply' }

  # 3) collect + best-effort masking
  $log = @'
[Nest] 42 LOG [RouterExplorer] Mapped {/account-blocks, GET} route +1ms
[startup] startup failed: Error: Automatic activation refused: Separation-of-Duties violations
at MainPublication.start (/repo/apps/api/src/workspace/main-publication.ts:44:15)
upstream said token=sekrit99 authorization: Bearer abcdef123456789 password=hunter2hunter2 dsn=postgres://pguser:pgpass99@runtime-pg:5432/runtime
'@
  $logPath = Join-Path $fx1 'fixture-api.log'
  [System.IO.File]::WriteAllText($logPath, $log, (New-Object System.Text.UTF8Encoding($false)))
  $r = Invoke-Diag @('-FixtureRoot', $fx1, '-Collect', '-FixtureLog', $logPath)
  if ($r.Code -ne 0) { Fail ('collect exit=' + $r.Code + ' output: ' + $r.Output) }
  $out = [System.IO.File]::ReadAllText((Join-Path $fx1 'startup-diagnostic.txt'))
  foreach ($need in 'Separation-of-Duties violations', 'MainPublication.start') { if ($out -notlike "*$need*") { Fail "collect dropped: $need" } }
  foreach ($bad in 'abcdef123456789', 'sekrit99', 'hunter2hunter2', 'pgpass99') { if ($out -like "*$bad*") { Fail "collect leaked: $bad" } }

  # 4) restore REFUSES a file changed after the patch (backup kept), restores the untouched one
  $composePatchedHash = (Get-FileHash (Join-Path $fx1 'infra/docker-compose.dev.yml')).Hash
  [System.IO.File]::AppendAllText((Join-Path $fx1 'apps/api/src/main.ts'), '// edited after the patch')
  $r = Invoke-Diag @('-FixtureRoot', $fx1, '-Restore')
  if ($r.Code -eq 0) { Fail 'restore should refuse a file changed after the patch' }
  if ([System.IO.File]::ReadAllText((Join-Path $fx1 'apps/api/src/main.ts')) -notlike '*edited after the patch*') { Fail 'restore overwrote a file changed after the patch' }
  if (-not (Test-Path (Join-Path $fx1 '.startup-diagnostic-backup/main.ts.orig'))) { Fail 'refused restore must keep the backup' }
  if ((Get-FileHash (Join-Path $fx1 'infra/docker-compose.dev.yml')).Hash -eq $composePatchedHash) { Fail 'untouched compose was not restored' }
  if (Test-Path (Join-Path $fx1 '.startup-diagnostic-backup/docker-compose.dev.yml.orig')) { Fail 'a successful restore must consume the compose backup' }

  # 5) clean restore is byte-exact
  $fx2 = New-Fixture 'fx2'
  $mainBefore = (Get-FileHash (Join-Path $fx2 'apps/api/src/main.ts')).Hash
  $compBefore = (Get-FileHash (Join-Path $fx2 'infra/docker-compose.dev.yml')).Hash
  $r = Invoke-Diag @('-FixtureRoot', $fx2)
  if ($r.Code -ne 0) { Fail ('fx2 apply exit=' + $r.Code) }
  $r = Invoke-Diag @('-FixtureRoot', $fx2, '-Restore')
  if ($r.Code -ne 0) { Fail ('clean restore exit=' + $r.Code + ' output: ' + $r.Output) }
  if ((Get-FileHash (Join-Path $fx2 'apps/api/src/main.ts')).Hash -ne $mainBefore) { Fail 'main.ts restore not byte-exact' }
  if ((Get-FileHash (Join-Path $fx2 'infra/docker-compose.dev.yml')).Hash -ne $compBefore) { Fail 'compose restore not byte-exact' }
  if (Test-Path (Join-Path $fx2 '.startup-diagnostic-backup/main.ts.orig')) { Fail 'clean restore must consume the main.ts backup' }
  if (Test-Path (Join-Path $fx2 '.startup-diagnostic-backup/docker-compose.dev.yml.orig')) { Fail 'clean restore must consume the compose backup' }
  if (Test-Path (Join-Path $fx2 '.startup-diagnostic-backup/state.txt')) { Fail 'clean restore must clear the state file' }

  # 6) unexpected compose format aborts EVERYTHING (main.ts untouched too)
  $fx3 = New-Fixture 'fx3'
  [System.IO.File]::WriteAllText((Join-Path $fx3 'infra/docker-compose.dev.yml'), "environment:`n  IAM_DEMO_DATA_SEED: `${IAM_DEMO_DATA_SEED:-0}", (New-Object System.Text.UTF8Encoding($false)))
  $mainBefore3 = (Get-FileHash (Join-Path $fx3 'apps/api/src/main.ts')).Hash
  $compBefore3 = (Get-FileHash (Join-Path $fx3 'infra/docker-compose.dev.yml')).Hash
  $r = Invoke-Diag @('-FixtureRoot', $fx3)
  if ($r.Code -eq 0) { Fail 'unexpected compose format must abort' }
  if ((Get-FileHash (Join-Path $fx3 'apps/api/src/main.ts')).Hash -ne $mainBefore3) { Fail 'main.ts written despite abort' }
  if ((Get-FileHash (Join-Path $fx3 'infra/docker-compose.dev.yml')).Hash -ne $compBefore3) { Fail 'compose written despite abort' }

  # 7) missing compose aborts EVERYTHING as well
  $fx4 = New-Fixture 'fx4'
  Remove-Item -Force (Join-Path $fx4 'infra/docker-compose.dev.yml')
  $r = Invoke-Diag @('-FixtureRoot', $fx4)
  if ($r.Code -eq 0) { Fail 'missing compose must abort' }
  if ([System.IO.File]::ReadAllText((Join-Path $fx4 'apps/api/src/main.ts')) -like '*instanceof Error*') { Fail 'main.ts written despite missing-compose abort' }

  # 8) compose without any seed line: provably inactive, apply still succeeds
  $fx5 = New-Fixture 'fx5'
  [System.IO.File]::WriteAllText((Join-Path $fx5 'infra/docker-compose.dev.yml'), "environment:`n  IAM_WORKSPACE_MODE: `"1`"", (New-Object System.Text.UTF8Encoding($false)))
  $r = Invoke-Diag @('-FixtureRoot', $fx5)
  if ($r.Code -ne 0) { Fail ('seedless compose apply exit=' + $r.Code) }

  # 9) cycle: apply -> restore -> legitimate edit -> apply again -> the new backup holds the
  #    EDITED file (a stale backup from the first cycle would silently revert the edit)
  $fx6 = New-Fixture 'fx6'
  $r = Invoke-Diag @('-FixtureRoot', $fx6)
  if ($r.Code -ne 0) { Fail ('fx6 apply exit=' + $r.Code) }
  $r = Invoke-Diag @('-FixtureRoot', $fx6, '-Restore')
  if ($r.Code -ne 0) { Fail ('fx6 restore exit=' + $r.Code) }
  [System.IO.File]::AppendAllText((Join-Path $fx6 'apps/api/src/main.ts'), '// legitimate edit between cycles')
  $r = Invoke-Diag @('-FixtureRoot', $fx6)
  if ($r.Code -ne 0) { Fail ('fx6 re-apply exit=' + $r.Code + ' output: ' + $r.Output) }
  $bak2 = [System.IO.File]::ReadAllText((Join-Path $fx6 '.startup-diagnostic-backup/main.ts.orig'))
  if ($bak2 -notlike '*legitimate edit between cycles*') { Fail 'second-cycle backup is stale: it would revert the legitimate edit' }
  if ($bak2 -like '*instanceof Error*') { Fail 'second-cycle backup captured the PATCHED file' }
  $r = Invoke-Diag @('-FixtureRoot', $fx6, '-Restore')
  if ($r.Code -ne 0) { Fail ('fx6 second restore exit=' + $r.Code) }
  if ([System.IO.File]::ReadAllText((Join-Path $fx6 'apps/api/src/main.ts')) -notlike '*legitimate edit between cycles*') { Fail 'second-cycle restore lost the legitimate edit' }

  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  Note 'STARTUP DIAGNOSTIC SELF-TEST PASSED'
} catch {
  Write-Host ('SELF-TEST FAILED: ' + $_.Exception.Message)
  Write-Host ('AT: ' + $_.InvocationInfo.PositionMessage)
  exit 1
}
exit 0
