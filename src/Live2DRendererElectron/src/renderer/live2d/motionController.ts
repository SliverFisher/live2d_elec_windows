import type { MotionCapableModel } from './types';

/**
 * Action tag → { motion group, expression, mouth, fallback } mapping.
 *
 * Each actionTag can specify:
 *  - motionGroups: string[]   — motion group candidates, tried in order until one exists
 *  - motionGroup: string      — shorthand for a single motion group (backward compat)
 *  - motionIndex: number      — index within the motion group (default 0)
 *  - expressions: string[]    — expression candidates, tried in order
 *  - expression: string       — shorthand for a single expression
 *  - mouth: boolean           — enable mouth oscillation (for speak)
 *  - fallback: string         — actionTag to fall back to if this one is missing entirely
 *
 * Missing motions/expressions are silently ignored (no crash).
 *
 * See AI_maid protocol spec §7 SetActionTag and §7.7 action_tag_map.json.
 */

export type ActionTagMapping = {
  motionGroups?: string[];
  motionGroup?: string;
  motionIndex?: number;
  expressions?: string[];
  expression?: string;
  mouth?: boolean;
  fallback?: string;
};

const DEFAULT_ACTION_TAG_MAP: Record<string, ActionTagMapping> = {
  idle: {
    expressions: ['idle', 'default', 'normal'],
    fallback: 'idle'
  },
  smile: {
    expressions: ['smile', 'happy', 'joy'],
    fallback: 'idle'
  },
  happy: {
    motionGroups: ['Happy', 'Joy', 'Laugh'],
    expressions: ['happy', 'smile', 'joy'],
    fallback: 'smile'
  },
  shy: {
    expressions: ['shy', 'embarrassed', 'blush'],
    fallback: 'smile'
  },
  angry: {
    motionGroups: ['Angry', 'Mad'],
    expressions: ['angry', 'mad', 'annoyed'],
    fallback: 'annoyed'
  },
  annoyed: {
    expressions: ['annoyed', 'irritated', 'angry'],
    fallback: 'idle'
  },
  sleepy: {
    motionGroups: ['Sleep', 'Sleepy', 'Yawn'],
    expressions: ['sleepy', 'sleep', 'tired'],
    fallback: 'idle'
  },
  think: {
    motionGroups: ['Think', 'Thinking'],
    expressions: ['think', 'thinking', 'wonder'],
    fallback: 'idle'
  },
  wave: {
    motionGroups: ['Wave', 'Greet', 'Hello', 'Idle'],
    expressions: ['smile', 'happy'],
    fallback: 'smile'
  },
  nod: {
    motionGroups: ['Nod', 'Yes', 'Agree'],
    expressions: ['smile', 'happy'],
    fallback: 'smile'
  },
  speak: {
    expressions: ['smile', 'talk', 'speaking'],
    mouth: true,
    fallback: 'idle'
  },
  touch_head: {
    motionGroups: ['TapHead', 'Tap', 'Head', 'TouchHead', 'Pet'],
    expressions: ['happy', 'smile', 'surprised'],
    fallback: 'smile'
  },
  touch_body: {
    motionGroups: ['TapBody', 'Tap', 'Body', 'TouchBody'],
    expressions: ['annoyed', 'surprised', 'shy'],
    fallback: 'smile'
  },
  error: {
    expressions: ['annoyed', 'angry', 'sad'],
    fallback: 'idle'
  },
  surprised: {
    motionGroups: ['Surprise', 'Surprised', 'Shock'],
    expressions: ['surprised', 'shock'],
    fallback: 'smile'
  },
  sad: {
    motionGroups: ['Sad', 'Cry'],
    expressions: ['sad', 'cry', 'down'],
    fallback: 'idle'
  },
  cry: {
    motionGroups: ['Cry', 'Sad'],
    expressions: ['cry', 'sad'],
    fallback: 'sad'
  },
  laugh: {
    motionGroups: ['Laugh', 'Happy', 'Joy'],
    expressions: ['laugh', 'happy', 'smile'],
    fallback: 'happy'
  },
  greet: {
    motionGroups: ['Wave', 'Greet', 'Hello'],
    expressions: ['smile', 'happy'],
    fallback: 'wave'
  }
};

let actionTagMap: Record<string, ActionTagMapping> = { ...DEFAULT_ACTION_TAG_MAP };
let configLoadAttempted = false;
let configLoaded = false;

/**
 * Fetch and merge the user-supplied action_tag_map.json. Safe to call multiple
 * times — only the first call actually fetches. Failures fall back to defaults.
 *
 * @param configUrl URL pointing to the JSON config (live2d-file:// or http://)
 */
export async function loadActionTagMap(configUrl: string | null): Promise<void> {
  if (configLoadAttempted) return;
  configLoadAttempted = true;

  if (!configUrl) {
    console.info('[MotionController] action_tag_map.json URL not provided, using defaults');
    return;
  }

  try {
    const res = await fetch(configUrl);
    if (!res.ok) {
      console.warn('[MotionController] action_tag_map.json fetch failed', { status: res.status, configUrl });
      return;
    }
    const raw = await res.json() as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') {
      console.warn('[MotionController] action_tag_map.json invalid shape, using defaults');
      return;
    }

    const merged: Record<string, ActionTagMapping> = { ...DEFAULT_ACTION_TAG_MAP };
    let loadedCount = 0;
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('_')) continue; // skip _comment etc.
      if (!value || typeof value !== 'object') continue;
      const v = value as Partial<ActionTagMapping>;
      merged[key] = {
        motionGroups: Array.isArray(v.motionGroups) ? v.motionGroups.filter(s => typeof s === 'string') : undefined,
        motionGroup: typeof v.motionGroup === 'string' ? v.motionGroup : undefined,
        motionIndex: typeof v.motionIndex === 'number' ? v.motionIndex : undefined,
        expressions: Array.isArray(v.expressions) ? v.expressions.filter(s => typeof s === 'string') : undefined,
        expression: typeof v.expression === 'string' ? v.expression : undefined,
        mouth: typeof v.mouth === 'boolean' ? v.mouth : undefined,
        fallback: typeof v.fallback === 'string' ? v.fallback : undefined
      };
      loadedCount += 1;
    }
    actionTagMap = merged;
    configLoaded = true;
    console.info('[MotionController] action_tag_map.json loaded', { count: loadedCount, configUrl });
  } catch (e) {
    console.warn('[MotionController] action_tag_map.json load failed, using defaults', { error: e });
  }
}

/**
 * Resolve an actionTag to its mapping, walking the fallback chain if needed.
 * Returns null only if even idle is not configured (should never happen).
 */
function resolveActionTag(tag: string): ActionTagMapping | null {
  const direct = actionTagMap[tag];
  if (direct) return direct;

  // Static fallback hints (independent of the config file)
  const fallbackTag = tag === 'happy' || tag === 'shy' || tag === 'wave' || tag === 'nod' || tag === 'touch_head' || tag === 'touch_body' || tag === 'laugh' || tag === 'greet'
    ? 'smile'
    : tag === 'angry' || tag === 'annoyed' || tag === 'error' || tag === 'sad' || tag === 'cry'
      ? 'annoyed'
      : 'idle';

  const fallback = actionTagMap[fallbackTag];
  if (fallback && fallbackTag !== tag) {
    console.info('[MotionController] actionTag fallback', { tag, fallback: fallbackTag });
    return fallback;
  }

  const idle = actionTagMap.idle;
  if (idle) {
    console.info('[MotionController] actionTag unknown, degrading to idle', { tag });
    return idle;
  }
  return null;
}

/** Normalize a mapping into a list of motion group candidates. */
function getMotionGroupCandidates(mapping: ActionTagMapping): string[] {
  const candidates: string[] = [];
  if (Array.isArray(mapping.motionGroups)) {
    candidates.push(...mapping.motionGroups);
  }
  if (typeof mapping.motionGroup === 'string') {
    candidates.push(mapping.motionGroup);
  }
  return candidates;
}

/** Normalize a mapping into a list of expression candidates. */
function getExpressionCandidates(mapping: ActionTagMapping): string[] {
  const candidates: string[] = [];
  if (Array.isArray(mapping.expressions)) {
    candidates.push(...mapping.expressions);
  }
  if (typeof mapping.expression === 'string') {
    candidates.push(mapping.expression);
  }
  return candidates;
}

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

/**
 * Try each motion group candidate in order. Stops at the first one that does
 * NOT throw. Returns true if any candidate succeeded.
 *
 * Note: pixi-live2d-display's motion() resolves even when the group doesn't
 * exist (it just does nothing), so we rely on the caller's intent rather than
 * a precise "found" signal. The catch handler only fires on real errors.
 */
async function playMotionFirstAvailable(model: MotionCapableModel, candidates: string[], index?: number): Promise<boolean> {
  for (const group of candidates) {
    try {
      await model.motion(group, index);
      return true;
    } catch (e) {
      // Try next candidate
      console.warn('[MotionController] motion candidate failed', { group, error: e });
    }
  }
  return false;
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
 * Try each expression candidate in order. pixi-live2d-display's expression()
 * is fire-and-forget (no return value, no throw for missing expressions), so
 * we just call them all in sequence — the last one wins.
 */
function setExpressionFirstAvailable(model: MotionCapableModel, candidates: string[]): void {
  if (candidates.length === 0) return;
  for (const name of candidates) {
    try {
      model.expression(name);
    } catch (e) {
      console.warn('[MotionController] expression candidate failed', { name, error: e });
    }
  }
}

/**
 * Apply an action tag.
 * Tries mapped motion and expression; silently degrades via fallback chain.
 */
export function applyActionTag(model: MotionCapableModel | null, tag: string): void {
  if (!model) {
    console.warn('[MotionController] applyActionTag: no model loaded', { tag });
    return;
  }

  console.info('[MotionController] applyActionTag', { tag, configLoaded });

  // Stop speaking if switching away from speak
  if (tag !== 'speak') {
    stopSpeaking();
  }

  const mapping = resolveActionTag(tag);
  if (!mapping) {
    console.warn('[MotionController] no mapping for actionTag, ignoring', { tag });
    return;
  }

  if (tag === 'speak' || (mapping.mouth === true)) {
    startSpeaking(model);
  }

  const motionCandidates = getMotionGroupCandidates(mapping);
  if (motionCandidates.length > 0) {
    void playMotionFirstAvailable(model, motionCandidates, mapping.motionIndex).catch(() => undefined);
  }

  const expressionCandidates = getExpressionCandidates(mapping);
  if (expressionCandidates.length > 0) {
    setExpressionFirstAvailable(model, expressionCandidates);
  }
}

// ============================================================
// Speaking / lip sync
//
// Delegates to the pixi-live2d-display-lipsyncpatch framework's built-in
// audio-driven lip sync (model.speak / model.stopSpeaking). The framework
// analyzes the audio in real time and applies mouth parameters inside the
// per-frame update flow (after motion, before model.update), so motion
// animations can no longer overwrite the mouth values.
//
// If the model does not expose `speak` (older/alternative builds), fall back
// to a synthetic sine-wave oscillation on ParamMouthOpenY.
// ============================================================

let speakingModel: MotionCapableModel | null = null;
let speakingInterval: number | null = null;
let speakingCoreModel: { setParameterValueById?: (id: string, value: number) => void } | null = null;

/**
 * Start a simple mouth oscillation to simulate speaking.
 * Used only as a fallback when the framework's speak() is unavailable.
 */
export function startSpeaking(model: MotionCapableModel | null): void {
  if (!model) {
    return;
  }
  stopSpeaking();

  if (typeof model.speak === 'function') {
    // No audio path — synthetic lip sync is not supported by the framework's
    // speak() (it requires an audio URL). Skip rather than fake it.
    console.info('[MotionController] startSpeak: no audioPath, framework speak() requires audio — skipping');
    speakingModel = model;
    return;
  }

  // Fallback synthetic oscillation
  const coreModel = model.internalModel?.coreModel;
  if (!coreModel || typeof coreModel.setParameterValueById !== 'function') {
    console.warn('[MotionController] startSpeaking: coreModel or setParameterValueById not available');
    return;
  }

  speakingModel = model;
  speakingCoreModel = coreModel;
  const setMouth = coreModel.setParameterValueById.bind(coreModel) as (id: string, value: number) => void;
  let phase = 0;
  speakingInterval = window.setInterval(() => {
    phase += 0.18;
    const open = 0.5 + 0.4 * Math.sin(phase);
    try {
      setMouth('ParamMouthOpenY', open);
    } catch {
      stopSpeaking();
    }
  }, 60);
}

/**
 * Start audio-driven lip sync using the framework's built-in speak().
 *
 * @param model The Live2D model
 * @param audioPath Local file path or URL to a WAV/MP3 file
 */
export async function startSpeakingWithAudio(model: MotionCapableModel | null, audioPath: string | null): Promise<void> {
  if (!model) {
    return;
  }
  stopSpeaking();

  if (!audioPath) {
    console.info('[MotionController] startSpeakingWithAudio: no audioPath, falling back to synthetic');
    startSpeaking(model);
    return;
  }

  if (typeof model.speak !== 'function') {
    console.warn('[MotionController] startSpeakingWithAudio: model.speak not available, falling back to synthetic');
    startSpeaking(model);
    return;
  }

  // Framework speak() fetches the URL itself; convert local Windows paths
  // to the live2d-file:// protocol that main process serves.
  const url = toFetchableUrl(audioPath);
  speakingModel = model;
  console.info('[MotionController] speak() start', { audioPath, url });
  try {
    model.speak(url, {
      volume: 1,
      onFinish: () => {
        console.info('[MotionController] speak() finished', { audioPath });
      },
      onError: (err) => {
        console.warn('[MotionController] speak() error', { audioPath, error: err });
      }
    });
    patchAudioForSilentLipsync(model);
  } catch (e) {
    console.warn('[MotionController] speak() threw, falling back to synthetic', { audioPath, error: e });
    speakingModel = null;
    startSpeaking(model);
  }
}

let lipsyncGainNode: GainNode | null = null;

/**
 * Monkey-patch the audio graph so the analyser reads the full-volume signal
 * (for correct lip sync) but the speaker output is near-silent.
 *
 * Before: audio(volume=0.001) → source → analyser → destination
 *           (analyser reads attenuated signal → mouth barely moves)
 *
 * After:  audio(volume=1) → source → analyser → gainNode(0.001) → destination
 *           (analyser reads full signal → mouth moves normally; output is silent)
 */
function patchAudioForSilentLipsync(model: MotionCapableModel): void {
  try {
    const internalModel = (model as any).internalModel;
    const motionManager = internalModel?.motionManager;
    if (!motionManager) {
      console.warn('[MotionController] patchAudio: no motionManager');
      return;
    }

    const audio: HTMLAudioElement | undefined = motionManager.currentAudio;
    const context: AudioContext | undefined = motionManager.currentContext;
    const analyser: AnalyserNode | undefined = motionManager.currentAnalyzer;

    if (!audio || !context || !analyser) {
      console.warn('[MotionController] patchAudio: missing audio/context/analyser', {
        hasAudio: !!audio,
        hasContext: !!context,
        hasAnalyser: !!analyser
      });
      return;
    }

    audio.volume = 1;

    try {
      analyser.disconnect();
    } catch {
      // ignore
    }

    if (lipsyncGainNode) {
      try {
        lipsyncGainNode.disconnect();
      } catch {
        // ignore
      }
      lipsyncGainNode = null;
    }

    const gainNode = context.createGain();
    gainNode.gain.value = 0.001;
    analyser.connect(gainNode);
    gainNode.connect(context.destination);
    lipsyncGainNode = gainNode;

    console.info('[MotionController] patchAudio: lipsync gain node inserted', { outputGain: 0.001 });
  } catch (e) {
    console.warn('[MotionController] patchAudio failed', { error: e });
  }
}

/** Stop speaking / lip sync. */
export function stopSpeaking(): void {
  // Stop framework-provided speak()
  if (speakingModel && typeof speakingModel.stopSpeaking === 'function') {
    try {
      speakingModel.stopSpeaking();
    } catch {
      // ignore
    }
  }
  // Stop fallback synthetic oscillation
  if (speakingInterval !== null) {
    window.clearInterval(speakingInterval);
    speakingInterval = null;
  }
  if (speakingCoreModel && typeof speakingCoreModel.setParameterValueById === 'function') {
    try {
      speakingCoreModel.setParameterValueById('ParamMouthOpenY', 0);
    } catch {
      // Parameter may not exist — ignore
    }
  }
  speakingModel = null;
  speakingCoreModel = null;
}

// ============================================================
// Path normalization for framework speak()
// ============================================================

function toFetchableUrl(path: string): string {
  if (/^https?:\/\//i.test(path) || /^live2d-file:\/\//i.test(path) || /^file:\/\//i.test(path)) {
    return path;
  }
  // Convert a plain Windows path to a live2d-file:// URL.
  // The live2d-file protocol is registered in main and serves any local file.
  const normalized = path.replace(/\\/g, '/');
  return `live2d-file://local/${normalized}`;
}
