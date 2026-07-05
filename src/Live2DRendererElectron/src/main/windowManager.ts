import { BrowserWindow, app, ipcMain, protocol, screen } from 'electron';
import { extname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendEvent } from './protocol';
import { log } from './logger';
import { parseStartupArgs } from './args';
import type { AiMaidCommand, RendererCommand, RendererEvent } from './protocolTypes';

let mainWindow: BrowserWindow | null = null;
let parentPid: number | null = null;
let pendingLoadModelRequestId: string | null = null;
let pendingLoadModelPath: string | null = null;

// Renderer readiness tracking — prevents LoadModel from being lost when it
// arrives before the renderer process has finished loading.
type LoadModelRendererCommand = Extract<RendererCommand, { type: 'LoadModel' }>;
let rendererReady = false;
let pendingLoadModelCommand: { command: LoadModelRendererCommand; requestId: string | null } | null = null;
let loadModelTimeoutTimer: NodeJS.Timeout | null = null;
const LOAD_MODEL_TIMEOUT_MS = 10000;

let petDragState: {
  startCursorX: number;
  startCursorY: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
} | null = null;

export function createRendererWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 900,
    minWidth: 160,
    minHeight: 160,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setResizable(false);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.center();
    mainWindow?.showInactive();
    log('Window created successfully');
  });

  mainWindow.on('will-resize', (event, newBounds) => {
    if (petDragState) {
      newBounds.width = petDragState.width;
      newBounds.height = petDragState.height;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    log('Window closed');
  });

  mainWindow.webContents.on('console-message', (event) => {
    log('Renderer console', event);
  });

  // Mark renderer as ready — any LoadModel that arrived before this point
  // was cached in pendingLoadModelCommand and is now flushed.
  mainWindow.webContents.on('did-finish-load', () => {
    if (rendererReady) {
      return;
    }
    rendererReady = true;
    log('Renderer did-finish-load, rendererReady=true');

    if (pendingLoadModelCommand) {
      const { command, requestId } = pendingLoadModelCommand;
      pendingLoadModelCommand = null;
      log('Flushing pending LoadModel to renderer', { modelPath: command.modelPath, requestId });
      sendCommandToRenderer(command);
      startLoadModelTimeout(requestId, command.modelPath);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('Renderer process gone', details);
    sendEvent(
      { type: 'Error', code: 'RenderProcessGone', message: `Renderer process gone: ${details.reason}` },
      null
    );
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log('Renderer load failed', { errorCode, errorDescription, validatedURL });
    sendEvent(
      { type: 'Error', code: 'LoadFailed', message: `Renderer load failed: ${errorDescription}` },
      null
    );
  });

  return mainWindow;
}

export function registerWindowIpc(): void {
  registerLocalFileProtocol();

  ipcMain.handle('renderer-event', (_event, payload: RendererEvent) => {
    handleRendererEvent(payload);
  });

  ipcMain.handle('pet:drag-start', () => {
    if (!mainWindow) {
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    petDragState = {
      startCursorX: cursor.x,
      startCursorY: cursor.y,
      startX: bounds.x,
      startY: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  });

  ipcMain.handle('pet:drag-move', () => {
    if (!mainWindow || !petDragState) {
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - petDragState.startCursorX;
    const dy = cursor.y - petDragState.startCursorY;
    const nextX = Math.round(petDragState.startX + dx);
    const nextY = Math.round(petDragState.startY + dy);
    mainWindow.setBounds({
      x: nextX,
      y: nextY,
      width: petDragState.width,
      height: petDragState.height
    }, false);
  });

  ipcMain.handle('pet:drag-end', () => {
    if (!mainWindow) {
      petDragState = null;
      return;
    }
    const bounds = mainWindow.getBounds();
    petDragState = null;
    // TransformChanged (drag end) is emitted by the renderer after this returns
    log('Drag ended', { x: bounds.x, y: bounds.y });
  });

  ipcMain.handle('pet:resize-to-fit', (_event, payload: { width: number; height: number }) => {
    if (!mainWindow) {
      return;
    }
    const oldBounds = mainWindow.getBounds();
    const centerX = oldBounds.x + oldBounds.width / 2;
    const centerY = oldBounds.y + oldBounds.height / 2;
    const targetWidth = Math.max(160, Math.round(payload.width));
    const targetHeight = Math.max(160, Math.round(payload.height));
    mainWindow.setBounds({
      x: Math.round(centerX - targetWidth / 2),
      y: Math.round(centerY - targetHeight / 2),
      width: targetWidth,
      height: targetHeight
    }, false);
  });

  ipcMain.handle('set-ignore-mouse-events', (_event, payload: { ignore: boolean; options?: { forward?: boolean } }) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.setIgnoreMouseEvents(payload.ignore, payload.options);
  });

  ipcMain.handle('resolve-model-url', (_event, modelPath: string) => {
    return toLive2DFileUrl(resolve(modelPath));
  });

  ipcMain.handle('get-cubism-core-url', () => {
    // In dev mode (ELECTRON_RENDERER_URL set), use project root.
    // When packaged, use process.resourcesPath.
    // When launched directly (electron .) without ELECTRON_RENDERER_URL,
    // process.resourcesPath points to Electron's internal dir, so check and
    // fall back to app.getAppPath().
    const candidatePaths = [
      resolve(process.resourcesPath, 'vendor', 'CubismSdkForWeb', 'Core', 'live2dcubismcore.min.js'),
      resolve(app.getAppPath(), 'vendor', 'CubismSdkForWeb', 'Core', 'live2dcubismcore.min.js')
    ];
    const found = candidatePaths.find(existsSync) ?? candidatePaths[1];
    return toLive2DFileUrl(found);
  });

  ipcMain.handle('get-display', () => {
    return screen.getPrimaryDisplay().scaleFactor;
  });

  ipcMain.handle('get-startup-args', () => {
    // Returns minimal info the renderer needs to decide dev model loading
    const args = parseStartupArgs();
    return {
      isAiMaidMode: args.pipeName !== null,
      model: args.model,
      noDefaultModel: args.noDefaultModel
    };
  });
}

function registerLocalFileProtocol(): void {
  if (protocol.isProtocolHandled('live2d-file')) {
    return;
  }

  protocol.handle('live2d-file', async (request) => {
    const url = new URL(request.url);
    const filePath = fileURLToPath(`file://${url.pathname}`);
    log('Serving local Live2D file', filePath);
    const data = await readFile(filePath);
    return new Response(data, {
      headers: {
        'content-type': getContentType(filePath),
        'access-control-allow-origin': '*'
      }
    });
  });
}

function toLive2DFileUrl(filePath: string): string {
  const fileUrl = pathToFileURL(filePath);
  return `live2d-file://local${fileUrl.pathname}`;
}

function getContentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.moc3':
      return 'application/octet-stream';
    case '.motion3':
    case '.exp3':
    case '.physics3':
    case '.pose3':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

// ============================================================
// Renderer event handling (renderer → main → AI_maid)
// ============================================================

function handleRendererEvent(event: RendererEvent): void {
  log('Renderer event', event);

  switch (event.type) {
    case 'ModelLoaded':
      clearLoadModelTimeout();
      sendEvent(
        {
          type: 'ModelLoaded',
          roleId: event.roleId,
          modelPath: event.modelPath
        },
        pendingLoadModelRequestId
      );
      pendingLoadModelRequestId = null;
      pendingLoadModelPath = null;
      break;
    case 'ModelLoadFailed':
      clearLoadModelTimeout();
      sendEvent(
        {
          type: 'ModelLoadFailed',
          modelPath: event.modelPath,
          message: event.message
        },
        pendingLoadModelRequestId
      );
      pendingLoadModelRequestId = null;
      pendingLoadModelPath = null;
      break;
    case 'TransformChanged': {
      // Renderer only knows scale + reason; fill in x/y from window bounds
      const bounds = mainWindow?.getBounds();
      sendEvent(
        {
          type: 'TransformChanged',
          x: bounds?.x ?? 0,
          y: bounds?.y ?? 0,
          scale: event.scale,
          reason: event.reason
        },
        null
      );
      break;
    }
    case 'PointerEvent':
    case 'RightClick':
    case 'Error':
      sendEvent(event, null);
      break;
    default:
      log('Unknown renderer event type', (event as { type: string }).type);
      break;
  }
}

// ============================================================
// AI_maid command handling (AI_maid → main → renderer)
// ============================================================

export function handleAiMaidCommand(command: AiMaidCommand, requestId: string | null): void {
  log('Handling AI_maid command', { type: command.type, requestId });

  switch (command.type) {
    case 'Init':
      handleInit(command, requestId);
      break;
    case 'LoadModel':
      handleLoadModel(command, requestId);
      break;
    case 'Show':
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.showInactive();
      }
      break;
    case 'Hide':
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
      break;
    case 'Close':
      log('Close command received', { reason: command.reason });
      sendEvent({ type: 'Closed', reason: command.reason ?? 'AI_maidClose' }, null);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      }
      app.quit();
      break;
    case 'SetTransform':
      handleSetTransform(command, requestId);
      break;
    case 'SetClickThrough':
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setIgnoreMouseEvents(command.enabled, command.enabled ? { forward: true } : undefined);
      }
      break;
    case 'PlayMotion':
    case 'SetExpression':
    case 'SetActionTag':
    case 'SpeakStart':
    case 'SpeakStop':
      forwardToRenderer(command);
      break;
    default:
      log('Unknown AI_maid command type', (command as { type: string }).type);
      break;
  }
}

function handleInit(command: { protocolVersion: number; appName: string; parentPid?: number }, requestId: string | null): void {
  const PROTOCOL_VERSION = 1;
  if (command.protocolVersion !== PROTOCOL_VERSION) {
    log('Protocol version mismatch', { expected: PROTOCOL_VERSION, got: command.protocolVersion });
    sendEvent(
      {
        type: 'Error',
        code: 'ProtocolVersionMismatch',
        message: `Expected protocol version ${PROTOCOL_VERSION}, got ${command.protocolVersion}`
      },
      requestId
    );
    sendEvent({ type: 'InitAck', ok: false }, requestId);
    return;
  }

  if (typeof command.parentPid === 'number' && command.parentPid > 0) {
    parentPid = command.parentPid;
    log('Init: parentPid saved', { parentPid });
  }

  log('Init successful', { appName: command.appName, parentPid: command.parentPid });
  sendEvent({ type: 'InitAck', ok: true }, requestId);
}

function handleLoadModel(
  command: { roleId?: string; roleName?: string; modelPath: string; initialTransform?: { x?: number; y?: number; scale?: number } },
  requestId: string | null
): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    sendEvent(
      {
        type: 'ModelLoadFailed',
        modelPath: command.modelPath,
        message: 'Renderer window is not available.'
      },
      requestId
    );
    return;
  }

  // Track the requestId so we can attach it to ModelLoaded/ModelLoadFailed
  pendingLoadModelRequestId = requestId;
  pendingLoadModelPath = command.modelPath;

  // Apply initial window position if provided
  if (command.initialTransform && typeof command.initialTransform.x === 'number' && typeof command.initialTransform.y === 'number') {
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({
      x: Math.round(command.initialTransform.x),
      y: Math.round(command.initialTransform.y),
      width: bounds.width,
      height: bounds.height
    }, false);
  }

  const rendererCommand: LoadModelRendererCommand = {
    type: 'LoadModel',
    roleId: command.roleId,
    modelPath: command.modelPath,
    initialTransform: command.initialTransform
  };

  // If renderer is not ready yet, cache the command and wait for did-finish-load.
  // This is the critical fix for "LoadModel lost" when AI_maid sends it
  // immediately after Init, before the renderer process has booted.
  if (!rendererReady) {
    log('Renderer not ready yet, caching LoadModel', { modelPath: command.modelPath, requestId });
    pendingLoadModelCommand = { command: rendererCommand, requestId };
    return;
  }

  sendCommandToRenderer(rendererCommand);
  startLoadModelTimeout(requestId, command.modelPath);
}

/**
 * Send a RendererCommand to the renderer process via IPC.
 * Safe to call only when mainWindow exists and rendererReady is true.
 */
function sendCommandToRenderer(command: RendererCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('Cannot send command: window unavailable', { type: command.type });
    return;
  }
  mainWindow.webContents.send('host-command', command);
}

/**
 * Start a 10-second watchdog. If the renderer doesn't reply with
 * ModelLoaded/ModelLoadFailed within the timeout, main process proactively
 * emits ModelLoadFailed so AI_maid doesn't hang forever.
 */
function startLoadModelTimeout(requestId: string | null, modelPath: string): void {
  clearLoadModelTimeout();
  loadModelTimeoutTimer = setTimeout(() => {
    loadModelTimeoutTimer = null;
    log('LoadModel timed out (10s), main process emitting ModelLoadFailed', { modelPath, requestId });
    sendEvent(
      {
        type: 'ModelLoadFailed',
        modelPath,
        message: 'Renderer did not respond to LoadModel within 10 seconds.'
      },
      requestId
    );
    pendingLoadModelRequestId = null;
    pendingLoadModelPath = null;
  }, LOAD_MODEL_TIMEOUT_MS);
}

function clearLoadModelTimeout(): void {
  if (loadModelTimeoutTimer) {
    clearTimeout(loadModelTimeoutTimer);
    loadModelTimeoutTimer = null;
  }
}

function handleSetTransform(command: { x: number; y: number; scale: number }, requestId: string | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  // Set window position (keep current size; renderer will resize via petResizeToFit)
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds({
    x: Math.round(command.x),
    y: Math.round(command.y),
    width: bounds.width,
    height: bounds.height
  }, false);

  // Forward scale to renderer; renderer will emit TransformChanged after applying
  const rendererCommand: RendererCommand = {
    type: 'SetTransform',
    scale: command.scale
  };
  sendCommandToRenderer(rendererCommand);
  // requestId is not used for response here — TransformChanged is spontaneous
  void requestId;
}

function forwardToRenderer(command: AiMaidCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('Cannot forward command: window unavailable', { type: command.type });
    return;
  }

  // If renderer not ready, log warning — these commands are spontaneous
  // and don't have a cached retry path like LoadModel. AI_maid can re-send.
  if (!rendererReady) {
    log('Renderer not ready, command may be lost', { type: command.type });
  }

  let rendererCommand: RendererCommand;
  switch (command.type) {
    case 'PlayMotion':
      rendererCommand = {
        type: 'PlayMotion',
        group: command.group,
        index: command.index,
        fallbackAction: command.fallbackAction
      };
      break;
    case 'SetExpression':
      rendererCommand = {
        type: 'SetExpression',
        name: command.name,
        durationMs: command.durationMs
      };
      break;
    case 'SetActionTag':
      rendererCommand = {
        type: 'SetActionTag',
        actionTag: command.actionTag,
        durationMs: command.durationMs
      };
      break;
    case 'SpeakStart':
      rendererCommand = {
        type: 'SpeakStart',
        text: command.text,
        estimatedDurationMs: command.estimatedDurationMs
      };
      break;
    case 'SpeakStop':
      rendererCommand = { type: 'SpeakStop' };
      break;
    default:
      return;
  }

  sendCommandToRenderer(rendererCommand);
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
