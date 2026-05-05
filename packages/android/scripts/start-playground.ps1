param(
  [string]$AndroidSdk = "D:\AndroidSDK",
  [int]$Port = 5809,
  [string]$CacheId = "android-playground-cache",
  [switch]$NoOpenBrowser,
  [switch]$NoHelper
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageDir = Resolve-Path (Join-Path $scriptDir "..")
$repoRoot = Resolve-Path (Join-Path $packageDir "..\..")
$platformTools = Join-Path $AndroidSdk "platform-tools"
$adbPath = Join-Path $platformTools "adb.exe"

if (!(Test-Path $adbPath)) {
  throw "adb.exe was not found at $adbPath. Pass -AndroidSdk <path> if your SDK is elsewhere."
}

$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_SDK_ROOT = $AndroidSdk

$pathParts = $env:Path -split ";"
if ($pathParts -notcontains $platformTools) {
  $env:Path = "$platformTools;$env:Path"
}

if (!$env:DEBUG) {
  $env:DEBUG = "midscene:*"
}

$env:ANDROID_PLAYGROUND_PORT = "$Port"
$env:ANDROID_PLAYGROUND_CACHE_ID = $CacheId
$env:ANDROID_PLAYGROUND_OPEN_BROWSER = if ($NoOpenBrowser) { "false" } else { "true" }
$env:ANDROID_PLAYGROUND_HELPER = if ($NoHelper) { "false" } else { "true" }

Set-Location $repoRoot

Write-Host "Android SDK: $env:ANDROID_HOME"
Write-Host "Playground: http://localhost:$Port"
Write-Host "Cache ID: $CacheId"
Write-Host "Helper enabled: $env:ANDROID_PLAYGROUND_HELPER"
Write-Host "Checking connected devices..."
& $adbPath devices

corepack pnpm --dir $packageDir exec tsx demo/playground.ts
