#Requires -Version 5.1
# Minimal dev-stack diagnostic for a failing "My applications": prints ONLY the API's recent
# exception lines and stack frames (no request headers, bodies or query parameters), plus the
# checked-out commit and the presence of non-secret config flags. Run from the repo root.
# Masking is best-effort for token-shaped values; the selection itself avoids headers and bodies.
# -FixturePath reads a saved log instead of the live stack (used by the Windows CI self-test).
param([string]$FixturePath)
$ErrorActionPreference = 'Continue'
function Mask-Line([string]$s) {
  $s = $s -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}', '$1***'
  $s = $s -replace '(?i)((token|password|secret|authorization|code_verifier)["''\s]*[:=]["''\s]*)[^"''\s,}\]]{4,}', '$1***'
  if ($s.Length -gt 220) { $s = $s.Substring(0, 220) }
  return $s
}
Write-Host ('commit: ' + (git rev-parse --short HEAD 2>$null))
if ($FixturePath) {
  $raw = Get-Content -LiteralPath $FixturePath -Encoding UTF8
} else {
  $cf = @('--env-file', '.env', '-f', 'infra/docker-compose.yml', '-f', 'infra/docker-compose.dev.yml')
  Write-Host 'config presence (non-secret flags):'
  docker compose @cf exec -T app printenv IAM_WORKSPACE_MODE IAM_DEMO_DATA_SEED IAM_PLUGIN_STORE 2>$null
  Write-Host 'Recharge la page My applications dans le navigateur, puis appuie sur Entree.'
  Read-Host | Out-Null
  $raw = docker compose @cf logs app --since 5m 2>&1
}
$raw | Select-String -Pattern 'ERROR|Exception|Internal server error|\bat\s+[\w.$<>]+\s+\(' |
  Select-Object -Last 40 | ForEach-Object { Mask-Line $_.Line }
