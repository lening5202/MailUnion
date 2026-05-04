param(
  [string]$Label = ''
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path $projectRoot '.source-backups'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$safeLabel = [regex]::Replace($Label, '[^a-zA-Z0-9._-]+', '-').Trim('-')
$snapshotName = if ($safeLabel) { "source-$timestamp-$safeLabel" } else { "source-$timestamp" }
$snapshotRoot = Join-Path $backupRoot $snapshotName

$itemsToCopy = @(
  'src',
  'public',
  'scripts',
  'package.json',
  'package-lock.json',
  'README.md',
  '.env',
  '.env.example',
  '.gitignore'
)

New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null

foreach ($item in $itemsToCopy) {
  $sourcePath = Join-Path $projectRoot $item
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    continue
  }

  $destinationPath = Join-Path $snapshotRoot $item
  $destinationParent = Split-Path -Parent $destinationPath
  if ($destinationParent) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }

  $sourceItem = Get-Item -LiteralPath $sourcePath
  if ($sourceItem.PSIsContainer) {
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
  } else {
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
  }
}

$manifestLines = @(
  "created_at=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "project_root=$projectRoot",
  "snapshot_root=$snapshotRoot",
  'items='
) + ($itemsToCopy | ForEach-Object { "- $_" })

Set-Content -LiteralPath (Join-Path $snapshotRoot 'manifest.txt') -Value $manifestLines -Encoding UTF8

Write-Output $snapshotRoot
