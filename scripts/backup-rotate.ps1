param(
  [string]$ProjectRoot = '',
  [string]$BackupRoot = '',
  [string]$ProjectName = 'MailUnion',
  [int]$Retention = 6
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $ProjectRoot)) {
  throw "Project root does not exist: $ProjectRoot"
}

if (-not $BackupRoot) {
  $BackupRoot = Join-Path (Split-Path -Parent $ProjectRoot) 'backup'
}

$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
if (-not $BackupRoot.EndsWith('\backup')) {
  throw "Refusing to rotate backups outside the configured backup directory: $BackupRoot"
}

if ($Retention -lt 1 -or $Retention -gt 20) {
  throw 'Retention must be between 1 and 20.'
}

New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
$resolvedBackupRoot = (Resolve-Path -LiteralPath $BackupRoot).Path

function Assert-InBackupRoot {
  param([string]$PathToCheck)

  $fullPath = [System.IO.Path]::GetFullPath($PathToCheck)
  $rootWithSeparator = $resolvedBackupRoot.TrimEnd('\') + '\'
  if ($fullPath -ne $resolvedBackupRoot -and -not $fullPath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside backup root: $fullPath"
  }
}

function Test-IsManagedBackupSlot {
  param([string]$Name)

  $match = [regex]::Match($Name, "^$([regex]::Escape($ProjectName))(\d+)$")
  if (-not $match.Success) {
    return $false
  }

  $slotNumber = [int]$match.Groups[1].Value
  return $slotNumber -ge 1 -and $slotNumber -le $Retention
}

Get-ChildItem -LiteralPath $resolvedBackupRoot -Force -Directory |
  Where-Object { -not (Test-IsManagedBackupSlot $_.Name) } |
  ForEach-Object {
    Assert-InBackupRoot $_.FullName
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }

for ($i = $Retention; $i -ge 1; $i--) {
  $currentSlot = Join-Path $resolvedBackupRoot "$ProjectName$i"
  Assert-InBackupRoot $currentSlot

  if ($i -eq $Retention) {
    if (Test-Path -LiteralPath $currentSlot) {
      Remove-Item -LiteralPath $currentSlot -Recurse -Force
    }
    continue
  }

  $nextSlot = Join-Path $resolvedBackupRoot "$ProjectName$($i + 1)"
  Assert-InBackupRoot $nextSlot
  if (Test-Path -LiteralPath $currentSlot) {
    if (Test-Path -LiteralPath $nextSlot) {
      Remove-Item -LiteralPath $nextSlot -Recurse -Force
    }
    Move-Item -LiteralPath $currentSlot -Destination $nextSlot
  }
}

$destination = Join-Path $resolvedBackupRoot "$ProjectName`1"
Assert-InBackupRoot $destination
New-Item -ItemType Directory -Path $destination -Force | Out-Null

$excludedRootItems = @(
  '.git',
  'node_modules',
  '.codex-logs',
  '.source-backups',
  '.runtime',
  '.tmp-edge-profile',
  'logs'
)
$excludedFiles = @(
  '*.log',
  'server.pid',
  'server.stdout.log',
  'server.stderr.log',
  'codex-server.stdout.log',
  'codex-server.stderr.log'
)

Get-ChildItem -LiteralPath $ProjectRoot -Force | ForEach-Object {
  if ($excludedRootItems -contains $_.Name) {
    return
  }

  if ($_.PSIsContainer -and $_.Name -eq 'runtime') {
    $runtimeFiles = Join-Path $_.FullName 'files'
    if (Test-Path -LiteralPath $runtimeFiles) {
      New-Item -ItemType Directory -Path (Join-Path $destination 'runtime') -Force | Out-Null
      Copy-Item -LiteralPath $runtimeFiles -Destination (Join-Path $destination 'runtime\files') -Recurse -Force
    }
    return
  }

  if ($_.PSIsContainer -and $_.Name -eq 'data') {
    $dataDestination = Join-Path $destination 'data'
    New-Item -ItemType Directory -Path $dataDestination -Force | Out-Null
    Get-ChildItem -LiteralPath $_.FullName -Force -File |
      Where-Object {
        $_.Name -eq '.gitkeep' -or
        $_.Name -like '*.sqlite' -or
        $_.Name -like '*.sqlite-wal' -or
        $_.Name -like '*.sqlite-shm'
      } |
      ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dataDestination $_.Name) -Force
      }
    return
  }

  foreach ($pattern in $excludedFiles) {
    if (-not $_.PSIsContainer -and $_.Name -like $pattern) {
      return
    }
  }

  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destination $_.Name) -Recurse -Force
}

Set-Content -LiteralPath (Join-Path $destination 'backup-manifest.txt') -Encoding UTF8 -Value @(
  "created_at=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "source=$ProjectRoot",
  "backup_root=$resolvedBackupRoot",
  "slot=$ProjectName`1",
  "retention=$Retention",
  "rule=newest-is-$ProjectName`1"
)

Write-Output $destination
