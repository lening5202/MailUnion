param(
  [string]$Label = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path (Split-Path -Parent $projectRoot) 'backup'

& (Join-Path $PSScriptRoot 'backup-rotate.ps1') `
  -ProjectRoot $projectRoot `
  -BackupRoot $backupRoot `
  -ProjectName 'MailUnion' `
  -Retention 6
