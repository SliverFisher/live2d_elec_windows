# 拖动和缩放问题完整分析

## 1. renderer.ts

```typescript
import './styles/app.css';
import type { HostCommand } from '../main/protocolTypes';
import { Live2DPlayer } from './live2d/Live2DPlayer';
import { playMotion, setExpression } from './live2d/motionController';

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
const PAN_JITTER_THRESHOLD = 1;
let dragPointerId: number | null = null;
let dragStartPoint: { clientX: number; clientY: number; screenX: number; screenY: number } | null = null;
let movedDuringPointer = false;
let scaleReportTimer: number | null = null;
let pendingDragPoint: { screenX: number; screenY: number } | null = null;
let dragFrameId: number | null = null;
let ignoringTransparentInput = false;
let panPointerId: number | null = null;
let panStartPoint: { clientX: number; clientY: number } | null = null;
let panning = false;

try {
  player = new Live2DPlayer(canvas);
  setStatus('');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message);
  void window.live2dRenderer.emitEvent({ type: 'Error', message });
  throw error;
}

window.addEventListener('resize', () => {
  window.requestAnimationFrame(() => player.resize());
});

window.live2dRenderer.onHostCommand((command) => {
  void handleCommand(command);
});

void window.live2dRenderer.emitEvent({ type: 'RendererReady' });

canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 2) {
    if (!player.containsPoint(event.clientX, event.clientY)) {
      return;
    }
    setTransparentInputIgnored(false);
    movedDuringPointer = false;
    dragPointerId = event.pointerId;
    dragStartPoint = {
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY
    };
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  if (event.button !== 0) {
    return;
  }

  if (!player.containsPoint(event.clientX, event.clientY)) {
    return;
  }

  setTransparentInputIgnored(false);
  panPointerId = event.pointerId;
  panStartPoint = { clientX: event.clientX, clientY: event.clientY };
  panning = false;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  updateTransparentInput(event.clientX, event.clientY);

  if (dragPointerId === event.pointerId && dragStartPoint) {
    const movedDistance = Math.hypot(event.clientX - dragStartPoint.clientX, event.clientY - dragStartPoint.clientY);
    if (!movedDuringPointer && movedDistance < DRAG_START_DISTANCE) {
      return;
    }

    if (!movedDuringPointer) {
      movedDuringPointer = true;
      void window.live2dRenderer.dragStart(dragStartPoint.screenX, dragStartPoint.screenY);
    }

    queueDragMove(event.screenX, event.screenY);
    return;
  }

  if (panPointerId === event.pointerId && panStartPoint) {
    const dx = event.clientX - panStartPoint.clientX;
    const dy = event.clientY - panStartPoint.clientY;
    const movedDistance = Math.hypot(dx, dy);

    if (!panning && movedDistance < DRAG_START_DISTANCE) {
      return;
    }

    if (!panning) {
      panning = true;
    }

    if (Math.abs(dx) < PAN_JITTER_THRESHOLD && Math.abs(dy) < PAN_JITTER_THRESHOLD) {
      return;
    }

    player.pan(dx, dy);
    panStartPoint = { clientX: event.clientX, clientY: event.clientY };
  }
});

canvas.addEventListener('mousemove', (event) => {
  updateTransparentInput(event.clientX, event.clientY);
});

canvas.addEventListener('pointerup', (event) => {
  if (dragPointerId === event.pointerId) {
    dragPointerId = null;
    dragStartPoint = null;
    pendingDragPoint = null;
    if (dragFrameId !== null) {
      window.cancelAnimationFrame(dragFrameId);
      dragFrameId = null;
    }
    canvas.releasePointerCapture(event.pointerId);
    if (movedDuringPointer) {
      void window.live2dRenderer.dragEnd();
    }
    return;
  }

  if (panPointerId === event.pointerId) {
    const wasPanning = panning;
    panPointerId = null;
    panStartPoint = null;
    panning = false;
    canvas.releasePointerCapture(event.pointerId);

    if (!wasPanning) {
      void window.live2dRenderer.emitEvent({ type: 'Click' });
      void playMotion(player.currentModel, 'TapBody', 0).catch(() => undefined);
    }
  }
});

canvas.addEventListener('dblclick', (event) => {
  if (!player.containsPoint(event.clientX, event.clientY)) {
    return;
  }
  player.resetView();
  void window.live2dRenderer.emitEvent({ type: 'ScaleChanged', scale: player.currentScale });
});

canvas.addEventListener('pointerleave', () => {
  if (dragPointerId === null && panPointerId === null) {
    setTransparentInputIgnored(true);
  }
});

canvas.addEventListener('wheel', (event) => {
  if (!player.containsPoint(event.clientX, event.clientY)) {
    return;
  }

  event.preventDefault();
  const zoomFactor = event.deltaY > 0 ? 0.92 : 1.08;
  const scale = player.zoomAt(event.clientX, event.clientY, zoomFactor);

  if (scaleReportTimer !== null) {
    window.clearTimeout(scaleReportTimer);
  }

  scaleReportTimer = window.setTimeout(() => {
    void window.live2dRenderer.emitEvent({ type: 'ScaleChanged', scale });
  }, 120);
}, { passive: false });

canvas.addEventListener('contextmenu', (event) => {
  if (!player.containsPoint(event.clientX, event.clientY)) {
    return;
  }

  event.preventDefault();
  void window.live2dRenderer.emitEvent({ type: 'RightClick' });
});

async function handleCommand(command: HostCommand): Promise<void> {
  try {
    switch (command.type) {
      case 'LoadModel': {
        setStatus('Loading Live2D model...');
        const [modelUrl, cubismCoreUrl] = await Promise.all([
          window.live2dRenderer.resolveModelUrl(command.modelPath),
          window.live2dRenderer.getCubismCoreUrl()
        ]);
        await withTimeout(player.loadModel(modelUrl, cubismCoreUrl), 20000, 'Timed out while loading Live2D model.');
        setStatus('');
        setTransparentInputIgnored(true);
        await window.live2dRenderer.emitEvent({ type: 'ModelLoaded', modelPath: command.modelPath });
        break;
      }
      case 'SetScale': {
        const scale = player.setScale(command.scale);
        await window.live2dRenderer.emitEvent({ type: 'ScaleChanged', scale });
        break;
      }
      case 'PlayMotion':
        await playMotion(player.currentModel, command.group, command.index);
        break;
      case 'SetExpression':
        setExpression(player.currentModel, command.name);
        break;
      default:
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    const eventType = command.type === 'LoadModel' ? 'ModelLoadFailed' : 'Error';
    await window.live2dRenderer.emitEvent({ type: eventType, message });
  }
}

function updateTransparentInput(clientX: number, clientY: number): void {
  if (dragPointerId !== null || panPointerId !== null) {
    return;
  }

  setTransparentInputIgnored(!player.containsPoint(clientX, clientY));
}

function setTransparentInputIgnored(ignore: boolean): void {
  if (ignore === ignoringTransparentInput) {
    return;
  }

  ignoringTransparentInput = ignore;
  void window.live2dRenderer.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
}

function queueDragMove(screenX: number, screenY: number): void {
  pendingDragPoint = { screenX, screenY };
  if (dragFrameId !== null) {
    return;
  }

  dragFrameId = window.requestAnimationFrame(() => {
    dragFrameId = null;
    const point = pendingDragPoint;
    pendingDragPoint = null;
    if (point) {
      void window.live2dRenderer.dragMove(point.screenX, point.screenY);
    }
  });
}

function setStatus(message: string): void {
  status.textContent = message;
  status.classList.toggle('is-visible', message.length > 0);
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
```

---

## 2. Live2DPlayer.ts

```typescript
import { Application, Container, extensions } from 'pixi.js';
import { assertModelJson } from './modelLoader';

type CubismEngineModule = typeof import('untitled-pixi-live2d-engine/cubism');

type LoadedLive2DModel = Container & {
  width: number;
  height: number;
  x: number;
  y: number;
  scale: { set: (value: number) => void };
  anchor: { set: (x: number, y: number) => void };
  children: unknown[];
  getBounds: () => { x: number; y: number; width: number; height: number };
  destroy: (options?: { children?: boolean }) => void;
  internalModel?: {
    width?: number;
    height?: number;
    originalWidth?: number;
    originalHeight?: number;
  };
  motion: (group: string, index?: number) => Promise<unknown>;
  expression: (name: string) => Promise<unknown> | boolean;
};

type CoreModelLike = {
  getDrawableCount?: () => number;
  getDrawableRenderOrders?: () => ArrayLike<number> | undefined;
  getDrawableDynamicFlagIsVisible?: (drawableIndex: number) => boolean;
  getDrawableDynamicFlagVertexPositionsDidChange?: (drawableIndex: number) => boolean;
  getModel?: () => {
    drawables?: {
      renderOrders?: ArrayLike<number>;
      drawOrders?: ArrayLike<number>;
      renderOrder?: ArrayLike<number>;
      drawOrder?: ArrayLike<number>;
      dynamicFlags?: ArrayLike<number>;
      opacities?: ArrayLike<number>;
      textureIndices?: ArrayLike<number>;
    };
  };
};

const MIN_USER_SCALE = 0.2;
const MAX_USER_SCALE = 4;
const DEFAULT_COVER = 1.02;
const SHRINK_PADDING = 0.96;
const MODEL_HIT_PADDING = 4;
const HIT_ALPHA_THRESHOLD = 12;

export class Live2DPlayer {
  private app: Application;
  private model: LoadedLive2DModel | null = null;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private baseFitScale = 1;
  private baseCenterOffsetX = 0;
  private baseCenterOffsetY = 0;
  private cubismCoreLoaded = false;
  private pixiInitialized = false;
  private cubismEngine: CubismEngineModule | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private lastPlacementLogAt = 0;

  private lastViewportWidth = 0;
  private lastViewportHeight = 0;
  private resizeRafId: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.app = new Application();
  }

  get currentModel(): LoadedLive2DModel | null {
    return this.model;
  }

  get currentScale(): number {
    return this.scale;
  }

  async loadModel(modelUrl: string, cubismCoreUrl: string): Promise<void> {
    await this.ensureCubismCore(cubismCoreUrl);
    const { Live2DModel } = await this.ensureCubismEngine();
    await this.initializePixi();
    await assertModelJson(modelUrl);

    if (this.model) {
      this.app.stage.removeChild(this.model);
      this.model.destroy({ children: true });
      this.model = null;
    }
    const model = await Live2DModel.from(modelUrl, {
      autoHitTest: false,
      autoFocus: false,
      ticker: this.app.ticker,
      useHighPrecisionMask: 'auto'
    }) as LoadedLive2DModel;

    this.applyCubismCore6DrawableCompatibility(model);
    this.model = model;
    this.app.stage.addChild(model);
    this.doResize();
    this.logModelMetadata();
  }

  setScale(scale: number): number {
    this.scale = Math.min(MAX_USER_SCALE, Math.max(MIN_USER_SCALE, scale));
    this.applyTransform();
    return this.scale;
  }

  zoomAt(clientX: number, clientY: number, deltaScale: number): number {
    if (!this.model || !this.app.renderer) {
      return this.scale;
    }

    const prevScale = this.scale;
    const newScale = Math.min(MAX_USER_SCALE, Math.max(MIN_USER_SCALE, this.scale * deltaScale));
    if (newScale === prevScale) {
      return this.scale;
    }

    const screen = this.app.screen;
    const screenWidth = screen.width || window.innerWidth || this.canvas.clientWidth;
    const screenHeight = screen.height || window.innerHeight || this.canvas.clientHeight;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = screenWidth / rect.width;
    const scaleY = screenHeight / rect.height;
    const localX = (clientX - rect.left) * scaleX;
    const localY = (clientY - rect.top) * scaleY;

    const centerX = screenWidth / 2 + this.baseCenterOffsetX;
    const centerY = screenHeight / 2 + this.baseCenterOffsetY;
    const modelCenterX = centerX + this.offsetX;
    const modelCenterY = centerY + this.offsetY;

    const scaleRatio = newScale / prevScale;
    this.offsetX = localX - (localX - modelCenterX) * scaleRatio - centerX;
    this.offsetY = localY - (localY - modelCenterY) * scaleRatio - centerY;
    this.scale = newScale;
    this.applyTransform();
    return this.scale;
  }

  pan(dx: number, dy: number): void {
    if (!this.model || !this.app.renderer) {
      return;
    }

    const screen = this.app.screen;
    const screenWidth = screen.width || window.innerWidth || this.canvas.clientWidth;
    const screenHeight = screen.height || window.innerHeight || this.canvas.clientHeight;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = screenWidth / rect.width;
    const scaleY = screenHeight / rect.height;

    this.offsetX += dx * scaleX;
    this.offsetY += dy * scaleY;
    this.applyTransform();
  }

  resetView(): void {
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.applyTransform();
  }

  resize(): void {
    if (this.resizeRafId !== null) {
      return;
    }
    this.resizeRafId = window.requestAnimationFrame(() => {
      this.resizeRafId = null;
      this.doResize();
    });
  }

  private doResize(): void {
    if (!this.app.renderer) {
      return;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (viewportWidth !== this.lastViewportWidth || viewportHeight !== this.lastViewportHeight) {
      console.info('Live2D viewport resize ' + JSON.stringify({
        oldWidth: this.lastViewportWidth,
        oldHeight: this.lastViewportHeight,
        newWidth: viewportWidth,
        newHeight: viewportHeight,
        screenWidth: this.app.screen.width,
        screenHeight: this.app.screen.height,
        canvasWidth: this.canvas.width,
        canvasHeight: this.canvas.height,
        devicePixelRatio: window.devicePixelRatio
      }));
    }

    if (viewportWidth === this.lastViewportWidth && viewportHeight === this.lastViewportHeight) {
      return;
    }
    this.lastViewportWidth = viewportWidth;
    this.lastViewportHeight = viewportHeight;

    this.recalcBaseFit();
    this.applyTransform();
  }

  containsPoint(clientX: number, clientY: number): boolean {
    if (!this.model || !this.gl) {
      return false;
    }

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const pixelX = (clientX - rect.left) * scaleX;
    const pixelY = (clientY - rect.top) * scaleY;

    const bounds = this.model.getBounds();
    const hitPadding = MODEL_HIT_PADDING * Math.max(scaleX, scaleY);
    if (pixelX < bounds.x - hitPadding ||
      pixelX > bounds.x + bounds.width + hitPadding ||
      pixelY < bounds.y - hitPadding ||
      pixelY > bounds.y + bounds.height + hitPadding) {
      return false;
    }

    const readPixelX = Math.floor(pixelX);
    const readPixelY = Math.floor(this.canvas.height - pixelY);
    if (readPixelX < 0 || readPixelX >= this.canvas.width || readPixelY < 0 || readPixelY >= this.canvas.height) {
      return false;
    }

    const pixel = new Uint8Array(4);
    this.gl.readPixels(readPixelX, readPixelY, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
    return pixel[3] > HIT_ALPHA_THRESHOLD;
  }

  private async initializePixi(): Promise<void> {
    if (this.pixiInitialized) {
      return;
    }

    await this.app.init({
      canvas: this.canvas,
      resizeTo: window,
      preference: 'webgl',
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      backgroundAlpha: 0,
      preserveDrawingBuffer: true
    });

    const gl = this.canvas.getContext('webgl') ?? this.canvas.getContext('webgl2');
    if (!gl) {
      throw new Error('WebGL initialization failed.');
    }

    this.gl = gl;
    this.pixiInitialized = true;
  }

  private async ensureCubismEngine(): Promise<CubismEngineModule> {
    if (this.cubismEngine) {
      return this.cubismEngine;
    }

    const engine = await import('untitled-pixi-live2d-engine/cubism');
    engine.configureCubismSDK({ memorySizeMB: 64 });
    extensions.add(engine.Live2DPlugin);
    this.cubismEngine = engine;
    return engine;
  }

  private fitModel(): void {
    this.recalcBaseFit();
    this.applyTransform();
  }

  private recalcBaseFit(): void {
    if (!this.model || !this.app.renderer) {
      return;
    }

    const screen = this.app.screen;
    const screenWidth = screen.width || window.innerWidth || this.canvas.clientWidth;
    const screenHeight = screen.height || window.innerHeight || this.canvas.clientHeight;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const modelWidth = this.model.internalModel?.width ?? this.model.internalModel?.originalWidth ?? this.model.width;
    const modelHeight = this.model.internalModel?.height ?? this.model.internalModel?.originalHeight ?? this.model.height;
    const baseScale = Math.min(screenWidth / modelWidth, screenHeight / modelHeight);
    let fitScale = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;

    this.model.anchor.set(0.5, 0.5);
    this.model.scale.set(fitScale);
    this.model.x = screenWidth / 2;
    this.model.y = screenHeight / 2;

    const bounds = this.model.getBounds();
    const boundsFitScale = this.scale < 1
      ? this.getBoundsContainScale(bounds, screenWidth, screenHeight)
      : this.getBoundsCoverScale(bounds, screenWidth, screenHeight);
    if (Number.isFinite(boundsFitScale) && boundsFitScale > 0) {
      fitScale *= boundsFitScale;
    }

    this.baseFitScale = fitScale;
    const nextScale = fitScale * this.scale;
    this.model.scale.set(nextScale);
    this.model.x = screenWidth / 2;
    this.model.y = screenHeight / 2;

    const finalBounds = this.model.getBounds();
    this.baseCenterOffsetX = screenWidth / 2 - (finalBounds.x + finalBounds.width / 2);
    this.baseCenterOffsetY = screenHeight / 2 - (finalBounds.y + finalBounds.height / 2);
  }

  private applyTransform(): void {
    if (!this.model || !this.app.renderer) {
      return;
    }

    const screen = this.app.screen;
    const screenWidth = screen.width || window.innerWidth || this.canvas.clientWidth;
    const screenHeight = screen.height || window.innerHeight || this.canvas.clientHeight;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const nextScale = this.baseFitScale * this.scale;
    this.model.scale.set(nextScale);
    this.model.x = screenWidth / 2 + this.baseCenterOffsetX + this.offsetX;
    this.model.y = screenHeight / 2 + this.baseCenterOffsetY + this.offsetY;
    this.logModelPlacement(nextScale);
  }

  private getBoundsContainScale(
    bounds: { width: number; height: number },
    screenWidth: number,
    screenHeight: number
  ): number {
    if (bounds.width <= 0 || bounds.height <= 0) {
      return 1;
    }

    return Math.min(
      (screenWidth * SHRINK_PADDING) / bounds.width,
      (screenHeight * SHRINK_PADDING) / bounds.height
    );
  }

  private getBoundsCoverScale(
    bounds: { width: number; height: number },
    screenWidth: number,
    screenHeight: number
  ): number {
    if (bounds.width <= 0 || bounds.height <= 0) {
      return 1;
    }

    return Math.max(
      (screenWidth * DEFAULT_COVER) / bounds.width,
      (screenHeight * DEFAULT_COVER) / bounds.height
    );
  }

  private async ensureCubismCore(cubismCoreUrl: string): Promise<void> {
    if (this.cubismCoreLoaded || window.Live2DCubismCore) {
      this.cubismCoreLoaded = true;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = cubismCoreUrl;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Cubism Core initialization failed. Missing file: ${cubismCoreUrl}`));
      document.head.appendChild(script);
    });

    if (!window.Live2DCubismCore) {
      throw new Error('Cubism Core initialization failed: Live2DCubismCore global was not found.');
    }

    this.cubismCoreLoaded = true;
  }

  private logModelMetadata(): void {
    if (!this.model) {
      return;
    }

    console.info('Live2D model metadata ' + JSON.stringify({
      internalWidth: this.model.internalModel?.width,
      internalHeight: this.model.internalModel?.height,
      originalWidth: this.model.internalModel?.originalWidth,
      originalHeight: this.model.internalModel?.originalHeight,
      childCount: this.model.children.length
    }));
  }

  private applyCubismCore6DrawableCompatibility(model: LoadedLive2DModel): void {
    const coreModel = (model.internalModel as { coreModel?: CoreModelLike } | undefined)?.coreModel;
    if (!coreModel?.getModel || !coreModel.getDrawableCount) {
      return;
    }

    const drawables = coreModel.getModel().drawables;
    if (!drawables) {
      return;
    }

    const drawableCount = coreModel.getDrawableCount();
    const currentRenderOrders = drawables.renderOrders ? Array.from(drawables.renderOrders) : [];
    const hasValidRenderRanks =
      currentRenderOrders.length === drawableCount &&
      new Set(currentRenderOrders).size === drawableCount &&
      currentRenderOrders.every((order) => Number.isInteger(order) && order >= 0 && order < drawableCount);

    if (!hasValidRenderRanks) {
      drawables.renderOrders = this.createRenderRanks(drawables.drawOrders ?? drawables.renderOrder ?? drawables.drawOrder, drawableCount);
    }

    const getDrawableRenderOrders = coreModel.getDrawableRenderOrders?.bind(coreModel);
    coreModel.getDrawableRenderOrders = () => getDrawableRenderOrders?.() ?? drawables.renderOrders;

    const getDrawableDynamicFlagIsVisible = coreModel.getDrawableDynamicFlagIsVisible?.bind(coreModel);
    const getDrawableDynamicFlagVertexPositionsDidChange = coreModel.getDrawableDynamicFlagVertexPositionsDidChange?.bind(coreModel);
    let visibleCount = 0;

    for (let index = 0; index < drawableCount; index++) {
      if (getDrawableDynamicFlagIsVisible?.(index)) {
        visibleCount++;
      }
    }

    coreModel.getDrawableDynamicFlagIsVisible = (drawableIndex: number) => {
      return visibleCount === 0 ? true : Boolean(getDrawableDynamicFlagIsVisible?.(drawableIndex));
    };

    coreModel.getDrawableDynamicFlagVertexPositionsDidChange = (drawableIndex: number) => {
      return getDrawableDynamicFlagVertexPositionsDidChange?.(drawableIndex) ?? true;
    };

    const opacities = Array.from(drawables.opacities ?? []);
    const opacityPositiveCount = opacities.filter((opacity) => opacity > 0.001).length;
    const opacityMax = opacities.length > 0 ? Math.max(...opacities) : null;
    const opacityMin = opacities.length > 0 ? Math.min(...opacities) : null;
    const textureIndices = Array.from(drawables.textureIndices ?? []);

    console.info('Live2D drawable compatibility ' + JSON.stringify({
      drawableCount,
      visibleCount,
      hasDynamicFlags: Boolean(drawables.dynamicFlags),
      firstDynamicFlags: Array.from(drawables.dynamicFlags ?? []).slice(0, 8),
      firstOpacities: opacities.slice(0, 8),
      opacityMin,
      opacityMax,
      opacityPositiveCount,
      firstTextureIndices: textureIndices.slice(0, 8),
      textureIndexMin: textureIndices.length > 0 ? Math.min(...textureIndices) : null,
      textureIndexMax: textureIndices.length > 0 ? Math.max(...textureIndices) : null,
      firstRenderOrders: Array.from(drawables.renderOrders ?? []).slice(0, 8)
    }));
  }

  private createRenderRanks(drawOrders: ArrayLike<number> | undefined, drawableCount: number): Int32Array {
    const sortedDrawableIndices = Array.from({ length: drawableCount }, (_, index) => index).sort((left, right) => {
      const leftOrder = drawOrders?.[left] ?? left;
      const rightOrder = drawOrders?.[right] ?? right;
      return leftOrder === rightOrder ? left - right : leftOrder - rightOrder;
    });

    const renderRanks = new Int32Array(drawableCount);
    sortedDrawableIndices.forEach((drawableIndex, rank) => {
      renderRanks[drawableIndex] = rank;
    });
    return renderRanks;
  }

  private logModelPlacement(nextScale: number): void {
    if (!this.model || !this.app.renderer) {
      return;
    }

    const now = Date.now();
    if (now - this.lastPlacementLogAt < 1500) {
      return;
    }
    this.lastPlacementLogAt = now;

    const bounds = this.model.getBounds();
    console.info('Live2D model placement ' + JSON.stringify({
      rendererWidth: this.app.renderer.width,
      rendererHeight: this.app.renderer.height,
      modelWidth: this.model.width,
      modelHeight: this.model.height,
      internalWidth: this.model.internalModel?.width,
      internalHeight: this.model.internalModel?.height,
      originalWidth: this.model.internalModel?.originalWidth,
      originalHeight: this.model.internalModel?.originalHeight,
      scale: nextScale,
      x: this.model.x,
      y: this.model.y,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      }
    }));
  }
}
```

---

## 3. BrowserWindow 创建代码

```typescript
import { BrowserWindow, app, ipcMain, protocol, screen } from 'electron';
import { extname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitEvent } from './stdioProtocol';
import { log } from './logger';
import type { HostCommand, RendererEvent } from './protocolTypes';

let mainWindow: BrowserWindow | null = null;
let dragState: { startScreenX: number; startScreenY: number; startX: number; startY: number } | null = null;

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

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.center();
    mainWindow?.showInactive();
    log('Window created successfully');
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

  ipcMain.handle('drag-start', (_event, point: { screenX: number; screenY: number }) => {
    if (!mainWindow) {
      return;
    }
    const bounds = mainWindow.getBounds();
    dragState = {
      startScreenX: point.screenX,
      startScreenY: point.screenY,
      startX: bounds.x,
      startY: bounds.y
    };
  });

  ipcMain.handle('drag-move', (_event, point: { screenX: number; screenY: number }) => {
    if (!mainWindow || !dragState) {
      return;
    }

    const x = Math.round(dragState.startX + point.screenX - dragState.startScreenX);
    const y = Math.round(dragState.startY + point.screenY - dragState.startScreenY);
    mainWindow.setPosition(x, y, false);
  });

  ipcMain.handle('drag-end', () => {
    if (!mainWindow) {
      dragState = null;
      return;
    }
    const [x, y] = mainWindow.getPosition();
    dragState = null;
    emitEvent({ type: 'WindowMoved', x, y });
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
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
    return toLive2DFileUrl(resolve(base, 'vendor', 'CubismSdkForWeb', 'Core', 'live2dcubismcore.min.js'));
  });

  ipcMain.handle('get-display', () => {
    return screen.getPrimaryDisplay().scaleFactor;
  });
}
```

---

## 4. preload.ts

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import type { HostCommand, RendererEvent } from '../main/protocolTypes';

export type RendererApi = {
  onHostCommand: (callback: (command: HostCommand) => void) => () => void;
  emitEvent: (event: RendererEvent) => Promise<void>;
  dragStart: (screenX: number, screenY: number) => Promise<void>;
  dragMove: (screenX: number, screenY: number) => Promise<void>;
  dragEnd: () => Promise<void>;
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => Promise<void>;
  resolveModelUrl: (modelPath: string) => Promise<string>;
  getCubismCoreUrl: () => Promise<string>;
};

const api: RendererApi = {
  onHostCommand(callback) {
    const listener = (_event: Electron.IpcRendererEvent, command: HostCommand) => callback(command);
    ipcRenderer.on('host-command', listener);
    return () => ipcRenderer.off('host-command', listener);
  },
  emitEvent(event) {
    return ipcRenderer.invoke('renderer-event', event);
  },
  dragStart(screenX, screenY) {
    return ipcRenderer.invoke('drag-start', { screenX, screenY });
  },
  dragMove(screenX, screenY) {
    return ipcRenderer.invoke('drag-move', { screenX, screenY });
  },
  dragEnd() {
    return ipcRenderer.invoke('drag-end');
  },
  setIgnoreMouseEvents(ignore, options) {
    return ipcRenderer.invoke('set-ignore-mouse-events', { ignore, options });
  },
  resolveModelUrl(modelPath) {
    return ipcRenderer.invoke('resolve-model-url', modelPath);
  },
  getCubismCoreUrl() {
    return ipcRenderer.invoke('get-cubism-core-url');
  }
};

contextBridge.exposeInMainWorld('live2dRenderer', api);
```

---

## 5. CSS

```css
html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent;
}

body {
  user-select: none;
  -webkit-user-select: none;
}

#app {
  position: relative;
}

#live2d-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  background: transparent;
  cursor: grab;
}

#live2d-canvas:active {
  cursor: grabbing;
}

#status {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: none;
  padding: 8px 10px;
  border: 1px solid rgb(255 255 255 / 20%);
  border-radius: 6px;
  color: white;
  background: rgb(20 24 30 / 72%);
  font: 12px/1.4 system-ui, "Segoe UI", sans-serif;
  pointer-events: none;
}

#status.is-visible {
  display: block;
}
```

---

## 6. 版本号

```json
{
  "dependencies": {
    "@pixi/sound": "^6.0.1",
    "@pixi/unsafe-eval": "^7.4.3",
    "pixi.js": "^8.19.0",
    "untitled-pixi-live2d-engine": "^1.2.2"
  },
  "devDependencies": {
    "electron": "^37.2.0",
    "electron-builder": "^26.0.12",
    "electron-vite": "^4.0.0"
  }
}
```

---

## 7. 运行日志检查点

拖动时如果控制台反复出现以下日志，说明 `resize` → `recalcBaseFit` 被持续触发：

```
Live2D viewport resize {"oldWidth":720,"oldHeight":900,"newWidth":720,"newHeight":900,...}
```

如果出现，说明 `window.innerWidth/Height` 或 `app.screen.width/height` 在持续变化。
