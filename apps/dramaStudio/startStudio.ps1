[CmdletBinding()]
param([switch]$Build, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$bun = Join-Path $repo '.toolchain/bin/bun.exe'
if (-not (Test-Path -LiteralPath $bun)) { $bun = (Get-Command bun.exe).Source }
$bundle = Join-Path $repo 'build/dramaStudio'
$entry = Join-Path $bundle 'server.js'

if ($Build) {
  & $bun build (Join-Path $PSScriptRoot 'server.ts') --target=bun --minify --outdir $bundle
  if ($LASTEXITCODE) { throw 'Studio server build failed.' }
  & $bun build (Join-Path $PSScriptRoot 'studio.ts') --target=browser --minify --outdir $bundle
  if ($LASTEXITCODE) { throw 'Studio browser build failed.' }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'index.html'),(Join-Path $PSScriptRoot 'studio.css') -Destination $bundle
}
if (-not (Test-Path -LiteralPath $entry)) { $entry = Join-Path $PSScriptRoot 'server.ts' }

$url = 'http://127.0.0.1:18770'
$env:TOONFLOW_DRAMA_PORT = '18770'
$logDir = Join-Path $repo 'data/dramaStudio'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Read-Studio {
  try {
    $snapshot = Invoke-RestMethod -Uri "$url/api/state" -TimeoutSec 2
    if ($snapshot.settings -and $null -ne $snapshot.episodes) { return $snapshot }
  } catch {}
}

$studio = Read-Studio
if (-not $studio) {
  if (Get-NetTCPConnection -State Listen -LocalPort 18770 -ErrorAction SilentlyContinue) { throw 'Port 18770 is in use.' }
  $server = Start-Process -FilePath $bun -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'studio.log') -RedirectStandardError (Join-Path $logDir 'studioError.log')
  for ($attempt = 0; $attempt -lt 20 -and -not $studio; $attempt++) {
    if ($server.HasExited) { throw "Studio start failed. See $logDir\studioError.log" }
    Start-Sleep -Milliseconds 300
    $studio = Read-Studio
  }
}
if (-not $studio) { throw 'Studio did not start.' }

$muse = ([uri]$studio.settings.baseUrl)
$museRoot = Join-Path (Split-Path -Parent $repo) 'muse2api'
$python = Join-Path $museRoot '.venv/Scripts/python.exe'
if ($muse.Host -eq '127.0.0.1' -and $muse.Port -eq 18610 -and (Test-Path -LiteralPath $python) -and
    -not (Get-NetTCPConnection -State Listen -LocalPort 18610 -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $python -ArgumentList '-m','uvicorn','app:app','--host','127.0.0.1','--port','18610' -WorkingDirectory $museRoot -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    try { Invoke-WebRequest -Uri 'http://127.0.0.1:18610/openapi.json' -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 400 }
  }
}
if (-not $NoBrowser) { Start-Process "$url/" }
