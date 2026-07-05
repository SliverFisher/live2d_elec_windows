import './styles/app.css';
import type { RendererCommand } from '../main/protocolTypes';
import { Live2DPlayer } from './live2d/Live2DPlayer';
import { playMotion, setExpression, applyActionTag, startSpeaking, stopSpeaking } from './live2d/motionController';

console.info('Renderer script starting');

window.addEventListener('error', (event) => {
  const error = event.error instanceof Error ? event.error : undefined;
  console.error('Renderer uncaught error ' + JSON.stringify({
    message: error?.message ?? event.message,
    stack: error?.stack,
    source: event.filename,
    line: event.lineno,
    column: event.colno
  }));
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason : undefined;
  console.error('Renderer unhandled rejection ' + JSON.stringify({
    message: reason?.message ?? String(event.reason),
    stack: reason?.stack
  }));
});

const canvasElement = document.querySelector<HTMLCanvasElement>('#live2d-canvas');
const statusElement = document.querySelector<HTMLDivElement>('#status');

if (!canvasElement || !statusElement) {
  throw new Error('Renderer DOM is incomplete.');
}

const canvas = canvasElement;
const status = statusElement;

let player: Live2DPlayer;
const DRAG_START_DISTANCE = 6;
let dragPointerId: number | null = null;
let dragStartPoint: { clientX: number; clientY: number } | null = null;
let dragStarted = false;
let scaleReportTimer: number | null = null;
let pendingDragFrameId: number | null = null;
let ignoringTransparentInput = false;
let isResizingWindow = false;
let currentModelPath: string | null = null;

try {
  player = new Live2DPlayer(canvas);
  setStatus('');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message);
  void window.live2dRenderer.emitEvent({ type: 'Error', code: 'PlayerInitFailed', message });
  throw error;
}

// Dev mode: auto-load model based on startup args (--model or default).
// AI_madi mode: wait for LoadModel command.
void initDevModel();

window.addEventListener('resize', () => {
  if (isResizingWindow) {
    return;
  }
  window.requestAnimationFrame(() => player.handleWindowResize());
});

window.addEventListener('blur', () => {
  endDrag();
  setTransparentInputIgnored(true);
});

window.live2dRenderer.onHostCommand((command) => {
  console.info('[CMD] renderer received command: ' + command.type);
  if (command.type === 'LoadModel') {
    console.info('[LoadModel] renderer received LoadModel, modelPath=' + command.modelPath);
  }
  void handleCommand(command);
});

// ============================================================
// Pointer / drag / zoom handlers
// ============================================================

canvas.addEventListener('pointerdown', (event) => {
  const hit = player.containsPoint(event.clientX, event.clientY);

  if (event.button !== 0) {
    return;
  }

  if (!hit) {
    return;
  }

  setTransparentInputIgnored(false);
  dragPointerId = event.pointerId;
  dragStartPoint = { clientX: event.clientX, clientY: event.clientY };
  dragStarted = false;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  updateTransparentInput(event.clientX, event.clientY);

  if (dragPointerId === event.pointerId && dragStartPoint) {
    const dx = event.clientX - dragStartPoint.clientX;
    const dy = event.clientY - dragStartPoint.clientY;
    const movedDistance = Math.hypot(dx, dy);

    if (!dragStarted && movedDistance < DRAG_START_DISTANCE) {
      return;
    }

    if (!dragStarted) {
      dragStarted = true;
      void window.live2dRenderer.petDragStart();
    }

    queuePetDragMove();
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (dragPointerId !== event.pointerId) {
    return;
  }

  const wasDragging = dragStarted;
  const wasInside = player.containsPoint(event.clientX, event.clientY);

  clearDragState();

  if (wasDragging) {
    void window.live2dRenderer.petDragEnd().then(() => {
      // Report final transform after drag ends
      emitTransformChanged('dragEnd');
    });
  } else if (wasInside) {
    emitPointerEvent(event, 'leftClick');
    void playMotion(player.currentModel, 'TapBody', 0).catch(() => undefined);
  }

  updateTransparentInput(event.clientX, event.clientY);
});

canvas.addEventListener('pointercancel', (event) => {
  if (dragPointerId !== event.pointerId) {
    return;
  }

  const wasDragging = dragStarted;
  clearDragState();

  if (wasDragging) {
    void window.live2dRenderer.petDragEnd().then(() => {
      emitTransformChanged('dragCancel');
    });
  }
});

canvas.addEventListener('lostpointercapture', (event) => {
  if (dragPointerId !== event.pointerId) {
    return;
  }

  const wasDragging = dragStarted;
  clearDragState();

  if (wasDragging) {
    void window.live2dRenderer.petDragEnd().then(() => {
      emitTransformChanged('dragCancel');
    });
  }
});

canvas.addEventListener('dblclick', (event) => {
  if (!player.containsPoint(event.clientX, event.clientY)) {
    return;
  }

  player.setUserScale(1);
  const fitted = player.getFittedWindowSize();
  isResizingWindow = true;
  void window.live2dRenderer.petResizeToFit(fitted.width, fitted.height).finally(() => {
    setTimeout(() => { isResizingWindow = false; }, 100);
    emitTransformChanged('dblclickReset');
  });
});

canvas.addEventListener('pointerleave', () => {
  if (dragPointerId === null) {
    setTransparentInputIgnored(true);
  }
});

canvas.addEventListener('wheel', (event) => {
  const hit = player.containsPoint(event.clientX, event.clientY);

  if (!hit) {
    return;
  }

  event.preventDefault();
  const zoomFactor = event.deltaY > 0 ? 0.92 : 1.08;
  const nextScale = player.currentScale * zoomFactor;
  const finalScale = player.setUserScale(nextScale);

  const fitted = player.getFittedWindowSize();
  isResizingWindow = true;
  void window.live2dRenderer.petResizeToFit(fitted.width, fitted.height).finally(() => {
    setTimeout(() => { isResizingWindow = false; }, 100);
  });

  // Throttle scale change reporting
  if (scaleReportTimer !== null) {
    window.clearTimeout(scaleReportTimer);
  }

  scaleReportTimer = window.setTimeout(() => {
    scaleReportTimer = null;
    emitTransformChanged('scaleEnd');
  }, 200);
}, { passive: false });

canvas.addEventListener('contextmenu', (event) => {
  if (!player.containsPoint(event.clientX, event.clientY)) {
    return;
  }

  event.preventDefault();
  // Use screenX/screenY from the DOM event (relative to the screen origin)
  void window.live2dRenderer.emitEvent({
    type: 'RightClick',
    screenX: Math.round(event.screenX),
    screenY: Math.round(event.screenY)
  });
});

// ============================================================
// Command handling (main → renderer)
// ============================================================

async function handleCommand(command: RendererCommand): Promise<void> {
  try {
    switch (command.type) {
      case 'LoadModel': {
        console.info('[LoadModel] loadModel_start, modelPath=' + command.modelPath);
        setStatus('Loading Live2D model...');
        currentModelPath = command.modelPath;
        const [modelUrl, cubismCoreUrl] = await Promise.all([
          window.live2dRenderer.resolveModelUrl(command.modelPath),
          window.live2dRenderer.getCubismCoreUrl()
        ]);
        console.info('[LoadModel] resolved urls, modelUrl=' + modelUrl + ', cubismCoreUrl=' + cubismCoreUrl);
        await withTimeout(player.loadModel(modelUrl, cubismCoreUrl), 20000, 'Timed out while loading Live2D model.');
        console.info('[LoadModel] loadModel_success');
        setStatus('');

        // Apply initial transform if provided
        if (command.initialTransform?.scale !== undefined) {
          player.setUserScale(command.initialTransform.scale);
        }

        const fitted = player.getFittedWindowSize();
        isResizingWindow = true;
        await window.live2dRenderer.petResizeToFit(fitted.width, fitted.height);
        setTimeout(() => { isResizingWindow = false; }, 100);

        setTransparentInputIgnored(true);
        await window.live2dRenderer.emitEvent({
          type: 'ModelLoaded',
          modelPath: command.modelPath,
          roleId: command.roleId
        });
        break;
      }
      case 'SetTransform': {
        const scale = player.setUserScale(command.scale);
        const fitted = player.getFittedWindowSize();
        isResizingWindow = true;
        await window.live2dRenderer.petResizeToFit(fitted.width, fitted.height);
        setTimeout(() => { isResizingWindow = false; }, 100);
        emitTransformChanged('setTransform');
        void scale;
        break;
      }
      case 'PlayMotion':
        await playMotion(player.currentModel, command.group, command.index);
        break;
      case 'SetExpression':
        setExpression(player.currentModel, command.name);
        break;
      case 'SetActionTag':
        applyActionTag(player.currentModel, command.actionTag);
        break;
      case 'SpeakStart':
        startSpeaking(player.currentModel);
        break;
      case 'SpeakStop':
        stopSpeaking();
        break;
      default:
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[handleCommand] command=' + command.type + ' failed: ' + message);
    setStatus(message);
    const isLoadFailure = command.type === 'LoadModel';
    if (isLoadFailure) {
      console.error('[LoadModel] loadModel_failed: ' + message);
      await window.live2dRenderer.emitEvent({
        type: 'ModelLoadFailed',
        modelPath: command.modelPath,
        message
      });
    } else {
      await window.live2dRenderer.emitEvent({
        type: 'Error',
        code: 'CommandFailed',
        message
      });
    }
  }
}

// ============================================================
// Event emission helpers
// ============================================================

function emitPointerEvent(event: PointerEvent, kind: string): void {
  const normalizedX = window.innerWidth > 0 ? event.clientX / window.innerWidth : 0;
  const normalizedY = window.innerHeight > 0 ? event.clientY / window.innerHeight : 0;
  const hitAreas = player.hitTest(event.clientX, event.clientY);
  const hitAreaName = hitAreas.length > 0 ? hitAreas[0] : undefined;

  void window.live2dRenderer.emitEvent({
    type: 'PointerEvent',
    kind,
    x: Math.round(event.clientX),
    y: Math.round(event.clientY),
    normalizedX: Number(normalizedX.toFixed(4)),
    normalizedY: Number(normalizedY.toFixed(4)),
    hitAreaName,
    button: event.button === 0 ? 'left' : event.button === 2 ? 'right' : 'other'
  });
}

function emitTransformChanged(reason: string): void {
  void window.live2dRenderer.emitEvent({
    type: 'TransformChanged',
    scale: player.currentScale,
    reason
  });
}

// ============================================================
// Transparent input / drag helpers
// ============================================================

function updateTransparentInput(clientX: number, clientY: number): void {
  if (dragPointerId !== null) {
    return;
  }

  const hit = player.containsPoint(clientX, clientY);
  setTransparentInputIgnored(!hit);
}

function setTransparentInputIgnored(ignore: boolean): void {
  if (ignore === ignoringTransparentInput) {
    return;
  }

  ignoringTransparentInput = ignore;
  void window.live2dRenderer.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
}

function queuePetDragMove(): void {
  if (pendingDragFrameId !== null) {
    return;
  }

  pendingDragFrameId = window.requestAnimationFrame(() => {
    pendingDragFrameId = null;
    if (dragStarted && dragPointerId !== null) {
      void window.live2dRenderer.petDragMove();
    }
  });
}

function clearDragState(): void {
  if (dragPointerId !== null) {
    try {
      canvas.releasePointerCapture(dragPointerId);
    } catch {
      // ignore
    }
  }

  dragPointerId = null;
  dragStartPoint = null;
  dragStarted = false;

  if (pendingDragFrameId !== null) {
    window.cancelAnimationFrame(pendingDragFrameId);
    pendingDragFrameId = null;
  }
}

function endDrag(): void {
  const wasDragging = dragStarted;
  clearDragState();
  if (wasDragging) {
    void window.live2dRenderer.petDragEnd().then(() => {
      emitTransformChanged('blur');
    });
  }
}

function setStatus(message: string): void {
  status.textContent = message;
  status.classList.toggle('is-visible', message.length > 0);
}

// ============================================================
// Dev mode model loading
// ============================================================

async function initDevModel(): Promise<void> {
  try {
    const startupInfo = await window.live2dRenderer.getStartupArgs();

    // AI_maid mode: wait for LoadModel command, don't auto-load
    if (startupInfo.isAiMaidMode) {
      console.info('[DEV] AI_maid mode active, waiting for LoadModel command');
      return;
    }

    // --no-default-model: skip auto-loading
    if (startupInfo.noDefaultModel) {
      console.info('[DEV] --no-default-model set, skipping dev model load');
      return;
    }

    setStatus('Dev mode: auto-loading model...');

    // Use --model path if provided, otherwise fall back to bundled dev model
    const modelPath = startupInfo.model
      ?? 'c:/Users/49213/Desktop/A/codex/Live/assests/live2d/符玄/符玄.model3.json';

    currentModelPath = modelPath;
    const [modelUrl, cubismCoreUrl] = await Promise.all([
      window.live2dRenderer.resolveModelUrl(modelPath),
      window.live2dRenderer.getCubismCoreUrl()
    ]);
    console.info('[DEV] Loading model from:', modelUrl);
    await withTimeout(player.loadModel(modelUrl, cubismCoreUrl), 20000, 'Timed out while loading Live2D model.');
    setStatus('');
    const fitted = player.getFittedWindowSize();
    isResizingWindow = true;
    await window.live2dRenderer.petResizeToFit(fitted.width, fitted.height);
    setTimeout(() => { isResizingWindow = false; }, 100);
    setTransparentInputIgnored(true);
    console.info('[DEV] Model loaded successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[DEV] Failed to load model:', message);
    setStatus('Dev load failed: ' + message);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}
