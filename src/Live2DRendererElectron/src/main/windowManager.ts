import { BrowserWindow, app, ipcMain, protocol, screen } from 'electron';
import { extname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendEvent, closeProtocol } from './protocol';
import { log } from './logger';
import { parseStartupArgs } from './args';
import type { AiMaidCommand, RendererCommand, RendererEvent } from './protocolTypes';

let mainWindow: BrowserWindow | null = null;
let parentPid: number | null = null;
let pendingLoadModelRequestId: string | null = null;
let pendingLoadModelPath: string | null = null;
let isModelLoading = false;
let queuedLoadModel: { command: LoadModelRendererCommand; requestId: string | null } | null = null;
// Tracks the requestId of the most recent QueryModelGeometry so the
// ModelGeometryResult from the renderer can be correlated and forwarded
// back to AI_maid with the correct requestId. Single in-flight query is
// sufficient — AI_maid is expected to wait for each response before
// sending the next query.
let pendingQueryGeometryRequestId: string | null = null;

// Renderer readiness tracking — prevents LoadModel from being lost when it
// arrives before the renderer process has finished loading.
type LoadModelRendererCommand = Extract<RendererCommand, { type: 'LoadModel' }>;
let rendererReady = false;
let pendingLoadModelCommand: { command: LoadModelRendererCommand; requestId: string | null } | null = null;
let loadModelTimeoutTimer: NodeJS.Timeout | null = null;
const LOAD_MODEL_TIMEOUT_MS = 10000;

// Renderer crash auto-recovery — reload up to N times before giving up.
// A successful reload resets the counter (tracked via did-finish-load).
const MAX_RENDER_CRASH_RECOVERIES = 3;
let renderCrashRecoveryAttempts = 0;

let petDragState: {
  startCursorX: number;
  startCursorY: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
} | null = null;

export function createRendererWindow(): BrowserWindow {
  log('BrowserWindow create start', {
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    show: false,
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || 'NOT SET'
  });

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

  log('BrowserWindow created', {
    id: mainWindow.id,
    visible: mainWindow.isVisible(),
    bounds: mainWindow.getBounds()
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    log('Loading renderer from ELECTRON_RENDERER_URL', { url: process.env.ELECTRON_RENDERER_URL });
  } else {
    const filePath = join(__dirname, '../renderer/index.html');
    void mainWindow.loadFile(filePath);
    log('Loading renderer from file', { filePath });
  }

  mainWindow.once('ready-to-show', () => {
    // Page has rendered its first frame — safe to show now without flashing white.
    log('BrowserWindow ready-to-show', {
      id: mainWindow?.id,
      visible: mainWindow?.isVisible(),
      bounds: mainWindow?.getBounds()
    });
    mainWindow?.center();
    mainWindow?.showInactive();
    log('BrowserWindow shown (showInactive)', {
      id: mainWindow?.id,
      visible: mainWindow?.isVisible()
    });
  });

  mainWindow.on('will-resize', (event, newBounds) => {
    if (petDragState) {
      newBounds.width = petDragState.width;
      newBounds.height = petDragState.height;
    }
  });

  mainWindow.on('show', () => {
    log('BrowserWindow event: show', { id: mainWindow?.id });
  });

  mainWindow.on('hide', () => {
    log('BrowserWindow event: hide', { id: mainWindow?.id });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    log('BrowserWindow event: closed');
  });

  mainWindow.webContents.on('console-message', (event) => {
    log('Renderer console', event);
  });

  // Mark renderer as ready — any LoadModel that arrived before this point
  // was cached in pendingLoadModelCommand and is now flushed.
  mainWindow.webContents.on('did-finish-load', () => {
    if (!rendererReady) {
      rendererReady = true;
      log('Renderer did-finish-load, rendererReady=true', {
        visible: mainWindow?.isVisible(),
        bounds: mainWindow?.getBounds()
      });

      if (pendingLoadModelCommand) {
        const { command, requestId } = pendingLoadModelCommand;
        pendingLoadModelCommand = null;
        log('Flushing pending LoadModel to renderer', { modelPath: command.modelPath, requestId });
        sendCommandToRenderer(command);
        startLoadModelTimeout(requestId, command.modelPath);
      }
    }

    // If this load followed a crash recovery, reset the counter and re-show
    // the window (it was hidden by hideWindowForCrash).
    if (renderCrashRecoveryAttempts > 0) {
      log('Renderer recovered from crash via reload', {
        previousAttempts: renderCrashRecoveryAttempts
      });
      renderCrashRecoveryAttempts = 0;
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        try {
          mainWindow.showInactive();
          log('Renderer window re-shown after recovery');
        } catch (e) {
          log('Failed to re-show window after recovery', { error: e });
        }
      }
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('Renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      visible: mainWindow?.isVisible(),
      bounds: mainWindow?.getBounds()
    });
    // Hide the window immediately so we don't leave a frozen white frame on screen.
    hideWindowForCrash('RenderProcessGone');
    sendEvent(
      { type: 'Error', code: 'RenderProcessGone', message: `Renderer process gone: ${details.reason}` },
      null
    );
    // Auto-recover: reload the renderer to bring the character back.
    // Limit retries to avoid a crash loop — if it keeps crashing, give up
    // and let AI_maid decide what to do.
    if (!mainWindow || mainWindow.isDestroyed()) return;
    renderCrashRecoveryAttempts += 1;
    if (renderCrashRecoveryAttempts <= MAX_RENDER_CRASH_RECOVERIES) {
      log('Attempting renderer recovery via reload', {
        attempt: renderCrashRecoveryAttempts,
        max: MAX_RENDER_CRASH_RECOVERIES
      });
      try {
        mainWindow.webContents.reload();
      } catch (e) {
        log('Renderer reload failed', { error: e });
      }
    } else {
      log('Renderer crash recovery limit reached, giving up', {
        attempts: renderCrashRecoveryAttempts,
        max: MAX_RENDER_CRASH_RECOVERIES
      });
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log('Renderer load failed', {
      errorCode,
      errorDescription,
      validatedURL,
      visible: mainWindow?.isVisible(),
      bounds: mainWindow?.getBounds()
    });
    // Hide the window so a half-loaded white page is not left on screen.
    hideWindowForCrash('LoadFailed');
    sendEvent(
      { type: 'Error', code: 'LoadFailed', message: `Renderer load failed: ${errorDescription}` },
      null
    );
  });

  // Unresponsive renderer can also leave a frozen white frame.
  mainWindow.webContents.on('unresponsive', () => {
    log('Renderer unresponsive', {
      visible: mainWindow?.isVisible(),
      bounds: mainWindow?.getBounds()
    });
    hideWindowForCrash('Unresponsive');
    sendEvent(
      { type: 'Error', code: 'Unresponsive', message: 'Renderer process became unresponsive' },
      null
    );
  });

  return mainWindow;
}

/**
 * Hide the main window when the renderer crashes or fails to load.
 *
 * This is the primary defense against the "white frame" issue: a transparent,
 * frameless BrowserWindow with no renderer output is invisible, but a
 * half-loaded or crashed renderer page can paint a white background.
 *
 * We hide (not destroy) so that the AI_maid host can still receive the Error
 * event and decide to restart Live or fall back to image mode.
 */
function hideWindowForCrash(reason: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('hideWindowForCrash: window already destroyed', { reason });
    return;
  }
  try {
    const wasVisible = mainWindow.isVisible();
    mainWindow.hide();
    log('hideWindowForCrash: window hidden', { reason, wasVisible });
  } catch (e) {
    log('hideWindowForCrash: failed to hide', { reason, error: e });
  }
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

  ipcMain.handle('get-action-tag-map-url', () => {
    // Resolve config/action_tag_map.json. In dev mode use the project's
    // config dir; when packaged use resourcesPath/config.
    const devConfigPath = resolve(__dirname, '..', '..', 'config', 'action_tag_map.json');
    const packagedConfigPath = resolve(process.resourcesPath, 'config', 'action_tag_map.json');
    const configPath = existsSync(devConfigPath)
      ? devConfigPath
      : existsSync(packagedConfigPath)
        ? packagedConfigPath
        : devConfigPath; // fall back to dev path even if missing — caller will handle 404
    return toLive2DFileUrl(configPath);
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
      processQueuedLoadModel();
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
      processQueuedLoadModel();
      break;
    case 'TransformChanged': {
      // Renderer only knows scale + reason; fill in xDip/yDip/widthDip/heightDip
      // from the actual window bounds so AI_maid gets the full picture.
      // getBounds() returns DIP (Device Independent Pixels), not physical pixels.
      // dpiScale is the display's monitor scaling factor (e.g. 1.25 on a
      // 125% Windows DPI setting). xDip/yDip/widthDip/heightDip are DIPs;
      // dpiScale lets consumers convert to physical pixels if needed.
      const bounds = mainWindow?.getBounds();
      let dpiScale = 1;
      if (bounds) {
        try {
          dpiScale = screen.getDisplayMatching(bounds).scaleFactor || 1;
        } catch (e) {
          log('Failed to get dpiScale for TransformChanged', { error: e });
        }
      }
      sendEvent(
        {
          type: 'TransformChanged',
          xDip: bounds?.x ?? 0,
          yDip: bounds?.y ?? 0,
          widthDip: bounds?.width ?? 0,
          heightDip: bounds?.height ?? 0,
          scale: event.scale,
          dpiScale,
          reason: event.reason
        },
        null
      );
      break;
    }
    case 'RightClick': {
      // Enrich the screen-space click point with full display/window context.
      // event.screenXDip/screenYDip (from the DOM event.screenX/Y) are DIP. Use
      // Electron's screen.dipToScreenPoint to convert to physical pixels — do NOT
      // multiply by scaleFactor manually, multi-monitor setups have per-display origins.
      const windowBoundsDip = mainWindow?.getBounds();
      let screenXPx = event.screenXDip;
      let screenYPx = event.screenYDip;
      let displayId = 0;
      let displayScaleFactor = 1;
      let displayBoundsDip = { x: 0, y: 0, width: 0, height: 0 };
      let displayWorkAreaDip = { x: 0, y: 0, width: 0, height: 0 };
      try {
        const px = screen.dipToScreenPoint({ x: event.screenXDip, y: event.screenYDip });
        screenXPx = px.x;
        screenYPx = px.y;
      } catch (e) {
        log('Failed to convert DIP to screen px for RightClick', { error: e });
      }
      if (windowBoundsDip) {
        try {
          const display = screen.getDisplayMatching(windowBoundsDip);
          displayId = display.id;
          displayScaleFactor = display.scaleFactor || 1;
          displayBoundsDip = display.bounds;
          displayWorkAreaDip = display.workArea;
        } catch (e) {
          log('Failed to get display info for RightClick', { error: e });
        }
      }
      sendEvent(
        {
          type: 'RightClick',
          screenXDip: event.screenXDip,
          screenYDip: event.screenYDip,
          screenXPx,
          screenYPx,
          displayId,
          displayScaleFactor,
          displayBoundsDip,
          displayWorkAreaDip,
          windowBoundsDip: windowBoundsDip ?? { x: 0, y: 0, width: 0, height: 0 }
        },
        null
      );
      break;
    }
    case 'PointerEvent':
    case 'Error':
      sendEvent(event, null);
      break;
    case 'ModelGeometryResult':
      handleModelGeometryResult(event);
      break;
    default:
      log('Unknown renderer event type', (event as { type: string }).type);
      break;
  }
}

/**
 * Convert window-relative DIP coordinates from the renderer to screen DIP
 * coordinates by adding the window's screen position, then forward the
 * enriched ModelGeometryResult to AI_maid with the original requestId.
 *
 * If the window is unavailable, fall back to window origin (0,0).
 */
function handleModelGeometryResult(
  event: Extract<RendererEvent, { type: 'ModelGeometryResult' }>
): void {
  const requestId = pendingQueryGeometryRequestId;
  pendingQueryGeometryRequestId = null;

  const windowBounds = mainWindow?.getBounds();
  const offsetX = windowBounds?.x ?? 0;
  const offsetY = windowBounds?.y ?? 0;

  if (!event.ok) {
    log('ModelGeometryResult (failure)', {
      requestId,
      code: event.code,
      message: event.message
    });
    sendEvent(
      {
        type: 'ModelGeometryResult',
        ok: false,
        roleId: event.roleId,
        coordinateSpace: 'screenDip',
        code: event.code,
        message: event.message
      },
      requestId
    );
    return;
  }

  const shiftPoint = (p: { x: number; y: number }) => ({
    x: p.x + offsetX,
    y: p.y + offsetY
  });
  const shiftBounds = (b: { x: number; y: number; width: number; height: number }) => ({
    x: b.x + offsetX,
    y: b.y + offsetY,
    width: b.width,
    height: b.height
  });

  const modelBounds = event.modelBounds ? shiftBounds(event.modelBounds) : undefined;
  const anchors = event.anchors ? {
    modelCenter: shiftPoint(event.anchors.modelCenter),
    headTop: shiftPoint(event.anchors.headTop),
    faceCenter: shiftPoint(event.anchors.faceCenter),
    bodyCenter: shiftPoint(event.anchors.bodyCenter),
    feetCenter: shiftPoint(event.anchors.feetCenter)
  } : undefined;
  const parts = event.parts?.map((p) => ({
    id: p.id,
    name: p.name,
    visible: p.visible,
    bounds: p.bounds ? shiftBounds(p.bounds) : undefined,
    anchor: p.anchor ? shiftPoint(p.anchor) : undefined
  }));

  const responsePayload = {
    type: 'ModelGeometryResult' as const,
    ok: true,
    roleId: event.roleId,
    coordinateSpace: 'screenDip' as const,
    modelBounds,
    anchors,
    parts,
    scale: event.scale
  };

  log('ModelGeometryResult (success) sending to WPF', {
    requestId,
    roleId: event.roleId,
    modelBounds,
    anchors,
    partsCount: parts?.length ?? 0,
    parts,
    scale: event.scale
  });

  sendEvent(responsePayload, requestId);
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
        log('Show command', { wasVisible: mainWindow.isVisible() });
        mainWindow.showInactive();
        log('Show command done', { isVisible: mainWindow.isVisible(), bounds: mainWindow.getBounds() });
      } else {
        log('Show command: window unavailable');
      }
      break;
    case 'Hide':
      if (mainWindow && !mainWindow.isDestroyed()) {
        log('Hide command', { wasVisible: mainWindow.isVisible() });
        mainWindow.hide();
        log('Hide command done', { isVisible: mainWindow.isVisible() });
      } else {
        log('Hide command: window unavailable');
      }
      break;
    case 'Close':
      log('Close command received', { reason: command.reason });
      // Send Closed first while the pipe is still alive, then detach so any
      // subsequent renderer events (during window teardown) are silently
      // dropped instead of throwing EPIPE.
      sendEvent({ type: 'Closed', reason: command.reason ?? 'AI_maidClose' }, null);
      closeProtocol('AI_maidClose');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      }
      app.quit();
      break;
    case 'Shutdown':
      log('Shutdown command received', { reason: command.reason });
      // Shutdown = immediate termination, no Closed event sent back (the
      // host already knows it's shutting us down).
      closeProtocol('ShutdownCommand');
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
    case 'QueryModelGeometry':
      handleQueryModelGeometry(command, requestId);
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

  // Proactively push the initial window transform so AI_maid receives
  // the current bounds right after init (mirrors TransformChanged format).
  const initBounds = mainWindow?.getBounds();
  let initDpiScale = 1;
  if (initBounds) {
    try {
      initDpiScale = screen.getDisplayMatching(initBounds).scaleFactor || 1;
    } catch (e) {
      log('Failed to get dpiScale for init transform', { error: e });
    }
  }
  sendEvent(
    {
      type: 'TransformChanged',
      xDip: initBounds?.x ?? 0,
      yDip: initBounds?.y ?? 0,
      widthDip: initBounds?.width ?? 0,
      heightDip: initBounds?.height ?? 0,
      scale: 1,
      dpiScale: initDpiScale,
      reason: 'init'
    },
    null
  );
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

  const rendererCommand: LoadModelRendererCommand = {
    type: 'LoadModel',
    roleId: command.roleId,
    modelPath: command.modelPath,
    initialTransform: command.initialTransform
  };

  if (isModelLoading) {
    log('LoadModel queued (another load in progress)', {
      modelPath: command.modelPath,
      requestId,
      currentModelPath: pendingLoadModelPath
    });
    queuedLoadModel = { command: rendererCommand, requestId };
    return;
  }

  startModelLoad(rendererCommand, requestId);
}

function startModelLoad(
  rendererCommand: LoadModelRendererCommand,
  requestId: string | null
): void {
  isModelLoading = true;
  pendingLoadModelRequestId = requestId;
  pendingLoadModelPath = rendererCommand.modelPath;

  if (rendererCommand.initialTransform && typeof rendererCommand.initialTransform.x === 'number' && typeof rendererCommand.initialTransform.y === 'number') {
    const bounds = mainWindow!.getBounds();
    mainWindow!.setBounds({
      x: Math.round(rendererCommand.initialTransform.x),
      y: Math.round(rendererCommand.initialTransform.y),
      width: bounds.width,
      height: bounds.height
    }, false);
  }

  if (!rendererReady) {
    log('Renderer not ready yet, caching LoadModel', { modelPath: rendererCommand.modelPath, requestId });
    pendingLoadModelCommand = { command: rendererCommand, requestId };
    return;
  }

  sendCommandToRenderer(rendererCommand);
  startLoadModelTimeout(requestId, rendererCommand.modelPath);
}

function processQueuedLoadModel(): void {
  isModelLoading = false;
  pendingLoadModelRequestId = null;
  pendingLoadModelPath = null;

  if (queuedLoadModel) {
    const next = queuedLoadModel;
    queuedLoadModel = null;
    log('Processing queued LoadModel', { modelPath: next.command.modelPath, requestId: next.requestId });
    startModelLoad(next.command, next.requestId);
  }
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
    processQueuedLoadModel();
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

/**
 * Handle QueryModelGeometry: forward the query to the renderer and remember
 * the requestId so the renderer's ModelGeometryResult can be correlated and
 * sent back to AI_maid with the correct requestId.
 *
 * The renderer returns window-relative DIP coordinates; the
 * handleModelGeometryResult function adds the window's screen position to
 * convert them to screenDip before forwarding to AI_maid.
 */
function handleQueryModelGeometry(
  command: { roleId?: string; includeParts?: boolean; includeAnchors?: boolean },
  requestId: string | null
): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('QueryModelGeometry: window unavailable', { requestId });
    sendEvent(
      {
        type: 'ModelGeometryResult',
        ok: false,
        coordinateSpace: 'screenDip',
        code: 'RendererNotReady',
        message: 'renderer window is not available'
      },
      requestId
    );
    return;
  }

  if (!rendererReady) {
    log('QueryModelGeometry: renderer not ready', { requestId });
    sendEvent(
      {
        type: 'ModelGeometryResult',
        ok: false,
        coordinateSpace: 'screenDip',
        code: 'RendererNotReady',
        message: 'renderer is not ready yet'
      },
      requestId
    );
    return;
  }

  // Overwrite any previously pending query — AI_maid should wait for each
  // response before sending another, but if it doesn't, the latest wins.
  if (pendingQueryGeometryRequestId !== null) {
    log('QueryModelGeometry: replacing in-flight query', {
      previousRequestId: pendingQueryGeometryRequestId,
      newRequestId: requestId
    });
  }
  pendingQueryGeometryRequestId = requestId;

  const rendererCommand: RendererCommand = {
    type: 'QueryModelGeometry',
    roleId: command.roleId,
    includeParts: command.includeParts,
    includeAnchors: command.includeAnchors
  };
  sendCommandToRenderer(rendererCommand);
  log('QueryModelGeometry forwarded to renderer', {
    requestId,
    roleId: command.roleId,
    includeParts: command.includeParts,
    includeAnchors: command.includeAnchors
  });
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
        audioPath: command.audioPath,
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
