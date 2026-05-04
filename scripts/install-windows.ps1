[CmdletBinding()]
param(
  [string]$Repo = 'lening5202/MailUnion',
  [string]$Branch = 'main',
  [string]$InstallDir = '',
  [int]$Port = 52080,
  [switch]$NoAutostart,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NodeMajor {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    return 0
  }

  $version = (& $nodeCommand.Source -v 2>$null)
  if ($version -match '^v?(\d+)') {
    return [int]$Matches[1]
  }

  return 0
}

function Update-CurrentPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machinePath, $userPath, $env:Path) -join ';'
}

function Install-WingetPackage {
  param(
    [string]$Id,
    [string]$Name
  )

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Cannot install $Name automatically because winget is not available. Install Node.js 22+ manually and rerun this script."
  }

  Write-Host "Installing $Name with winget..."
  & $winget.Source install --id $Id -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget failed to install $Name."
  }
}

function New-AppSecret {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Set-EnvValue {
  param(
    [string]$Path,
    [string]$Name,
    [string]$Value
  )

  $content = if (Test-Path $Path) { Get-Content -LiteralPath $Path -Raw } else { '' }
  $escapedName = [regex]::Escape($Name)
  if ($content -match "(?m)^$escapedName=") {
    $content = [regex]::Replace($content, "(?m)^$escapedName=.*$", "$Name=$Value")
  } else {
    if ($content -and -not $content.EndsWith("`n")) {
      $content += "`r`n"
    }
    $content += "$Name=$Value`r`n"
  }

  Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

function Wait-Health {
  param([int]$TargetPort)

  for ($i = 0; $i -lt 30; $i += 1) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetPort/api/health" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        return $true
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  return $false
}

$isAdmin = Test-IsAdmin
if (-not $InstallDir) {
  $InstallDir = if ($isAdmin) {
    Join-Path $env:ProgramData 'MailUnion'
  } else {
    Join-Path $env:LOCALAPPDATA 'MailUnion'
  }
}

Write-Host "Mail Union one-click installer"
Write-Host "Repository : $Repo ($Branch)"
Write-Host "Install dir: $InstallDir"
Write-Host "Port       : $Port"

if ((Get-NodeMajor) -lt 22) {
  Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Name 'Node.js LTS'
  Update-CurrentPath
}

if ((Get-NodeMajor) -lt 22) {
  throw 'Node.js 22 or newer is required. Please install Node.js 22+ and rerun this script.'
}

$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  throw 'npm was not found after Node.js installation.'
}

$tempRoot = Join-Path $env:TEMP "mailunion-install-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
  $zipPath = Join-Path $tempRoot 'source.zip'
  $downloadUrl = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
  Write-Host "Downloading $downloadUrl"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing

  Expand-Archive -Path $zipPath -DestinationPath $tempRoot -Force
  $sourceDir = Get-ChildItem -LiteralPath $tempRoot -Directory | Where-Object { $_.Name -ne '__MACOSX' } | Select-Object -First 1
  if (-not $sourceDir) {
    throw 'Downloaded archive does not contain project files.'
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $excludedNames = @('.git', 'node_modules', '.env', 'runtime', '.runtime', 'logs', '.codex-logs', '.source-backups', '.tmp-edge-profile')
  Get-ChildItem -LiteralPath $sourceDir.FullName -Force | ForEach-Object {
    if ($excludedNames -contains $_.Name) {
      return
    }

    $destination = Join-Path $InstallDir $_.Name
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
  }

  foreach ($dir in @('data', 'runtime', 'runtime/files', 'logs')) {
    New-Item -ItemType Directory -Path (Join-Path $InstallDir $dir) -Force | Out-Null
  }

  $envPath = Join-Path $InstallDir '.env'
  if (-not (Test-Path $envPath)) {
    Copy-Item -LiteralPath (Join-Path $InstallDir '.env.example') -Destination $envPath -Force
  }

  Set-EnvValue -Path $envPath -Name 'PORT' -Value ([string]$Port)
  $envContent = Get-Content -LiteralPath $envPath -Raw
  if ($envContent -match '(?m)^APP_SECRET=(change-this-before-production)?\s*$') {
    Set-EnvValue -Path $envPath -Name 'APP_SECRET' -Value (New-AppSecret)
  }

  Push-Location $InstallDir
  try {
    Write-Host 'Installing npm dependencies...'
    & $npmCommand.Source ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
      & $npmCommand.Source install --omit=dev
      if ($LASTEXITCODE -ne 0) {
        throw 'npm dependency installation failed.'
      }
    }
  } finally {
    Pop-Location
  }

  if (-not $NoAutostart) {
    $taskName = 'MailUnion'
    $startScript = Join-Path $InstallDir 'scripts\start-windows.ps1'
    $powershell = (Get-Command powershell.exe).Source
    $argument = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -AppDir `"$InstallDir`" -Port $Port"
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $argument
    $trigger = if ($isAdmin) { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn }

    if ($isAdmin) {
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description 'Start Mail Union automatically.' -Force | Out-Null
    } else {
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'Start Mail Union automatically.' -Force | Out-Null
    }

    Write-Host "Autostart task configured: $taskName"
  }

  if ($isAdmin -and (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue)) {
    $ruleName = "MailUnion TCP $Port"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
      Write-Host "Windows Firewall rule added for TCP $Port."
    }
  }

  if (-not $NoStart) {
    & (Join-Path $InstallDir 'scripts\start-windows.ps1') -AppDir $InstallDir -Port $Port
    if (Wait-Health -TargetPort $Port) {
      Write-Host "Mail Union is running: http://127.0.0.1:$Port"
    } else {
      Write-Warning "Mail Union was started, but health check did not respond yet. Check logs in $InstallDir\logs."
    }
  }

  Write-Host ''
  Write-Host 'Default administrator: admin / admin'
  Write-Host "Open: http://127.0.0.1:$Port"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
