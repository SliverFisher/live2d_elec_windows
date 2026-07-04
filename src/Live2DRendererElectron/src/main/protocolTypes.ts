export type HostCommand =
  | { type: 'LoadModel'; modelPath: string }
  | { type: 'Show' }
  | { type: 'Hide' }
  | { type: 'Close' }
  | { type: 'SetScale'; scale: number }
  | { type: 'SetPosition'; x: number; y: number }
  | { type: 'PlayMotion'; group: string; index?: number }
  | { type: 'SetExpression'; name: string };

export type RendererEvent =
  | { type: 'RendererReady' }
  | { type: 'ModelLoaded'; modelPath: string }
  | { type: 'ModelLoadFailed'; message: string }
  | { type: 'WindowMoved'; x: number; y: number }
  | { type: 'ScaleChanged'; scale: number }
  | { type: 'RightClick' }
  | { type: 'Click' }
  | { type: 'Closed' }
  | { type: 'Error'; message: string };
