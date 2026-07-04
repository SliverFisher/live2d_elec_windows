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
const MODEL_HIT_PADDING = 4;
const HIT_ALPHA_THRESHOLD = 12;
const INITIAL_WINDOW_PADDING = 24;

export class Live2DPlayer {
  private app: Application;
  private model: LoadedLive2DModel | null = null;
  private userScale = 1;
  private baseFitScale = 1;
  private baseModelWidth = 0;
  private baseModelHeight = 0;
  private cubismCoreLoaded = false;
  private pixiInitialized = false;
  private cubismEngine: CubismEngineModule | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private lastPlacementLogAt = 0;
  private baseFitCalculated = false;
  private canvasWidth = 0;
  private canvasHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.app = new Application();
  }

  get currentModel(): LoadedLive2DModel | null {
    return this.model;
  }

  get currentScale(): number {
    return this.userScale;
  }

  clientToPixiPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const screenWidth = this.canvasWidth || window.innerWidth || this.canvas.clientWidth;
    const screenHeight = this.canvasHeight || window.innerHeight || this.canvas.clientHeight;
    return {
      x: (clientX - rect.left) * (screenWidth / rect.width),
      y: (clientY - rect.top) * (screenHeight / rect.height)
    };
  }

  getFittedWindowSize(): { width: number; height: number } {
    if (this.baseModelWidth <= 0 || this.baseModelHeight <= 0) {
      return {
        width: window.innerWidth,
        height: window.innerHeight
      };
    }
    const scaledWidth = this.baseModelWidth * this.baseFitScale * this.userScale + INITIAL_WINDOW_PADDING * 2;
    const scaledHeight = this.baseModelHeight * this.baseFitScale * this.userScale + INITIAL_WINDOW_PADDING * 2;
    return {
      width: Math.max(160, Math.round(scaledWidth)),
      height: Math.max(160, Math.round(scaledHeight))
    };
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

    this.baseFitCalculated = false;
    this.userScale = 1;

    const model = await Live2DModel.from(modelUrl, {
      autoHitTest: false,
      autoFocus: false,
      ticker: this.app.ticker,
      useHighPrecisionMask: 'auto'
    }) as LoadedLive2DModel;

    this.model = model;
    this.app.stage.addChild(model);
    this.applyCubismCore6DrawableCompatibility(model);
    this.calcBaseFit();
    this.applyTransform('loadModel');
  }

  setUserScale(scale: number): number {
    this.userScale = Math.min(MAX_USER_SCALE, Math.max(MIN_USER_SCALE, scale));
    this.applyTransform('setUserScale');
    return this.userScale;
  }

  handleWindowResize(): void {
    if (!this.model || !this.app.renderer) {
      return;
    }

    const newWidth = window.innerWidth;
    const newHeight = window.innerHeight;

    if (Math.abs(newWidth - this.canvasWidth) < 1 && Math.abs(newHeight - this.canvasHeight) < 1) {
      return;
    }

    this.canvasWidth = newWidth;
    this.canvasHeight = newHeight;
    this.app.renderer.resize(newWidth, newHeight);
    this.applyTransform('handleWindowResize');
  }

  containsPoint(clientX: number, clientY: number): boolean {
    if (!this.model || !this.gl) {
      return false;
    }

    const point = this.clientToPixiPoint(clientX, clientY);
    const bounds = this.model.getBounds();
    const hitPadding = MODEL_HIT_PADDING;
    const boundsHit = point.x >= bounds.x - hitPadding &&
      point.x <= bounds.x + bounds.width + hitPadding &&
      point.y >= bounds.y - hitPadding &&
      point.y <= bounds.y + bounds.height + hitPadding;

    if (!boundsHit) {
      return false;
    }

    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const pixelX = Math.floor((clientX - rect.left) * scaleX);
    const pixelY = Math.floor(this.canvas.height - (clientY - rect.top) * scaleY);

    if (pixelX < 0 || pixelX >= this.canvas.width || pixelY < 0 || pixelY >= this.canvas.height) {
      return false;
    }

    const pixel = new Uint8Array(4);
    this.gl.readPixels(pixelX, pixelY, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
    return pixel[3] > HIT_ALPHA_THRESHOLD;
  }

  private async initializePixi(): Promise<void> {
    if (this.pixiInitialized) {
      return;
    }

    await this.app.init({
      canvas: this.canvas,
      preference: 'webgl',
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      backgroundAlpha: 0,
      preserveDrawingBuffer: true
    });

    this.canvasWidth = window.innerWidth;
    this.canvasHeight = window.innerHeight;
    this.app.renderer.resize(this.canvasWidth, this.canvasHeight);

    const gl = this.canvas.getContext('webgl') ?? this.canvas.getContext('webgl2');
    if (!gl) {
      throw new Error('WebGL initialization failed.');
    }

    this.gl = gl;
    this.pixiInitialized = true;

    window.addEventListener('resize', () => {
      this.handleWindowResize();
    });
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

  private calcBaseFit(): void {
    if (!this.model || !this.app.renderer || this.baseFitCalculated) {
      return;
    }

    const screenWidth = this.canvasWidth || window.innerWidth;
    const screenHeight = this.canvasHeight || window.innerHeight;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const originalWidth = this.model.internalModel?.originalWidth ?? this.model.internalModel?.width ?? 0;
    const originalHeight = this.model.internalModel?.originalHeight ?? this.model.internalModel?.height ?? 0;

    this.model.anchor.set(0.5, 0.5);
    this.model.x = screenWidth / 2;
    this.model.y = screenHeight / 2;

    if (originalWidth > 0 && originalHeight > 0) {
      this.baseModelWidth = originalWidth;
      this.baseModelHeight = originalHeight;
      const baseScale = Math.min(screenWidth / originalWidth, screenHeight / originalHeight);
      this.baseFitScale = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
    } else {
      this.model.scale.set(1);
      const bounds = this.model.getBounds();
      this.baseModelWidth = bounds.width;
      this.baseModelHeight = bounds.height;
      const baseScale = Math.min(screenWidth / bounds.width, screenHeight / bounds.height);
      this.baseFitScale = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
    }

    this.model.scale.set(this.baseFitScale * this.userScale);
    this.baseFitCalculated = true;
  }

  private applyTransform(source: string): void {
    if (!this.model || !this.app.renderer) {
      return;
    }

    const screenWidth = this.canvasWidth || window.innerWidth;
    const screenHeight = this.canvasHeight || window.innerHeight;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const nextScale = this.baseFitScale * this.userScale;
    this.model.scale.set(nextScale);
    this.model.x = screenWidth / 2;
    this.model.y = screenHeight / 2;

    this.logModelPlacement(nextScale);
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
}
