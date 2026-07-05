// ============================================================
// External protocol types (Named Pipe JSON Lines envelope)
// ============================================================

/**
 * Envelope structure. The payload does NOT carry a redundant `type` field —
 * the outer `type` is the single source of truth for the message kind.
 */
export type Envelope<T extends { type: string }> = {
  type: T['type'];
  requestId: string | null;
  timestamp: string;
  payload: Omit<T, 'type'>;
};

// ============================================================
// Commands: AI_maid → Live
// ============================================================

export type AiMaidCommand =
  | { type: 'Init'; protocolVersion: number; appName: string; parentPid?: number }
  | {
      type: 'LoadModel';
      roleId?: string;
      roleName?: string;
      modelPath: string;
      initialTransform?: { x?: number; y?: number; scale?: number };
    }
  | { type: 'Show' }
  | { type: 'Hide' }
  | { type: 'Close'; reason?: string }
  | { type: 'SetTransform'; x: number; y: number; scale: number }
  | {
      type: 'PlayMotion';
      group: string;
      index?: number;
      priority?: string;
      fallbackAction?: string;
    }
  | { type: 'SetExpression'; name: string; durationMs?: number }
  | { type: 'SetActionTag'; actionTag: string; source?: string; durationMs?: number }
  | {
      type: 'SpeakStart';
      text?: string;
      voiceId?: string;
      estimatedDurationMs?: number;
    }
  | { type: 'SpeakStop'; reason?: string }
  | { type: 'SetClickThrough'; enabled: boolean };

// ============================================================
// Events: Live → AI_maid
// ============================================================

export type RendererEventPayload =
  | { type: 'RendererReady'; protocolVersion: number; rendererVersion: string }
  | { type: 'InitAck'; ok: boolean }
  | { type: 'ModelLoaded'; roleId?: string; modelPath: string }
  | { type: 'ModelLoadFailed'; modelPath: string; message: string }
  | { type: 'TransformChanged'; x: number; y: number; scale: number; reason: string }
  | {
      type: 'PointerEvent';
      kind: string;
      x: number;
      y: number;
      normalizedX: number;
      normalizedY: number;
      hitAreaName?: string;
      button: string;
    }
  | { type: 'RightClick'; screenX: number; screenY: number }
  | { type: 'Error'; code: string; message: string }
  | { type: 'Closed'; reason: string };

// ============================================================
// Internal IPC types (main ↔ renderer)
// ============================================================

/** Command forwarded from main to renderer via IPC. */
export type RendererCommand =
  | {
      type: 'LoadModel';
      roleId?: string;
      modelPath: string;
      initialTransform?: { x?: number; y?: number; scale?: number };
    }
  | { type: 'PlayMotion'; group: string; index?: number; fallbackAction?: string }
  | { type: 'SetExpression'; name: string; durationMs?: number }
  | { type: 'SetActionTag'; actionTag: string; durationMs?: number }
  | { type: 'SpeakStart'; text?: string; estimatedDurationMs?: number }
  | { type: 'SpeakStop' }
  | { type: 'SetTransform'; scale: number };

/**
 * Event sent from renderer to main via IPC.
 * NOTE: TransformChanged here only carries scale + reason; the main process
 * fills in x/y from the window bounds before forwarding to AI_maid.
 */
export type RendererEvent =
  | { type: 'ModelLoaded'; modelPath: string; roleId?: string }
  | { type: 'ModelLoadFailed'; modelPath: string; message: string }
  | { type: 'TransformChanged'; scale: number; reason: string }
  | {
      type: 'PointerEvent';
      kind: string;
      x: number;
      y: number;
      normalizedX: number;
      normalizedY: number;
      hitAreaName?: string;
      button: string;
    }
  | { type: 'RightClick'; screenX: number; screenY: number }
  | { type: 'Error'; code: string; message: string };

// ============================================================
// Helper: build envelope (strips `type` from payload)
// ============================================================

let requestCounter = 0;

export function makeEnvelope<T extends { type: string }>(
  payload: T,
  requestId: string | null = null
): Envelope<T> {
  const { type, ...rest } = payload;
  return {
    type,
    requestId,
    timestamp: new Date().toISOString(),
    payload: rest
  };
}

export function nextRequestId(): string {
  requestCounter += 1;
  return String(requestCounter);
}
