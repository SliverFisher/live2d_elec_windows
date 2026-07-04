# 拖动和缩放问题代码

## 一、renderer.ts

### 1.1 状态变量

```typescript
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
```

### 1.2 pointerdown

```typescript
canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 2) {
    if (!player.containsPoint(event.clientX, event.clientY)) return;
    setTransparentInputIgnored(false);
    movedDuringPointer = false;
    dragPointerId = event.pointerId;
    dragStartPoint = { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  if (!player.containsPoint(event.clientX, event.clientY)) return;
  setTransparentInputIgnored(false);
  panPointerId = event.pointerId;
  panStartPoint = { clientX: event.clientX, clientY: event.clientY };
  panning = false;
  canvas.setPointerCapture(event.pointerId);
});
```

### 1.3 pointermove

```typescript
canvas.addEventListener('pointermove', (event) => {
  updateTransparentInput(event.clientX, event.clientY);
  if (dragPointerId === event.pointerId && dragStartPoint) {
    const movedDistance = Math.hypot(event.clientX - dragStartPoint.clientX, event.clientY - dragStartPoint.clientY);
    if (!movedDuringPointer && movedDistance < DRAG_START_DISTANCE) return;
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
    if (!panning && movedDistance < DRAG_START_DISTANCE) return;
    if (!panning) panning = true;
    if (Math.abs(dx) < PAN_JITTER_THRESHOLD && Math.abs(dy) < PAN_JITTER_THRESHOLD) return;
    player.pan(dx, dy);
    panStartPoint = { clientX: event.clientX, clientY: event.clientY };
  }
});
```

### 1.4 pointerup

```typescript
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
    if (movedDuringPointer) void window.live2dRenderer.dragEnd();
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
```

### 1.5 wheel

```typescript
canvas.addEventListener('wheel', (event) => {
  if (!player.containsPoint(event.clientX, event.clientY)) return;
  event.preventDefault();
  const zoomFactor = event.deltaY > 0 ? 0.92 : 1.08;
  const scale = player.zoomAt(event.clientX, event.clientY, zoomFactor);
  if (scaleReportTimer !== null) window.clearTimeout(scaleReportTimer);
  scaleReportTimer = window.setTimeout(() => {
    void window.live2dRenderer.emitEvent({ type: 'ScaleChanged', scale });
  }, 120);
}, { passive: false });
```

### 1.6 updateTransparentInput

```typescript
function updateTransparentInput(clientX: number, clientY: number): void {
  if (dragPointerId !== null || panPointerId !== null) return;
  setTransparentInputIgnored(!player.containsPoint(clientX, clientY));
}

function setTransparentInputIgnored(ignore: boolean): void {
  if (ignore === ignoringTransparentInput) return;
  ignoringTransparentInput = ignore;
  void window.live2dRenderer.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
}
```

### 1.7 window resize

```typescript
window.addEventListener('resize', () => {
  window.requestAnimationFrame(() => player.resize());
});
```

---

## 二、Live2DPlayer.ts

### 2.1 状态变量

```typescript
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
```

### 2.2 pan

```typescript
pan(dx: number, dy: number): void {
  if (!this.model || !this.app.renderer) return;
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
```

### 2.3 zoomAt

```typescript
zoomAt(clientX: number, clientY: number, deltaScale: number): number {
  if (!this.model || !this.app.renderer) return this.scale;
  const prevScale = this.scale;
  const newScale = Math.min(MAX_USER_SCALE, Math.max(MIN_USER_SCALE, this.scale * deltaScale));
  if (newScale === prevScale) return this.scale;
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
```

### 2.4 applyTransform

```typescript
private applyTransform(): void {
  if (!this.model || !this.app.renderer) return;
  const screen = this.app.screen;
  const screenWidth = screen.width || window.innerWidth || this.canvas.clientWidth;
  const screenHeight = screen.height || window.innerHeight || this.canvas.clientHeight;
  if (screenWidth <= 0 || screenHeight <= 0) return;
  const nextScale = this.baseFitScale * this.scale;
  this.model.scale.set(nextScale);
  this.model.x = screenWidth / 2 + this.baseCenterOffsetX + this.offsetX;
  this.model.y = screenHeight / 2 + this.baseCenterOffsetY + this.offsetY;
  this.logModelPlacement(nextScale);
}
```

### 2.5 recalcBaseFit

```typescript
private recalcBaseFit(): void {
  if (!this.model || !this.app.renderer) return;
  const screen = this.app.screen;
  const screenWidth = screen.width || window.innerWidth || this.canvas.clientWidth;
  const screenHeight = screen.height || window.innerHeight || this.canvas.clientHeight;
  if (screenWidth <= 0 || screenHeight <= 0) return;
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
```

### 2.6 resize

```typescript
resize(): void {
  if (this.resizeRafId !== null) return;
  this.resizeRafId = window.requestAnimationFrame(() => {
    this.resizeRafId = null;
    this.doResize();
  });
}

private doResize(): void {
  if (!this.app.renderer) return;
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
```

### 2.7 containsPoint

```typescript
containsPoint(clientX: number, clientY: number): boolean {
  if (!this.model || !this.gl) return false;
  const rect = this.canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
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
```

### 2.8 loadModel

```typescript
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
```

### 2.9 initializePixi

```typescript
private async initializePixi(): Promise<void> {
  if (this.pixiInitialized) return;
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
  if (!gl) throw new Error('WebGL initialization failed.');
  this.gl = gl;
  this.pixiInitialized = true;
}
```
