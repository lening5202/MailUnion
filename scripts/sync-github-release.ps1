param(
  [string]$ProjectRoot = '',
  [string]$GithubRoot = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $ProjectRoot)) {
  throw "Project root does not exist: $ProjectRoot"
}

if (-not $GithubRoot) {
  $GithubRoot = Join-Path (Split-Path -Parent $ProjectRoot) 'github\MailUnion'
}

$GithubRoot = [System.IO.Path]::GetFullPath($GithubRoot)
if (-not $GithubRoot.EndsWith('\github\MailUnion')) {
  throw "Refusing to sync to unexpected GitHub release path: $GithubRoot"
}

New-Item -ItemType Directory -Path $GithubRoot -Force | Out-Null
$resolvedGithubRoot = (Resolve-Path -LiteralPath $GithubRoot).Path

function Assert-InGithubRoot {
  param([string]$PathToCheck)

  $fullPath = [System.IO.Path]::GetFullPath($PathToCheck)
  $rootWithSeparator = $resolvedGithubRoot.TrimEnd('\') + '\'
  if ($fullPath -ne $resolvedGithubRoot -and -not $fullPath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside GitHub root: $fullPath"
  }
}

Get-ChildItem -LiteralPath $resolvedGithubRoot -Force | ForEach-Object {
  if ($_.Name -eq '.git') {
    return
  }
  Assert-InGithubRoot $_.FullName
  Remove-Item -LiteralPath $_.FullName -Recurse -Force
}

$excludedRootItems = @(
  '.git',
  '.env',
  'data',
  'runtime',
  '.runtime',
  'logs',
  'node_modules',
  'docs-local',
  '.codex-logs',
  '.source-backups',
  '.tmp-edge-profile'
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

  foreach ($pattern in $excludedFiles) {
    if (-not $_.PSIsContainer -and $_.Name -like $pattern) {
      return
    }
  }

  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $resolvedGithubRoot $_.Name) -Recurse -Force
}

$dataRoot = Join-Path $resolvedGithubRoot 'data'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
[System.IO.File]::WriteAllBytes((Join-Path $dataRoot '.gitkeep'), [byte[]]@())

Write-Output $resolvedGithubRoot
