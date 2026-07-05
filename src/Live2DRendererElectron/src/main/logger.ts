import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let logFilePath: string | null = null;
let logDirOverride: string | null = null;

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
    // Do NOT append an extra "logs" subdirectory — the caller provides the
    // exact directory they want the log file written to.
    logFilePath = resolve(logDirOverride, 'live2d-renderer.log');
  } else {
    // Fallback: use app resources path or dev release dir
    const { app } = require('electron');
    const basePath = app.isPackaged
      ? resolve(process.resourcesPath, '..', '..')
      : resolve(__dirname, '..', '..', '..', '..', 'release', 'MaidAI');
    logFilePath = resolve(basePath, 'logs', 'live2d-renderer.log');
  }

  mkdirSync(dirname(logFilePath), { recursive: true });
  return logFilePath;
}

export function log(message: string, details?: unknown): void {
  const line = `[${new Date().toISOString()}] ${message}${details === undefined ? '' : ` ${formatDetails(details)}`}\n`;
  try {
    appendFileSync(getLogFilePath(), line, 'utf8');
  } catch (e) {
    process.stderr.write(`[LOG ERROR] ${e}\n`);
    process.stderr.write(line);
  }
  // Also echo to stderr (NOT stdout — stdout may be used for protocol fallback)
  process.stderr.write(`[LOG] ${line}`);
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
