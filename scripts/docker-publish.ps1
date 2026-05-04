param(
  [string]$Image = $env:MAILUNION_IMAGE,
  [string]$Platforms = $env:MAILUNION_PLATFORMS,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'

if (-not $Image) {
  $Image = 'ghcr.io/lening5202/mailunion:latest'
}

if (-not $Platforms) {
  $Platforms = 'linux/amd64,linux/arm64'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not installed or not in PATH.'
}

if ($NoPush) {
  docker build -t $Image .
} else {
  docker buildx build --platform $Platforms -t $Image --push .
}

Write-Host "Docker image ready: $Image"
