import { BrowserWindow, app, ipcMain, protocol, screen } from 'electron';
import { extname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitEvent } from './stdioProtocol';
import { log } from './logger';
import type { HostCommand, RendererEvent } from './protocolTypes';

let mainWindow: BrowserWindow | null = null;
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
    emitEvent({ type: 'Closed' });
  });

  mainWindow.webContents.on('console-message', (event) => {
    log('Renderer console', event);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('Renderer process gone', details);
    emitEvent({ type: 'Error', message: `Renderer process gone: ${details.reason}` });
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log('Renderer load failed', { errorCode, errorDescription, validatedURL });
    emitEvent({ type: 'Error', message: `Renderer load failed: ${errorDescription}` });
  });

  return mainWindow;
}

export function registerWindowIpc(): void {
  registerLocalFileProtocol();

  ipcMain.handle('renderer-event', (_event, payload: RendererEvent) => {
    log('Renderer event', payload);
    emitEvent(payload);
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
    emitEvent({ type: 'WindowMoved', x: bounds.x, y: bounds.y });
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
    const base = process.env.ELECTRON_RENDERER_URL
      ? app.getAppPath()
      : process.resourcesPath;
    return toLive2DFileUrl(resolve(base, 'vendor', 'CubismSdkForWeb', 'Core', 'live2dcubismcore.min.js'));
  });

  ipcMain.handle('get-display', () => {
    return screen.getPrimaryDisplay().scaleFactor;
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

export function handleHostCommand(command: HostCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    emitEvent({ type: 'Error', message: 'Renderer window is not available.' });
    return;
  }

  switch (command.type) {
    case 'Show':
      mainWindow.showInactive();
      break;
    case 'Hide':
      mainWindow.hide();
      break;
    case 'Close':
      log('Close command received');
      mainWindow.close();
      app.quit();
      break;
    case 'SetPosition':
      mainWindow.setPosition(Math.round(command.x), Math.round(command.y), false);
      break;
    default:
      log('Forwarding command to renderer', command);
      mainWindow.webContents.send('host-command', command);
      break;
  }
}
