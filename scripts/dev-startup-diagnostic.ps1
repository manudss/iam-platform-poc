#Requires -Version 5.1
# Startup diagnostic for the local dev stack (one-shot, reversible, no git mutation):
#   default  : applies the minimal observability patch ONLY - main.ts prints the real startup
#              error instead of swallowing it - and disables the demo seed for the diagnostic
#              run. The seed's own startup writes are the only ones this removes; no other
#              startup processing is claimed write-free. Every file is validated BEFORE any
#              write: one unexpected content aborts everything untouched. Each patched file is
#              backed up byte-for-byte first and its post-patch hash is recorded.
#   -Collect : copies the persisted API log out of the stack (running, stopped or removed),
#              keeps the last "startup failed" block, masks secrets best-effort, and writes
#              startup-diagnostic.txt to send back. Temporary copies are deleted right away.
#   A successful restore CONSUMES the backup (deleted), so the next apply saves the current
#   state fresh - a stale backup can never overwrite newer changes in a later patch/restore cycle.
#   -Restore : puts the original files back from the backups, but ONLY when the current file
#              still matches the recorded post-patch hash; otherwise it refuses and keeps the
#              backup, so changes made after the patch are never overwritten. Never runs git
#              checkout or any reset.
# Masking is best-effort for token-shaped values; review the output file before sending it.
# -FixtureRoot / -FixtureLog are used by the Windows CI self-test (no repo, no docker).
param(
  [string]$Repo,
  [switch]$Restore,
  [switch]$Collect,
  [string]$FixtureRoot,
  [string]$FixtureLog
)
$ErrorActionPreference = 'Continue'  # 'Stop' trips the PS 5.1 native-stderr quirk on docker calls; explicit checks below

function Mask-Line([string]$s) {
  $s = $s -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}', '$1***'
  $s = $s -replace '(?i)((token|password|secret|authorization|code_verifier|api_key|apikey)["''\s]*[:=]["''\s]*)[^"''\s,}\]]{4,}', '$1***'
  $s = $s -replace '(?i)([a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s]{3,}(@)', '$1***$2'
  $s = $s -replace 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}', '***'
  if ($s.Length -gt 300) { $s = $s.Substring(0, 300) }
  return $s
}

$root = $null
if ($FixtureRoot) { $root = (Resolve-Path -LiteralPath $FixtureRoot).Path }
elseif ($Repo) { $root = (Resolve-Path -LiteralPath $Repo).Path }
else {
  $candidates = @((Get-Location).Path)
  if ($PSScriptRoot) { $candidates += (Split-Path -Parent $PSScriptRoot) }
  foreach ($c in $candidates) { if (Test-Path -LiteralPath (Join-Path $c 'apps\api\src\main.ts')) { $root = $c; break } }
}
if (-not $root -or -not (Test-Path -LiteralPath (Join-Path $root 'apps\api\src\main.ts'))) {
  Write-Host 'Repo introuvable : place-toi a la racine du repo iam-platform-poc puis relance (ou -Repo <chemin>).'
  exit 1
}
$mainTs = Join-Path $root 'apps\api\src\main.ts'
$composeDev = Join-Path $root 'infra\docker-compose.dev.yml'
$backupDir = Join-Path $root '.startup-diagnostic-backup'
$stateFile = Join-Path $backupDir 'state.txt'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$oldCatch = "bootstrap().catch(() => { console.error('[startup] startup failed;"
$newCatch = "bootstrap().catch((e) => { console.error('[startup] startup failed:', e instanceof Error ? e.stack || e.message : e, ';"
$patchMarker = "startup failed:', e instanceof Error"
$seedOn = 'IAM_DEMO_DATA_SEED: "1"'
$seedOff = 'IAM_DEMO_DATA_SEED: "0"'

function Get-Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }

function Backup-Once([string]$path) {
  if (-not (Test-Path -LiteralPath $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
  $dst = Join-Path $backupDir ((Split-Path -Leaf $path) + '.orig')
  if (-not (Test-Path -LiteralPath $dst)) {
    [System.IO.File]::WriteAllBytes($dst, [System.IO.File]::ReadAllBytes($path))
    Write-Host ('backup: ' + $dst)
  }
}

function Read-State() {
  $h = @{}
  if (Test-Path -LiteralPath $stateFile) {
    foreach ($l in [System.IO.File]::ReadAllLines($stateFile)) {
      $p = $l -split '=', 2
      if ($p.Count -eq 2 -and $p[0]) { $h[$p[0]] = $p[1] }
    }
  }
  return $h
}

function Set-State([string]$name, [string]$sha) {
  $h = Read-State
  $h[$name] = $sha
  if (-not (Test-Path -LiteralPath $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
  $lines = @()
  foreach ($k in $h.Keys) { $lines += ($k + '=' + $h[$k]) }
  [System.IO.File]::WriteAllLines($stateFile, $lines, $utf8NoBom)
}

function Clear-State([string]$name) {
  $h = Read-State
  $h.Remove($name)
  if ($h.Count -eq 0) {
    if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile -Force }
  } else {
    $lines = @()
    foreach ($k in $h.Keys) { $lines += ($k + '=' + $h[$k]) }
    [System.IO.File]::WriteAllLines($stateFile, $lines, $utf8NoBom)
  }
}

# Classifies a file WITHOUT touching it: 'patch' (exact expected content), 'done' (already in
# the target state), 'absent-ok' (compose without any seed line = provably inactive), else
# 'unexpected'/'missing' -> the caller aborts everything before any write.
function Get-MainState() {
  $text = [System.IO.File]::ReadAllText($mainTs)
  if ($text.Contains($patchMarker)) { return 'done' }
  if ($text.Contains($oldCatch)) { return 'patch' }
  return 'unexpected'
}
function Get-ComposeState() {
  if (-not (Test-Path -LiteralPath $composeDev)) { return 'missing' }
  $c = [System.IO.File]::ReadAllText($composeDev)
  $occ = [regex]::Matches($c, 'IAM_DEMO_DATA_SEED').Count
  if ($occ -eq 1 -and $c.Contains($seedOn)) { return 'patch' }
  if ($occ -eq 1 -and $c.Contains($seedOff)) { return 'done' }
  if ($occ -eq 0) { return 'absent-ok' }
  return 'unexpected'
}

if ($Restore) {
  $state = Read-State
  $refused = $false
  $restored = $false
  foreach ($f in @($mainTs, $composeDev)) {
    $name = Split-Path -Leaf $f
    $bak = Join-Path $backupDir ($name + '.orig')
    if (-not (Test-Path -LiteralPath $bak)) { continue }
    $expected = $state[$name]
    if (-not $expected) {
      Write-Host ($name + ' : aucun hash post-patch enregistre, restore REFUSE, backup conserve : ' + $bak)
      $refused = $true
      continue
    }
    if ((Get-Sha $f) -ne $expected) {
      Write-Host ($name + ' : le fichier a change depuis le patch, restore REFUSE pour ne pas ecraser tes changements.')
      Write-Host ('  backup conserve : ' + $bak + ' (a comparer/reprendre a la main)')
      $refused = $true
      continue
    }
    [System.IO.File]::WriteAllBytes($f, [System.IO.File]::ReadAllBytes($bak))
    Remove-Item -LiteralPath $bak -Force
    Clear-State $name
    Write-Host ('restored: ' + $f + ' (backup consomme : un futur patch re-sauvegardera l etat du moment)')
    $restored = $true
  }
  if ($refused) { exit 1 }
  if (-not $restored) { Write-Host 'Aucune sauvegarde a restaurer (rien n avait ete patche).' }
  else { Write-Host 'Fichiers restaures a leur etat exact d avant le patch. Tu peux supprimer .startup-diagnostic-backup quand tout est fini.' }
  exit 0
}

if ($Collect) {
  $lines = $null
  if ($FixtureLog) {
    $lines = @(Get-Content -LiteralPath $FixtureLog -Encoding UTF8)
  } else {
    $cf = @('--env-file', '.env', '-f', 'infra/docker-compose.yml', '-f', 'infra/docker-compose.dev.yml')
    Push-Location $root
    try {
      # 1) stack running: read the persisted log from the live container (nothing written to disk)
      $lines = @(docker compose @cf exec -T app cat /var/lib/lyam-dev/api.log 2>$null)
      if (-not $lines -or -not ($lines -match 'startup failed')) {
        # 2) containers stopped but present: docker cp still works; the temp copy is deleted below
        $tmp = Join-Path $env:TEMP ('lyam-api-log-' + [guid]::NewGuid().ToString('N') + '.txt')
        try {
          docker compose @cf cp app:/var/lib/lyam-dev/api.log $tmp 2>$null | Out-Null
          if (Test-Path -LiteralPath $tmp) { $lines = @(Get-Content -LiteralPath $tmp -Encoding UTF8) }
        } finally {
          if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
        }
      }
      if (-not $lines) {
        # 3) containers removed: throwaway container on the same data volume (nothing written to disk)
        $lines = @(docker compose @cf run --rm --no-deps -T app cat /var/lib/lyam-dev/api.log 2>$null)
      }
    } finally { Pop-Location }
  }
  $lines = @($lines | Where-Object { $_ -ne $null })
  if (-not $lines) { Write-Host 'Log API introuvable. Relance scripts\dev.ps1, attends l erreur, puis relance avec -Collect.'; exit 1 }
  $idx = -1
  for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -match 'startup failed') { $idx = $i; break } }
  if ($idx -lt 0) { Write-Host 'Pas encore de ligne "startup failed" dans le log. Attends que la boucle affiche l erreur, puis relance -Collect.'; exit 1 }
  $start = [Math]::Max(0, $idx - 25)
  $end = [Math]::Min($lines.Count - 1, $idx + 30)
  $out = New-Object System.Collections.Generic.List[string]
  $out.Add('commit: ' + (& git -C $root rev-parse HEAD 2>$null))
  $out.Add('branche: ' + (& git -C $root rev-parse --abbrev-ref HEAD 2>$null))
  $out.Add('etat local main.ts / compose.dev: ' + ((& git -C $root status --porcelain -- apps/api/src/main.ts infra/docker-compose.dev.yml 2>$null) -join '; '))
  $out.Add('--- dernier bloc startup failed (masquage best-effort) ---')
  for ($i = $start; $i -le $end; $i++) { $out.Add((Mask-Line $lines[$i])) }
  $dest = Join-Path $root 'startup-diagnostic.txt'
  [System.IO.File]::WriteAllLines($dest, $out, $utf8NoBom)
  Write-Host ('Diagnostic ecrit : ' + $dest)
  Write-Host 'Envoie ce fichier. Masquage best-effort : jette un oeil avant envoi.'
  exit 0
}

# --- default: pre-validate EVERYTHING, then apply the minimal observability patch ---
$mainState = Get-MainState
$composeState = Get-ComposeState
if ($mainState -eq 'unexpected' -or $composeState -eq 'unexpected' -or $composeState -eq 'missing') {
  Write-Host ('Contenu inattendu, RIEN modifie. main.ts=' + $mainState + ' docker-compose.dev.yml=' + $composeState)
  Write-Host 'Transmets ce message.'
  exit 1
}
if ($mainState -eq 'patch') {
  Backup-Once $mainTs
  $text = [System.IO.File]::ReadAllText($mainTs)
  [System.IO.File]::WriteAllText($mainTs, $text.Replace($oldCatch, $newCatch), $utf8NoBom)
  Set-State 'main.ts' (Get-Sha $mainTs)
  Write-Host 'main.ts : patch applique, la vraie erreur de demarrage sera affichee.'
} else {
  Write-Host 'main.ts : patch deja applique, rien a faire.'
}
if ($composeState -eq 'patch') {
  Backup-Once $composeDev
  $c = [System.IO.File]::ReadAllText($composeDev)
  [System.IO.File]::WriteAllText($composeDev, $c.Replace($seedOn, $seedOff), $utf8NoBom)
  Set-State 'docker-compose.dev.yml' (Get-Sha $composeDev)
  Write-Host 'docker-compose.dev.yml : seed demo desactive pour le diagnostic (ses ecritures de demarrage sont supprimees ; garantie limitee au seed, les autres traitements de demarrage ne sont pas couverts).'
} elseif ($composeState -eq 'absent-ok') {
  Write-Host 'docker-compose.dev.yml : aucune ligne seed, seed inactif par construction, rien a faire.'
} else {
  Write-Host 'docker-compose.dev.yml : seed deja desactive, rien a faire.'
}
$self = $PSCommandPath
Write-Host ''
Write-Host 'Prochaines etapes :'
Write-Host '  1. Relance scripts\dev.ps1'
Write-Host '  2. Attends que la boucle affiche "[startup] startup failed:" suivi de la vraie erreur'
Write-Host '  3. Sans arreter la pile, ouvre un AUTRE terminal a la racine du repo et lance :'
Write-Host ('       powershell -ExecutionPolicy Bypass -File "' + $self + '" -Collect')
Write-Host '     (si tu as recu ce fichier en .txt, renomme-le d abord en .ps1)'
Write-Host '  4. Envoie le fichier startup-diagnostic.txt produit a la racine du repo'
Write-Host 'Apres le diagnostic, pour remettre les fichiers comme avant : meme script avec -Restore'
Write-Host '(le restore refuse tout fichier modifie depuis le patch et conserve son backup)'
exit 0
