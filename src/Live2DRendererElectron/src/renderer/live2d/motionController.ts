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
// Speaking / mouth oscillation
//
// Two modes:
//  1. Audio-driven (preferred): SpeakStart carries audioPath, we read WAV
//     amplitude samples and feed ParamMouthOpenY.
//  2. Synthetic fallback: sine-wave oscillation 0.1..0.9 at ~16Hz.
// ============================================================

let speakingInterval: number | null = null;
let speakingCoreModel: any | null = null;
let speakingAudioPath: string | null = null;

/**
 * Start a simple mouth oscillation to simulate speaking.
 * Uses ParamMouthOpenY if available on the model's coreModel.
 *
 * Note: when an audioPath is available, use `startSpeakingWithAudio` instead.
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
  const setMouth = coreModel.setParameterValueById.bind(coreModel) as (id: string, value: number) => void;
  let phase = 0;
  speakingInterval = window.setInterval(() => {
    phase += 0.18;
    // Sine wave between 0.1 and 0.9
    const open = 0.5 + 0.4 * Math.sin(phase);
    try {
      setMouth('ParamMouthOpenY', open);
    } catch {
      // Parameter may not exist on some models — stop trying
      stopSpeaking();
    }
  }, 60);
}

/**
 * Start audio-driven mouth animation.
 * Falls back to synthetic oscillation if the audio file cannot be read.
 *
 * @param model The Live2D model (must have internalModel.coreModel)
 * @param audioPath Local file path to a WAV file, or null to use synthetic mode
 */
export async function startSpeakingWithAudio(model: MotionCapableModel | null, audioPath: string | null): Promise<void> {
  if (!model) {
    return;
  }
  stopSpeaking();

  const coreModel = model.internalModel?.coreModel;
  if (!coreModel || typeof coreModel.setParameterValueById !== 'function') {
    console.warn('[MotionController] startSpeakingWithAudio: coreModel not available');
    return;
  }

  speakingCoreModel = coreModel;
  speakingAudioPath = audioPath;

  if (!audioPath) {
    console.info('[MotionController] mouth analyze: no audioPath, fallback to synthetic oscillation');
    startSpeaking(model);
    return;
  }

  try {
    const samples = await readWavAmplitudeSamples(audioPath, 40);
    if (samples.length === 0) {
      console.warn('[MotionController] mouth analyze: empty samples, fallback', { audioPath });
      startSpeaking(model);
      return;
    }

    console.info('[MotionController] mouth analyze success', { audioPath, sampleCount: samples.length });

    const setMouth = coreModel.setParameterValueById.bind(coreModel) as (id: string, value: number) => void;
    let idx = 0;
    let lastValue = 0;
    speakingInterval = window.setInterval(() => {
      if (idx >= samples.length) {
        // Loop until SpeakStop arrives
        idx = 0;
      }
      const raw = samples[idx++];
      // Smooth: low-pass filter to reduce jitter
      lastValue = lastValue * 0.6 + raw * 0.4;
      // Map amplitude (0..1) to mouth open (0.05..0.95)
      const open = Math.max(0.05, Math.min(0.95, lastValue * 0.9 + 0.05));
      try {
        setMouth('ParamMouthOpenY', open);
      } catch {
        stopSpeaking();
      }
    }, 40);
  } catch (e) {
    console.warn('[MotionController] mouth analyze failed, fallback to synthetic', { audioPath, error: e });
    startSpeaking(model);
  }
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
      console.info('[MotionController] SpeakStop mouth reset', { hadAudio: speakingAudioPath !== null });
    } catch {
      // Parameter may not exist — ignore
    }
  }
  speakingCoreModel = null;
  speakingAudioPath = null;
}

// ============================================================
// WAV amplitude sampling
//
// Reads a WAV file, downsamples to one amplitude value per `intervalMs`,
// normalized to 0..1. Returns [] on any error (caller falls back).
// Supports 8/16/24/32-bit PCM and float32 WAV. Does NOT support mp3.
// ============================================================

async function readWavAmplitudeSamples(wavPath: string, intervalMs: number): Promise<number[]> {
  // Resolve file:// path to fetchable URL. live2d-file:// is registered by main.
  // Plain Windows paths are converted to live2d-file://local/...
  const url = toFetchableUrl(wavPath);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);

  // Parse RIFF/WAVE header
  if (view.byteLength < 44 ||
      view.getUint32(0, false) !== 0x52494646 /* 'RIFF' */ ||
      view.getUint32(8, false) !== 0x57415645 /* 'WAVE' */) {
    throw new Error('not a RIFF/WAVE file');
  }

  // Walk chunks to find fmt and data
  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x666d7420 /* 'fmt ' */) {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 0x64617461 /* 'data' */) {
      dataOffset = offset + 8;
      dataLength = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }

  if (dataOffset < 0 || dataLength <= 0) {
    throw new Error('no data chunk');
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * numChannels;
  const totalFrames = Math.floor(dataLength / frameSize);
  const durationMs = (totalFrames / sampleRate) * 1000;
  const targetSampleCount = Math.max(1, Math.floor(durationMs / intervalMs));
  const framesPerSample = Math.max(1, Math.floor(totalFrames / targetSampleCount));

  const samples: number[] = [];
  let peak = 0;

  for (let s = 0; s < targetSampleCount; s++) {
    let sum = 0;
    let count = 0;
    const startFrame = s * framesPerSample;
    const endFrame = Math.min(totalFrames, startFrame + framesPerSample);
    for (let f = startFrame; f < endFrame; f++) {
      const byteOffset = dataOffset + f * frameSize;
      // Average all channels for this frame
      let v = 0;
      for (let c = 0; c < numChannels; c++) {
        v += readSample(view, byteOffset + c * bytesPerSample, bitsPerSample, audioFormat);
      }
      sum += Math.abs(v / numChannels);
      count += 1;
    }
    const avg = count > 0 ? sum / count : 0;
    samples.push(avg);
    if (avg > peak) peak = avg;
  }

  // Normalize to 0..1 based on peak (avoid quiet clip being stuck at 0)
  const normFactor = peak > 0.0001 ? 1 / peak : 1;
  return samples.map(s => Math.min(1, s * normFactor));
}

function readSample(view: DataView, offset: number, bits: number, format: number): number {
  try {
    if (format === 3 /* IEEE float */ && bits === 32) {
      return view.getFloat32(offset, true);
    }
    if (bits === 8) {
      return (view.getUint8(offset) - 128) / 128;
    }
    if (bits === 16) {
      return view.getInt16(offset, true) / 32768;
    }
    if (bits === 24) {
      const b0 = view.getUint8(offset);
      const b1 = view.getUint8(offset + 1);
      const b2 = view.getInt8(offset + 2);
      return ((b2 << 16) | (b1 << 8) | b0) / 8388608;
    }
    if (bits === 32) {
      return view.getInt32(offset, true) / 2147483648;
    }
  } catch {
    // out of bounds — return silence
  }
  return 0;
}

function toFetchableUrl(path: string): string {
  if (/^https?:\/\//i.test(path) || /^live2d-file:\/\//i.test(path) || /^file:\/\//i.test(path)) {
    return path;
  }
  // Convert a plain Windows path to a live2d-file:// URL.
  // The live2d-file protocol is registered in main and serves any local file.
  const normalized = path.replace(/\\/g, '/');
  return `live2d-file://local/${normalized}`;
}
