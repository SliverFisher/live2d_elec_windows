type MotionCapableModel = {
  motion: (group: string, index?: number) => Promise<unknown>;
  expression: (name: string | number) => void;
  internalModel?: any;
};

/**
 * Action tag → { motion group, expression name } mapping.
 * Missing motions/expressions are silently ignored (no crash).
 * See AI_maid protocol spec §7.7 SetActionTag.
 */
const ACTION_TAG_MAP: Record<string, { motionGroup?: string; motionIndex?: number; expression?: string }> = {
  idle: {},
  smile: { expression: 'smile' },
  think: { expression: 'think' },
  happy: { motionGroup: 'Happy', motionIndex: 0, expression: 'happy' },
  annoyed: { expression: 'annoyed' },
  sleepy: { expression: 'sleepy' },
  wave: { motionGroup: 'Wave', motionIndex: 0 },
  nod: { motionGroup: 'Nod', motionIndex: 0 },
  speak: {},
  touch_head: { motionGroup: 'TapHead', motionIndex: 0 },
  touch_body: { motionGroup: 'TapBody', motionIndex: 0 }
};

let speakingInterval: number | null = null;
let speakingCoreModel: any | null = null;

export async function playMotion(model: MotionCapableModel | null, group: string, index?: number): Promise<void> {
  if (!model) {
    throw new Error('No Live2D model is loaded.');
  }

  try {
    await model.motion(group, index);
  } catch (e) {
    // Motion not found or failed — do not crash, just log
    console.warn('[MotionController] Motion failed', { group, index, error: e });
  }
}

export function setExpression(model: MotionCapableModel | null, name: string): void {
  if (!model) {
    throw new Error('No Live2D model is loaded.');
  }

  try {
    model.expression(name);
  } catch (e) {
    console.warn('[MotionController] Expression failed', { name, error: e });
  }
}

/**
 * Apply an action tag (idle/smile/think/happy/annoyed/sleepy/wave/nod/speak/touch_head/touch_body).
 * Tries mapped motion and expression; silently degrades to idle if resources are missing.
 */
export function applyActionTag(model: MotionCapableModel | null, tag: string): void {
  if (!model) {
    console.warn('[MotionController] applyActionTag: no model loaded', { tag });
    return;
  }

  // Stop speaking if switching away from speak
  if (tag !== 'speak') {
    stopSpeaking();
  }

  const mapping = ACTION_TAG_MAP[tag];
  if (!mapping) {
    console.warn('[MotionController] Unknown action tag, ignoring', { tag });
    return;
  }

  if (tag === 'speak') {
    startSpeaking(model);
    return;
  }

  if (mapping.motionGroup) {
    void playMotion(model, mapping.motionGroup, mapping.motionIndex).catch(() => undefined);
  }

  if (mapping.expression) {
    setExpression(model, mapping.expression);
  }
}

/**
 * Start a simple mouth oscillation to simulate speaking.
 * Uses ParamMouthOpenY if available on the model's coreModel.
 */
export function startSpeaking(model: MotionCapableModel | null): void {
  if (!model) {
    return;
  }
  stopSpeaking();

  const coreModel = model.internalModel?.coreModel;
  if (!coreModel || typeof coreModel.setParameterValueById !== 'function') {
    console.warn('[MotionController] startSpeaking: coreModel or setParameterValueById not available');
    return;
  }

  speakingCoreModel = coreModel;
  let phase = 0;
  speakingInterval = window.setInterval(() => {
    phase += 0.18;
    // Sine wave between 0.1 and 0.9
    const open = 0.5 + 0.4 * Math.sin(phase);
    try {
      coreModel.setParameterValueById('ParamMouthOpenY', open);
    } catch {
      // Parameter may not exist on some models — stop trying
      stopSpeaking();
    }
  }, 60);
}

/** Stop the speaking mouth oscillation and reset mouth to closed (ParamMouthOpenY = 0). */
export function stopSpeaking(): void {
  if (speakingInterval !== null) {
    window.clearInterval(speakingInterval);
    speakingInterval = null;
  }
  // Explicitly reset mouth to closed so models without idle motion don't
  // get stuck with a half-open mouth.
  if (speakingCoreModel && typeof speakingCoreModel.setParameterValueById === 'function') {
    try {
      speakingCoreModel.setParameterValueById('ParamMouthOpenY', 0);
    } catch {
      // Parameter may not exist — ignore
    }
  }
  speakingCoreModel = null;
}
