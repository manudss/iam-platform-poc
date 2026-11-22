#Requires -Version 5.1
<#
.SYNOPSIS
  Start the full Lyam (iam-platform-poc) local development stack with ONE command.
  Only prerequisite: Docker Desktop. No Node, no Rust, no MSVC build tools on the host.
.DESCRIPTION
  Starts Dolt (seeded with fictional data), PostgreSQL, Temporal, NATS, OpenBao, the Rust core,
  the NestJS API and the Angular console, all in containers with the sources mounted: saving a
  file reloads the console and recompiles/restarts the API.
  Console: http://localhost:4200 - sign in as demo-alice / demo-only-not-a-secret (fictional).
  First start compiles the Rust core inside its container (several minutes), then it is cached.
  Ctrl+C stops the stack. Data (Dolt, PostgreSQL) is kept in Docker volumes between runs.
  -Down stops and removes the containers; -Down -Volumes also deletes the data (re-seeded next time).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#>
param(
  [switch]$Down,
  [switch]$Volumes
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker Desktop is not installed. It is the ONLY prerequisite for this path.'
  $answer = Read-Host 'Install it now with winget? [Y/n]'
  if ($answer -notmatch '^[nN]') {
    winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
    Write-Host 'Docker Desktop installed. Start it (Start menu), wait until the whale icon is steady, then re-run this script.'
  } else {
    Write-Host 'Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, then re-run this script.'
  }
  exit 1
}

# Docker Desktop can be installed but not started yet: wait for the engine (up to 2 minutes).
$ready = $false
foreach ($i in 1..24) {
  docker version --format '{{.Server.Version}}' 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  if ($i -eq 1) { Write-Host 'Waiting for the Docker engine (start Docker Desktop if it is not running)...' }
  Start-Sleep -Seconds 5
}
if (-not $ready) {
  Write-Host 'The Docker engine is not running. Start Docker Desktop, wait for it, then re-run this script.'
  exit 1
}

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host 'Created .env from .env.example (local placeholder passwords, documented, protect nothing).'
}

$compose = @('compose', '--env-file', '.env', '-f', 'infra/docker-compose.yml', '-f', 'infra/docker-compose.dev.yml')
if ($Down) {
  if ($Volumes) { docker @compose down -v } else { docker @compose down }
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host 'Starting the Lyam dev stack (first start: Rust build + npm installs, several minutes).'
Write-Host 'When the log shows the console is ready: http://localhost:4200'
Write-Host 'Sign in: demo-alice / demo-only-not-a-secret (fictional local data).'
Write-Host 'Ctrl+C stops everything. To reset the data later: scripts\dev.ps1 -Down -Volumes'
Write-Host ''
docker @compose up --build
