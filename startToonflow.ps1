$ErrorActionPreference = "Stop"
$bunDir = Join-Path $PSScriptRoot "data/runtime/package/bin"
$bun = Join-Path $bunDir "bun.exe"
$entry = Join-Path $PSScriptRoot "build/server/index.js"
$page = "http://127.0.0.1:3016/#/studio"
$api = "http://127.0.0.1:3016/api/ai/media/models"

function Test-ToonflowReady {
  $status = & curl.exe --noproxy "*" --max-time 2 --silent --fail --output NUL --write-out "%{http_code}" --header "x-toonflow-workspace: 1" --referer "http://127.0.0.1:3016/" $api
  return $status -eq "200"
}

if (-not (Test-ToonflowReady)) {
  foreach ($requiredFile in @($bun, $entry, (Join-Path $PSScriptRoot "build/web/index.html"))) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      throw "Required runtime or build file is missing: $requiredFile"
    }
  }
  $env:Path = "$bunDir;$env:Path"
  $env:NODE_ENV = "production"
  $env:TOONFLOW_SERVER_PORT = "3016"
  $env:TOONFLOW_SERVER_HOST = "127.0.0.1"
  $env:TOONFLOW_DATA_DIR = Join-Path $PSScriptRoot "data/studioLocal"
  $process = Start-Process -FilePath $bun -ArgumentList "build/server/index.js" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $PSScriptRoot "data/studioLocal.log") `
    -RedirectStandardError (Join-Path $PSScriptRoot "data/studioLocalError.log")
  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Test-ToonflowReady)) {
    if ($process.HasExited -or (Get-Date) -ge $deadline) {
      throw "Kairos could not start. See data/studioLocalError.log."
    }
    Start-Sleep -Milliseconds 400
  }
}
Start-Process $page
