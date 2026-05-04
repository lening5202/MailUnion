param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [int]$Port = 52080
)

$ErrorActionPreference = 'Stop'

function Test-LocalPortOpen {
  param([int]$TargetPort)

  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $async = $client.BeginConnect('127.0.0.1', $TargetPort, $null, $null)
    $connected = $async.AsyncWaitHandle.WaitOne(350, $false)
    if ($connected) {
      $client.EndConnect($async)
    }
    $client.Close()
    return $connected
  } catch {
    return $false
  }
}

if (Test-LocalPortOpen -TargetPort $Port) {
  Write-Host "Mail Union already listens on port $Port."
  exit 0
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw 'Node.js was not found in PATH. Please run scripts/install-windows.ps1 first.'
}

$resolvedAppDir = (Resolve-Path $AppDir).Path
$logsDir = Join-Path $resolvedAppDir 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

$stdoutLog = Join-Path $logsDir "server-$Port.out.log"
$stderrLog = Join-Path $logsDir "server-$Port.err.log"

Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList @('src/server.js') `
  -WorkingDirectory $resolvedAppDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog

Write-Host "Mail Union is starting at http://127.0.0.1:$Port"
