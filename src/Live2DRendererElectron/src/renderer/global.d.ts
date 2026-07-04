import type { RendererApi } from '../preload/preload';

declare global {
  interface Window {
    live2dRenderer: RendererApi;
    PIXI: unknown;
    Live2DCubismCore?: unknown;
  }
}

export {};
