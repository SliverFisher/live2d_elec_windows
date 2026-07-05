import { Application, Container, Ticker } from 'pixi.js';
import type { Live2DModel as Live2DModelType } from 'pixi-live2d-display-lipsyncpatch/cubism4';
import { assertModelJson } from './modelLoader';

let Live2DModel: typeof Live2DModelType | null = null;

type LoadedLive2DModel = Container & {
  width: number;
  height: number;
  x: number;
  y: number;
  scale: { set: (x: number, y?: number) => void; x: number; y: number };
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
  expression: (name: string | number) => void;
};

const MIN_USER_SCALE = 0.2;
const MAX_USER_SCALE = 4;
const MODEL_HIT_PADDING = 4;
const HIT_ALPHA_THRESHOLD = 12;
const INITIAL_WINDOW_PADDING = 24;

export class Live2DPlayer {
  private app: Application;
  private model: LoadedLive2DModel | null = null;
  private live2dModel: Live2DModelType | null = null;
  private userScale = 1;
  private baseFitScale = 1;
  private baseModelWidth = 0;
  private baseModelHeight = 0;
  private cubismCoreLoaded = false;
  private pixiInitialized = false;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private lastPlacementLogAt = 0;
  private baseFitCalculated = false;
  private canvasWidth = 0;
  private canvasHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.app = null as unknown as Application;
  }

  get currentModel(): LoadedLive2DModel | null {
    return this.model;
  }

  get currentScale(): number {
    return this.userScale;
  }

  /**
   * Compute the current model geometry in window-relative DIP coordinates
   * (Pixi stage coords == window DIP coords because autoDensity + resolution
   * = devicePixelRatio). Main process adds window bounds to convert these
   * to screenDip before sending to AI_maid.
   *
   * Returns null if no model is loaded or bounds are unavailable.
   */
  getModelGeometry(): {
    modelBounds: { x: number; y: number; width: number; height: number };
    anchors: {
      modelCenter: { x: number; y: number };
      headTop: { x: number; y: number };
      faceCenter: { x: number; y: number };
      bodyCenter: { x: number; y: number };
      feetCenter: { x: number; y: number };
    };
    parts: Array<{
      id: string;
      name: string;
      visible: boolean;
      bounds: { x: number; y: number; width: number; height: number };
      anchor: { x: number; y: number };
    }>;
    scale: number;
  } | null {
    if (!this.model) {
      return null;
    }

    let bounds: { x: number; y: number; width: number; height: number };
    try {
      bounds = this.model.getBounds();
    } catch {
      return null;
    }

    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
        bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }

    const centerX = bounds.x + bounds.width / 2;
    const topY = bounds.y;
    const bottomY = bounds.y + bounds.height;

    const anchors = {
      modelCenter: { x: centerX, y: bounds.y + bounds.height / 2 },
      headTop: { x: centerX, y: topY },
      faceCenter: { x: centerX, y: bounds.y + bounds.height * 0.15 },
      bodyCenter: { x: centerX, y: bounds.y + bounds.height * 0.5 },
      feetCenter: { x: centerX, y: bottomY }
    };

    // Body part regions based on the existing resolveBodyPart normalizedY
    // thresholds (head < 0.28, face < 0.45, body < 0.75, leg otherwise).
    // Live has no explicit body part config — derive from model bounds.
    const headEnd = bounds.y + bounds.height * 0.28;
    const faceEnd = bounds.y + bounds.height * 0.45;
    const bodyEnd = bounds.y + bounds.height * 0.75;

    const makePart = (
      id: string,
      name: string,
      yStart: number,
      yEnd: number
    ) => {
      const partBounds = {
        x: bounds.x,
        y: yStart,
        width: bounds.width,
        height: yEnd - yStart
      };
      return {
        id,
        name,
        visible: true,
        bounds: partBounds,
        anchor: { x: centerX, y: yStart + (yEnd - yStart) / 2 }
      };
    };

    const parts = [
      makePart('head', '头部', topY, headEnd),
      makePart('face', '脸部', headEnd, faceEnd),
      makePart('body', '身体', faceEnd, bodyEnd),
      makePart('leg', '腿部', bodyEnd, bottomY)
    ];

    return {
      modelBounds: bounds,
      anchors,
      parts,
      scale: this.userScale
    };
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
    console.info('[Live2D] ' + JSON.stringify({
      event: 'loadModel_start',
      modelUrl,
      cubismCoreUrl
    }));

    await this.ensureCubismCore(cubismCoreUrl);
    await this.initializePixi();

    const modelJsonResponse = await fetch(modelUrl);
    const modelJson = await modelJsonResponse.json();

    console.info('[Live2D] Version info: ' + JSON.stringify({
      pixiVersion: (Application as any).VERSION || (window as any).PIXI?.VERSION || 'unknown',
      engine: 'pixi-live2d-display-lipsyncpatch',
      cubismCoreVersion: (window as any).Live2DCubismCore?.Version?.csmGetVersion?.() ?? 'unknown',
      modelJsonVersion: modelJson.Version,
      modelUrl,
      mocFile: modelJson.FileReferences?.Moc,
      textureFiles: modelJson.FileReferences?.Textures,
      physicsFile: modelJson.FileReferences?.Physics,
      poseFile: modelJson.FileReferences?.Pose
    }));

    await assertModelJson(modelUrl);

    if (this.model) {
      this.app.stage.removeChild(this.model);
      this.model.destroy({ children: true });
      this.model = null;
      this.live2dModel = null;
    }

    this.baseFitCalculated = false;
    this.userScale = 1;

    const live2dModel = await Live2DModel!.from(modelUrl, {
      ticker: this.app.ticker
    });

    this.live2dModel = live2dModel;
    this.app.stage.addChild(live2dModel);

    const anyLive2dModel = live2dModel as any;
    const internalModel = anyLive2dModel.internalModel;

    console.info('[Live2D] Model loaded: ' + JSON.stringify({
      hasInternalModel: !!internalModel,
      hasCoreModel: !!internalModel?.coreModel,
      textureCount: (live2dModel as any).textures?.length ?? 0,
      texturesValid: (live2dModel as any).textures?.map((t: any) => t?.valid ?? false),
      cubismCoreVersion: (window as any).Live2DCubismCore?.Version?.csmGetVersion?.() ?? 'unknown'
    }));

    this.ensureEnoughMaskRenderTextures(internalModel);

    const originalWidth = (live2dModel as any).internalModel?.width || live2dModel.width || 0;
    const originalHeight = (live2dModel as any).internalModel?.height || live2dModel.height || 0;

    console.info('[Live2D] Model state after load: ' + JSON.stringify({
      modelWidth: live2dModel.width,
      modelHeight: live2dModel.height,
      modelX: live2dModel.x,
      modelY: live2dModel.y,
      modelScaleX: live2dModel.scale.x,
      modelScaleY: live2dModel.scale.y,
      modelVisible: live2dModel.visible,
      modelAlpha: live2dModel.alpha,
      internalWidth: originalWidth,
      internalHeight: originalHeight,
      bounds: live2dModel.getBounds()
    }));

    const wrappedModel = this.wrapModel(live2dModel, originalWidth, originalHeight);
    this.model = wrappedModel;

    this.dumpModelInfo(modelJson, originalWidth, originalHeight);
    this.calcBaseFit(originalWidth, originalHeight);
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

  /**
   * Returns the names of hit areas that contain the given client-space point.
   * Returns an empty array if the model has no hit areas or hit testing fails.
   * Uses the underlying pixi-live2d-display hitTest API (model-local coords).
   */
  hitTest(clientX: number, clientY: number): string[] {
    if (!this.live2dModel) {
      return [];
    }

    try {
      const point = this.clientToPixiPoint(clientX, clientY);
      // pixi-live2d-display hitTest expects model-local coordinates,
      // which are the same as Pixi stage coordinates since the model is on the stage.
      const hitFn = (this.live2dModel as any).hitTest;
      if (typeof hitFn !== 'function') {
        return [];
      }
      const result = hitFn.call(this.live2dModel, point.x, point.y);
      return Array.isArray(result) ? result.filter((n: unknown) => typeof n === 'string') : [];
    } catch (e) {
      console.warn('[Live2DPlayer] hitTest failed', e);
      return [];
    }
  }

  private ensureEnoughMaskRenderTextures(internalModel: any): void {
    const renderer = internalModel?.renderer;
    const coreModel = internalModel?.coreModel;
    if (!renderer || !coreModel) {
      return;
    }

    const drawableCount = coreModel.getDrawableCount?.() ?? 0;
    if (drawableCount <= 0) {
      return;
    }

    let totalClips = 0;
    const clipIdSets: Set<string> = new Set();
    for (let i = 0; i < drawableCount; i++) {
      const maskCount = coreModel.getDrawableMaskCounts?.(i) ?? 0;
      if (maskCount > 0) {
        const masks = coreModel.getDrawableMasks?.(i);
        if (masks) {
          const key = Array.from(masks).slice(0, maskCount).sort().join(',');
          clipIdSets.add(key);
        }
        totalClips++;
      }
    }

    const clipGroupCount = clipIdSets.size || totalClips;
    const currentCount = renderer.getRenderTextureCount?.() ?? 1;
    const defaultMax = 36;
    const perExtra = 32;
    let neededCount = 1;
    if (clipGroupCount > defaultMax) {
      neededCount = Math.ceil((clipGroupCount - defaultMax) / perExtra) + 1;
    }

    console.info('[Live2D] Mask stats: ' + JSON.stringify({
      drawableCount,
      totalMaskedDrawables: totalClips,
      uniqueClipGroups: clipIdSets.size,
      currentRenderTextureCount: currentCount,
      neededRenderTextureCount: neededCount
    }));

    if (neededCount > currentCount && typeof renderer.initialize === 'function') {
      console.info('[Live2D] Re-initializing renderer with maskBufferCount = ' + neededCount);
      try {
        const oldTextures = renderer._textures;
        renderer.initialize(coreModel, neededCount);
        if (oldTextures) {
          for (let i = 0; i < oldTextures.length; i++) {
            if (oldTextures[i]) {
              renderer.bindTexture(i, oldTextures[i]);
            }
          }
        }
        console.info('[Live2D] Renderer re-initialized successfully');
      } catch (e) {
        console.error('[Live2D] Failed to re-initialize renderer:', e);
      }
    }
  }

  private wrapModel(live2dModel: Live2DModelType, originalWidth: number, originalHeight: number): LoadedLive2DModel {
    const model = live2dModel as unknown as LoadedLive2DModel;

    const originalMotion = (live2dModel as any).motion;
    model.motion = async (group: string, index?: number) => {
      return originalMotion.call(live2dModel, group, index ?? 0, 2);
    };

    const originalExpression = (live2dModel as any).expression;
    model.expression = (name: string | number) => {
      void originalExpression.call(live2dModel, name);
    };

    return model;
  }

  private async initializePixi(): Promise<void> {
    if (this.pixiInitialized) {
      return;
    }

    Live2DModel!.registerTicker(Ticker);

    this.app = new Application({
      view: this.canvas as HTMLCanvasElement,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
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

  private calcBaseFit(originalWidth: number, originalHeight: number): void {
    if (this.baseFitCalculated) {
      return;
    }

    const screenWidth = this.canvasWidth || window.innerWidth;
    const screenHeight = this.canvasHeight || window.innerHeight;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    if (this.live2dModel) {
      this.live2dModel.anchor.set(0.5, 0.5);
      this.live2dModel.x = screenWidth / 2;
      this.live2dModel.y = screenHeight / 2;
    }

    if (originalWidth > 0 && originalHeight > 0) {
      this.baseModelWidth = originalWidth;
      this.baseModelHeight = originalHeight;
      const baseScale = Math.min(screenWidth / originalWidth, screenHeight / originalHeight);
      this.baseFitScale = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
    } else if (this.live2dModel) {
      const bounds = this.live2dModel.getBounds();
      if (bounds) {
        this.baseModelWidth = bounds.width;
        this.baseModelHeight = bounds.height;
        const baseScale = Math.min(screenWidth / bounds.width, screenHeight / bounds.height);
        this.baseFitScale = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
      }
    }

    if (this.live2dModel) {
      this.live2dModel.scale.set(this.baseFitScale * this.userScale);
    }
    this.baseFitCalculated = true;
  }

  private applyTransform(source: string): void {
    if (!this.live2dModel || !this.app.renderer) {
      return;
    }

    const screenWidth = this.canvasWidth || window.innerWidth;
    const screenHeight = this.canvasHeight || window.innerHeight;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const nextScale = this.baseFitScale * this.userScale;
    this.live2dModel.scale.set(nextScale);
    this.live2dModel.x = screenWidth / 2;
    this.live2dModel.y = screenHeight / 2;

    this.logModelPlacement(nextScale);
  }

  private async ensureCubismCore(cubismCoreUrl: string): Promise<void> {
    if (this.cubismCoreLoaded || (window as any).Live2DCubismCore) {
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

    if (!(window as any).Live2DCubismCore) {
      throw new Error('Cubism Core initialization failed: Live2DCubismCore global was not found.');
    }

    const module = await import('pixi-live2d-display-lipsyncpatch/cubism4');
    Live2DModel = module.Live2DModel;

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
    console.info('[Live2D] Model placement ' + JSON.stringify({
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

  private dumpModelInfo(modelJson: any, originalWidth: number, originalHeight: number): void {
    console.info('[Live2D] Model info: ' + JSON.stringify({
      engine: 'pixi-live2d-display-lipsyncpatch (Cubism 4)',
      modelWidth: originalWidth,
      modelHeight: originalHeight,
      textureCount: modelJson?.FileReferences?.Textures?.length,
      hasPhysics: !!modelJson?.FileReferences?.Physics,
      hasPose: !!modelJson?.FileReferences?.Pose
    }));
  }
}
