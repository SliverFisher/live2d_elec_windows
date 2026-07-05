$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$releaseRoot = Join-Path $projectRoot '..\..\release\MaidAI\Live2DRenderer'
$releaseNewRoot = "$releaseRoot.new"
$unpackedRoot = Join-Path $projectRoot 'dist\win-unpacked'
$electronExe = Join-Path $unpackedRoot 'Live2DRenderer.exe'
$targetExe = Join-Path $releaseRoot 'Live2DRenderer.exe'
$hostExe = Join-Path $releaseRoot 'Live2DRendererHost.exe'
$wrapperPublish = Join-Path $projectRoot 'wrapper\bin\Release\net8.0\win-x64\publish'
$wrapperExe = Join-Path $wrapperPublish 'Live2DRenderer.exe'

function Test-Live2DProcesses {
  return Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -match 'Live2DRenderer|Live2DRendererHost|electron'
  }
}

function Wait-ProcessExit {
  param(
    [string]$processName,
    [int]$timeoutSeconds = 10
  )
  $endTime = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    $now = Get-Date
    $remaining = [math]::Ceiling(($endTime - $now).TotalSeconds)
    $processes = Test-Live2DProcesses
    if (-not $processes) {
      Write-Host "$processName processes all exited"
      return $true
    }
    Write-Host "Waiting for $processName processes to exit... ($remaining seconds)"
    Start-Sleep -Seconds 1
  } while ($endTime -gt (Get-Date))
  Write-Host "Timeout waiting for $processName processes to exit"
  return $false
}

Write-Host "=== Step 1: Kill Live2D processes ==="
$processNames = @('Live2DRenderer.exe', 'Live2DRendererHost.exe')
foreach ($name in $processNames) {
  Write-Host "Killing $name..."
  try {
    taskkill /F /T /IM $name 2>&1 | Out-Null
    Write-Host "taskkill /F /T /IM $name completed"
  } catch {
    Write-Host "taskkill $name failed (may not be running): $_"
  }
}

Write-Host "Waiting for processes to exit..."
if (-not (Wait-ProcessExit 'Live2D')) {
  $remaining = Test-Live2DProcesses
  if ($remaining) {
    Write-Host "WARNING: Live2D processes still running:"
    $remaining | Select-Object Id,ProcessName,Path | Format-Table -AutoSize
    Write-Host "Continuing anyway - may encounter file locks"
  }
}

if (-not (Test-Path $unpackedRoot)) {
  throw "Missing electron-builder output: $unpackedRoot"
}

Write-Host "=== Step 2: Clean residual directories ==="
$residualDirs = @(
  (Join-Path $releaseRoot 'win-unpacked'),
  (Join-Path $releaseRoot 'win-unpacked.tmp'),
  (Join-Path $releaseRoot 'resources\resources')
)
$residualFiles = @(
  (Join-Path $releaseRoot 'builder-debug.yml'),
  (Join-Path $releaseRoot 'builder-effective-config.yaml')
)

foreach ($dir in $residualDirs) {
  if (Test-Path -LiteralPath $dir) {
    try {
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
      Write-Host "Removed residual directory: $dir"
    } catch {
      Write-Host "WARNING: Could not remove residual directory $dir : $($_.Exception.Message)"
    }
  }
}

foreach ($file in $residualFiles) {
  if (Test-Path -LiteralPath $file) {
    try {
      Remove-Item -LiteralPath $file -Force -ErrorAction Stop
      Write-Host "Removed residual file: $file"
    } catch {
      Write-Host "WARNING: Could not remove residual file ${file}: $($_.Exception.Message)"
    }
  }
}

Write-Host "=== Step 3: Create new release directory ==="
if (Test-Path -LiteralPath $releaseNewRoot) {
  Write-Host "Removing existing $releaseNewRoot..."
  Remove-Item -LiteralPath $releaseNewRoot -Recurse -Force -ErrorAction Stop
}
New-Item -Path $releaseNewRoot -ItemType Directory -Force | Out-Null
Write-Host "Created $releaseNewRoot"

Write-Host "=== Step 4: Copy win-unpacked to new release directory ==="
$robocopyArgs = @(
  $unpackedRoot,
  $releaseNewRoot,
  '/E',
  '/IS',
  '/IT',
  '/R:5',
  '/W:2',
  '/NFL',
  '/NDL',
  '/NJH'
)
& robocopy @robocopyArgs
$robocopyExit = $LASTEXITCODE
if ($robocopyExit -ge 8) {
  throw "robocopy failed with exit code $robocopyExit"
}
Write-Host "robocopy copy complete (exit code: $robocopyExit)"

Write-Host "=== Step 5: Verify app.asar ==="
$sourceAsar = Join-Path $unpackedRoot 'resources\app.asar'
$destAsar = Join-Path $releaseNewRoot 'resources\app.asar'
if (-not (Test-Path $sourceAsar)) {
  throw "Source app.asar missing: $sourceAsar"
}
if (-not (Test-Path $destAsar)) {
  throw "Destination app.asar missing after robocopy: $destAsar"
}
$sourceSize = (Get-Item $sourceAsar).Length
$destSize = (Get-Item $destAsar).Length
Write-Host "Source app.asar: $sourceSize bytes"
Write-Host "Destination app.asar: $destSize bytes"
if ($sourceSize -ne $destSize) {
  throw "app.asar size mismatch! Source=$sourceSize, Dest=$destSize"
}
Write-Host "app.asar verification PASSED"

Write-Host "=== Step 6: Build .NET wrapper ==="
dotnet publish (Join-Path $projectRoot 'wrapper\Live2DRenderer.Wrapper.csproj') `
  -c Release `
  -r win-x64 `
  --self-contained true `
  /p:PublishSingleFile=true `
  /p:PublishTrimmed=true `
  /p:EnableCompressionInSingleFile=true `
  /p:DebugType=None `
  /p:DebugSymbols=false

if (-not (Test-Path $wrapperExe)) {
  throw ".NET wrapper build failed, missing: $wrapperExe"
}
Write-Host ".NET wrapper build complete: $wrapperExe"

Write-Host "=== Step 7: Prepare new release directory ==="
$newElectronExe = Join-Path $releaseNewRoot 'Live2DRenderer.exe'
$newHostExe = Join-Path $releaseNewRoot 'Live2DRendererHost.exe'
$newTargetExe = Join-Path $releaseNewRoot 'Live2DRenderer.exe'

Copy-Item -LiteralPath $newElectronExe -Destination $newHostExe -Force
Write-Host "Copied Electron exe to Live2DRendererHost.exe"

Copy-Item -LiteralPath $wrapperExe -Destination $newTargetExe -Force
Write-Host "Copied .NET wrapper to Live2DRenderer.exe"

Write-Host "=== Step 8: Swap release directories ==="
$releaseOldRoot = "$releaseRoot.old"
if (Test-Path -LiteralPath $releaseOldRoot) {
  Remove-Item -LiteralPath $releaseOldRoot -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Removed old backup: $releaseOldRoot"
}

$renameSuccess = $false
if (Test-Path -LiteralPath $releaseRoot) {
  try {
    Write-Host "Renaming $releaseRoot to $releaseOldRoot..."
    Rename-Item -LiteralPath $releaseRoot -NewName (Split-Path $releaseOldRoot -Leaf) -Force
    $renameSuccess = $true
  } catch {
    Write-Host "Rename failed (locked), falling back to overwrite mode: $($_.Exception.Message)"
  }
}

try {
  Write-Host "Renaming $releaseNewRoot to $releaseRoot..."
  Rename-Item -LiteralPath $releaseNewRoot -NewName (Split-Path $releaseRoot -Leaf) -Force
} catch {
  Write-Host "Rename new failed, attempting copy-overwrite: $($_.Exception.Message)"
  $robocopyArgs = @(
    $releaseNewRoot,
    $releaseRoot,
    '/E',
    '/IS',
    '/IT',
    '/R:5',
    '/W:2',
    '/NFL',
    '/NDL',
    '/NJH'
  )
  & robocopy @robocopyArgs
  $robocopyExit = $LASTEXITCODE
  if ($robocopyExit -ge 8) {
    throw "robocopy overwrite failed with exit code $robocopyExit"
  }
  Write-Host "robocopy overwrite complete (exit code: $robocopyExit)"
  Remove-Item -LiteralPath $releaseNewRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $releaseOldRoot) {
  Write-Host "Cleaning up old backup..."
  Remove-Item -LiteralPath $releaseOldRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Release complete ==="
Write-Host "Release directory: $releaseRoot"
Write-Host "app.asar: $destSize bytes"
Write-Host "Live2DRenderer.exe (.NET wrapper): $((Get-Item $targetExe).Length) bytes"
Write-Host "Live2DRendererHost.exe (Electron): $((Get-Item $hostExe).Length) bytes"