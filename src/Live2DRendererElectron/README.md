# Live2DRenderer Electron

Standalone Electron renderer for WPF `Process.Start` hosting.

## Install

```powershell
npm install
```

## Official Cubism Core

Download **Live2D Cubism SDK for Web** from the official Live2D site and copy the Core runtime file to:

```text
src/Live2DRendererElectron/vendor/CubismSdkForWeb/Core/live2dcubismcore.min.js
```

The renderer keeps stdout reserved for JSON Lines events. Logs are written to:

```text
release/MaidAI/logs/live2d-renderer.log
```

## Run

```powershell
npm run dev
```

Example command through stdin:

```json
{"type":"LoadModel","modelPath":"C:/MaidAI/Assets/Live2D/Hiyori/Hiyori.model3.json"}
```

## Package

```powershell
npm run package
```

Output:

```text
release/MaidAI/Live2DRenderer/Live2DRenderer.exe
```

`npm run package` creates an unpacked Electron release because WPF needs stable stdin/stdout pipes. The root `Live2DRenderer.exe` is a small UTF-8 stdio wrapper that launches the internal Electron host `Live2DRendererHost.exe` and bridges JSON Lines through local named pipes. WPF should start only the root `Live2DRenderer.exe`.

If GitHub downloads are slow, use these mirrors before packaging:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run package
```

Optional single-file portable build:

```powershell
npm run package:portable
```

The portable build is not recommended for WPF stdio hosting because it may not preserve stdout redirection reliably.
