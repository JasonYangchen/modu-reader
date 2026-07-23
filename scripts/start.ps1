$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = 4173
$url = "http://127.0.0.1:$port/"

if (Get-Command node -ErrorAction SilentlyContinue) {
  $runtime = (Get-Command node).Source
  $arguments = @("scripts/serve.cjs")
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $runtime = (Get-Command py).Source
  $arguments = @("-3", "-m", "http.server", "$port", "--bind", "127.0.0.1")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $runtime = (Get-Command python).Source
  $arguments = @("-m", "http.server", "$port", "--bind", "127.0.0.1")
} else {
  throw "Node.js or Python is required to start the local server."
}

Write-Host "Modu Reader: $url" -ForegroundColor Green
Write-Host "Close this window to stop the reader." -ForegroundColor DarkGray
$server = Start-Process -FilePath $runtime -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Milliseconds 700
  Start-Process $url
  Wait-Process -Id $server.Id
} finally {
  if (-not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
}
