$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$releaseRoot = Resolve-Path (Join-Path $projectRoot '..\..\release\MaidAI\Live2DRenderer')
$unpackedRoot = Join-Path $releaseRoot 'win-unpacked'
$targetExe = Join-Path $releaseRoot 'Live2DRenderer.exe'
$hostExe = Join-Path $releaseRoot 'Live2DRendererHost.exe'
$wrapperPublish = Join-Path $projectRoot 'wrapper\bin\Release\net8.0\win-x64\publish'
$wrapperExe = Join-Path $wrapperPublish 'Live2DRenderer.exe'

if (-not (Test-Path $unpackedRoot)) {
  throw "Missing electron-builder output: $unpackedRoot"
}

if (Test-Path $targetExe) {
  Remove-Item -LiteralPath $targetExe -Force
}

Get-ChildItem -LiteralPath $unpackedRoot -Force | ForEach-Object {
  $targetPath = Join-Path $releaseRoot $_.Name
  if (Test-Path $targetPath) {
    Remove-Item -LiteralPath $targetPath -Recurse -Force
  }
  Copy-Item -LiteralPath $_.FullName -Destination $targetPath -Recurse -Force
}

if (Test-Path $hostExe) {
  Remove-Item -LiteralPath $hostExe -Force
}

Move-Item -LiteralPath $targetExe -Destination $hostExe -Force

dotnet publish (Join-Path $projectRoot 'wrapper\Live2DRenderer.Wrapper.csproj') `
  -c Release `
  -r win-x64 `
  --self-contained true `
  /p:PublishSingleFile=true `
  /p:PublishTrimmed=true `
  /p:EnableCompressionInSingleFile=true `
  /p:DebugType=None `
  /p:DebugSymbols=false

Copy-Item -LiteralPath $wrapperExe -Destination $targetExe -Force

Write-Host "Flattened release to $releaseRoot"
