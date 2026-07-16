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
  | { type: 'Shutdown'; reason?: string }
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
      audioPath?: string;
      estimatedDurationMs?: number;
    }
  | { type: 'SpeakStop'; reason?: string }
  | { type: 'SetClickThrough'; enabled: boolean }
  | {
      type: 'QueryModelGeometry';
      roleId?: string;
      includeParts?: boolean;
      includeAnchors?: boolean;
    }
  | {
      type: 'ShowBubble';
      requestId: string;
      text: string;
      voiceStyle?: 'normal' | 'soft' | 'lively' | 'close';
      source?: string;
      durationMs?: number;
      priority?: number;
      interrupt?: boolean;
      timestamp?: number;
    }
  | { type: 'HideBubble'; requestId: string; reason?: string };

// ============================================================
// Events: Live → AI_maid
// ============================================================

export type RendererEventPayload =
  | { type: 'RendererReady'; protocolVersion: number; rendererVersion: string }
  | { type: 'InitAck'; ok: boolean }
  | { type: 'ModelLoaded'; roleId?: string; modelPath: string }
  | { type: 'ModelLoadFailed'; modelPath: string; message: string }
  | {
      type: 'TransformChanged';
      xDip: number;
      yDip: number;
      widthDip: number;
      heightDip: number;
      scale: number;
      dpiScale: number;
      reason: string;
    }
  | {
      type: 'PointerEvent';
      kind: string;
      x: number;
      y: number;
      normalizedX: number;
      normalizedY: number;
      hitAreaName?: string;
      bodyPart: 'head' | 'face' | 'hair' | 'body' | 'hand' | 'leg' | 'other';
      button: string;
    }
  | {
      type: 'RightClick';
      screenXDip: number;
      screenYDip: number;
      screenXPx: number;
      screenYPx: number;
      displayId: number;
      displayScaleFactor: number;
      displayBoundsDip: { x: number; y: number; width: number; height: number };
      displayWorkAreaDip: { x: number; y: number; width: number; height: number };
      windowBoundsDip: { x: number; y: number; width: number; height: number };
    }
  | { type: 'Error'; code: string; message: string }
  | { type: 'Closed'; reason: string }
  | {
      type: 'ModelGeometryResult';
      ok: boolean;
      roleId?: string;
      coordinateSpace: 'screenDip';
      modelBounds?: { x: number; y: number; width: number; height: number };
      anchors?: {
        modelCenter: { x: number; y: number };
        headTop: { x: number; y: number };
        faceCenter: { x: number; y: number };
        bodyCenter: { x: number; y: number };
        feetCenter: { x: number; y: number };
      };
      parts?: Array<{
        id: string;
        name: string;
        visible: boolean;
        bounds?: { x: number; y: number; width: number; height: number };
        anchor?: { x: number; y: number };
      }>;
      scale?: number;
      code?: string;
      message?: string;
    }
  | { type: 'BubbleShown'; requestId: string; ok: true }
  | { type: 'BubbleError'; requestId: string; ok: false; error: string }
  | { type: 'BubbleHidden'; requestId: string; reason: string };

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
  | { type: 'SpeakStart'; text?: string; audioPath?: string; estimatedDurationMs?: number }
  | { type: 'SpeakStop' }
  | { type: 'SetTransform'; scale: number }
  | {
      type: 'QueryModelGeometry';
      roleId?: string;
      includeParts?: boolean;
      includeAnchors?: boolean;
    }
  | {
      type: 'ShowBubble';
      requestId: string;
      text: string;
      voiceStyle?: 'normal' | 'soft' | 'lively' | 'close';
      source?: string;
      durationMs?: number;
      priority?: number;
      interrupt?: boolean;
    }
  | { type: 'HideBubble'; requestId: string; reason?: string };

/**
 * Event sent from renderer to main via IPC.
 * NOTE: TransformChanged here only carries scale + reason; the main process
 * fills in xDip/yDip/widthDip/heightDip from the window bounds before forwarding to AI_maid.
 * RightClick here only carries screenXDip/screenYDip (in DIP); the main process fills in
 * screenXPx/screenYPx (via screen.dipToScreenPoint), display info (id, scaleFactor,
 * bounds, workArea), and windowBoundsDip before forwarding.
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
      bodyPart: 'head' | 'face' | 'hair' | 'body' | 'hand' | 'leg' | 'other';
      button: string;
    }
  | { type: 'RightClick'; screenXDip: number; screenYDip: number }
  | { type: 'Error'; code: string; message: string }
  | {
      type: 'ModelGeometryResult';
      ok: boolean;
      roleId?: string;
      /** window-relative DIP coordinates — main converts to screenDip */
      modelBounds?: { x: number; y: number; width: number; height: number };
      anchors?: {
        modelCenter: { x: number; y: number };
        headTop: { x: number; y: number };
        faceCenter: { x: number; y: number };
        bodyCenter: { x: number; y: number };
        feetCenter: { x: number; y: number };
      };
      parts?: Array<{
        id: string;
        name: string;
        visible: boolean;
        bounds?: { x: number; y: number; width: number; height: number };
        anchor?: { x: number; y: number };
      }>;
      scale?: number;
      code?: string;
      message?: string;
    }
  | { type: 'BubbleShown'; requestId: string; ok: true }
  | { type: 'BubbleError'; requestId: string; ok: false; error: string }
  | { type: 'BubbleHidden'; requestId: string; reason: string };

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
