import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let logFilePath: string | null = null;

export function getLogFilePath(): string {
  if (logFilePath) {
    return logFilePath;
  }

  const basePath = app.isPackaged
    ? resolve(process.resourcesPath, '..', '..')
    : resolve(__dirname, '..', '..', '..', '..', 'release', 'MaidAI');

  logFilePath = resolve(basePath, 'logs', 'live2d-renderer.log');
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
  process.stdout.write(`[LOG] ${line}`);
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
