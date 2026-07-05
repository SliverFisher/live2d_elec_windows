import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ============================================================
// Log rotation settings
// ============================================================
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;               // keep last 5 rotated files

let logFilePath: string | null = null;
let logDirOverride: string | null = null;
let logSequence = 0; // incrementing sequence number for correlation

/**
 * Write to process.stderr without ever throwing.
 * Writes can throw EPIPE if the parent process has exited and the stderr
 * pipe is broken — we must not let that propagate as an uncaught exception
 * (Electron would pop a JS error dialog).
 */
function safeStderrWrite(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // EPIPE / ECONNRESET / ERR_STREAM_DESTROYED — silently ignore.
    // There is nothing we can do; the parent is gone.
  }
}

/** Set the log directory (from --log-dir argument). Must be called before first log(). */
export function setLogDir(dir: string): void {
  logDirOverride = resolve(dir);
  logFilePath = null;
}

export function getLogFilePath(): string {
  if (logFilePath) {
    return logFilePath;
  }

  if (logDirOverride) {
    // --log-dir <dir>: write directly to <dir>/live2d-renderer.log
    logFilePath = resolve(logDirOverride, 'live2d-renderer.log');
  } else {
    // Fallback: use app resources path or dev release dir
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    const basePath = app.isPackaged
      ? resolve(process.resourcesPath, '..', '..')
      : resolve(__dirname, '..', '..', '..', '..', 'release', 'MaidAI');
    logFilePath = resolve(basePath, 'logs', 'live2d-renderer.log');
  }

  mkdirSync(dirname(logFilePath), { recursive: true });
  return logFilePath;
}

/**
 * Rotate log files so the current log never exceeds MAX_LOG_SIZE.
 *
 * Rotation scheme:
 *   live2d-renderer.log    → live2d-renderer.1.log
 *   live2d-renderer.1.log  → live2d-renderer.2.log
 *   ...
 *   live2d-renderer.N.log  → deleted (when N >= MAX_LOG_FILES)
 *
 * Rotation only happens when the current file exceeds MAX_LOG_SIZE.
 * This is called BEFORE each write so the soon-to-be-written line
 * also ends up in a roomy file.
 */
function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return;
    const stat = statSync(file);
    if (stat.size < MAX_LOG_SIZE) return;

    // Remove oldest rotated file
    const oldestFile = `${file.replace(/\.log$/, '')}.${MAX_LOG_FILES - 1}.log`;
    if (existsSync(oldestFile)) {
      try { unlinkSync(oldestFile); } catch { /* ignore */ }
    }

    // Shift rotated files: 3→4, 2→3, 1→2
    for (let i = MAX_LOG_FILES - 2; i >= 1; i--) {
      const oldPath = i === 1
        ? `${file.replace(/\.log$/, '')}.log`
        : `${file.replace(/\.log$/, '')}.${i}.log`;
      const newPath = `${file.replace(/\.log$/, '')}.${i + 1}.log`;
      if (i === 1) {
        // Source is the padded name like live2d-renderer.1.log after previous rotation
        const paddedSource = file.replace(/\.log$/, '.1.log');
        if (existsSync(paddedSource)) {
          try { renameSync(paddedSource, newPath); } catch { /* ignore */ }
        }
      } else {
        if (existsSync(oldPath)) {
          try { renameSync(oldPath, newPath); } catch { /* ignore */ }
        }
      }
    }

    // Rename current → .1.log
    const rotatedFile = file.replace(/\.log$/, '.1.log');
    try { renameSync(file, rotatedFile); } catch { /* ignore */ }

    // The current file is now empty (will be re-created by appendFileSync)
  } catch {
    // If rotation fails for any reason, just continue — losing rotation
    // is better than losing log writes.
  }
}

/**
 * Write a single log line to the rolling log file.
 * Handles rotation, directory creation, and fallback to stderr.
 */
function writeLogLine(file: string, line: string): void {
  try {
    rotateIfNeeded(file);
    appendFileSync(file, line, 'utf8');
  } catch (e) {
    safeStderrWrite(`[LOG ERROR] ${e}\n`);
    safeStderrWrite(line);
  }
}

export function log(message: string, details?: unknown): void {
  const seq = ++logSequence;
  const prefix = `[${new Date().toISOString()}] [#${seq}]`;
  const line = `${prefix} ${message}${details === undefined ? '' : ` ${formatDetails(details)}`}\n`;

  const file = getLogFilePath();

  // Ensure directory exists (may have been deleted since startup)
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch { /* ignore — directory may already exist */ }

  writeLogLine(file, line);

  // Also echo to stderr (NOT stdout — stdout may be used for protocol fallback)
  safeStderrWrite(`[LOG] ${line}`);
}

/**
 * Write a comprehensive startup banner to the log file.
 * Called early in app.whenReady() so this always appears in the first ~50 lines.
 */
export function logStartupBanner(params: {
  pipeName: string | null;
  parentPid: number | null;
  logDir: string | null;
  logFilePath: string;
  model: string | null;
  noDefaultModel: boolean;
  argv: string[];
  cwd: string;
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
}): void {
  const banner = [
    '='.repeat(72),
    'Live2DRenderer STARTUP',
    '='.repeat(72),
    `PID:                ${process.pid}`,
    `CWD:                ${params.cwd}`,
    `argv:               ${params.argv.join(' ')}`,
    `isPackaged:         ${params.isPackaged}`,
    `platform:           ${params.platform}`,
    `electronVersion:    ${params.electronVersion}`,
    `nodeVersion:        ${params.nodeVersion}`,
    `chromeVersion:      ${params.chromeVersion}`,
    `appPath:            ${params.appPath}`,
    `resourcesPath:      ${params.resourcesPath}`,
    '-'.repeat(72),
    'Configuration',
    '-'.repeat(72),
    `pipeName:           ${params.pipeName ?? 'NOT SET (standalone/debug mode)'}`,
    `parentPid:          ${params.parentPid ?? 'NOT SET'}`,
    `logDir:             ${params.logDir ?? 'DEFAULT'}`,
    `logFilePath:        ${params.logFilePath}`,
    `model:              ${params.model ?? 'NOT SET'}`,
    `noDefaultModel:     ${params.noDefaultModel}`,
    '='.repeat(72),
  ];

  for (const bLine of banner) {
    log(bLine);
  }
}

/**
 * Log a fatal error right before exiting.
 * Writes directly to stderr AND log file synchronously.
 */
export function logFatal(reason: string, err: unknown): void {
  const msg = formatDetails(err);
  const line = `[${new Date().toISOString()}] FATAL ${reason}\n${msg}\n`;

  // Best-effort: write to log file
  try {
    const file = getLogFilePath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line, 'utf8');
  } catch {
    // Can't write to log file — last resort is stderr
  }

  // Always try stderr
  safeStderrWrite(`[FATAL] ${reason}\n${msg}\n`);
}

function formatDetails(details: unknown): string {
  if (details instanceof Error) {
    return `${details.name}: ${details.message}\n${details.stack ?? ''}`;
  }

  if (typeof details === 'string') {
    return details;
  }

  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}
