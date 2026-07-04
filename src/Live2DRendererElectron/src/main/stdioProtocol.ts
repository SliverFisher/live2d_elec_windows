import { log } from './logger';
import type { HostCommand, RendererEvent } from './protocolTypes';
import { createReadStream, createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { EventEmitter } from 'node:events';

type CommandHandler = (command: HostCommand) => void;

let eventWriter: ((line: string) => void) = (line) => process.stdout.write(line);

export function emitEvent(event: RendererEvent): void {
  eventWriter(`${JSON.stringify(event)}\n`);
}

export function startStdioProtocol(onCommand: CommandHandler): void {
  startLineProtocol(process.stdin, onCommand);
  process.stdin.resume();
  log('stdio protocol started');
}

export function startNamedPipeProtocol(commandPipeName: string, eventPipeName: string, onCommand: CommandHandler): void {
  const commandPipe = toPipePath(commandPipeName);
  const eventPipe = toPipePath(eventPipeName);
  const commandStream = createReadStream(commandPipe, { encoding: 'utf8' });
  const eventStream = createWriteStream(eventPipe, { encoding: 'utf8' });

  eventWriter = (line) => {
    eventStream.write(line);
  };

  startLineProtocol(commandStream, onCommand);
  attachStreamLogging(commandStream, 'command pipe');
  attachStreamLogging(eventStream, 'event pipe');
  log('named pipe protocol started', { commandPipe, eventPipe });
}

function startLineProtocol(input: NodeJS.ReadableStream | Readable, onCommand: CommandHandler): void {
  let buffer = '';
  input.setEncoding('utf8');

  input.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      handleLine(line, onCommand);
    }
  });

  input.on('end', () => {
    if (buffer.trim()) {
      handleLine(buffer, onCommand);
      buffer = '';
    }
  });

  input.on('error', (error: Error) => {
    log('input stream error', error);
    emitEvent({ type: 'Error', message: `input stream error: ${error.message}` });
  });
}

function handleLine(line: string, onCommand: CommandHandler): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  try {
    const command = parseCommand(trimmed);
    log('Received command', command);
    onCommand(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('Command parse failed', message);
    emitEvent({ type: 'Error', message });
  }
}

function toPipePath(pipeName: string): string {
  if (pipeName.startsWith('\\\\.\\pipe\\')) {
    return pipeName;
  }

  return `\\\\.\\pipe\\${pipeName}`;
}

function attachStreamLogging(stream: EventEmitter, label: string): void {
  stream.on('error', (error: Error) => {
    log(`${label} error`, error);
  });
}

function parseCommand(line: string): HostCommand {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON command: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Command must be a JSON object with a string type.');
  }

  switch (value.type) {
    case 'LoadModel':
      requireString(value, 'modelPath');
      return { type: 'LoadModel', modelPath: value.modelPath };
    case 'Show':
    case 'Hide':
    case 'Close':
      return { type: value.type };
    case 'SetScale':
      requireNumber(value, 'scale');
      return { type: 'SetScale', scale: value.scale };
    case 'SetPosition':
      requireNumber(value, 'x');
      requireNumber(value, 'y');
      return { type: 'SetPosition', x: value.x, y: value.y };
    case 'PlayMotion':
      requireString(value, 'group');
      if ('index' in value && typeof value.index !== 'number') {
        throw new Error('PlayMotion.index must be a number when provided.');
      }
      return { type: 'PlayMotion', group: value.group, index: typeof value.index === 'number' ? value.index : undefined };
    case 'SetExpression':
      requireString(value, 'name');
      return { type: 'SetExpression', name: value.name };
    default:
      throw new Error(`Unknown command type: ${value.type}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(value: Record<string, unknown>, key: string): asserts value is Record<string, unknown> & Record<typeof key, string> {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    throw new Error(`${String(value.type)}.${key} must be a non-empty string.`);
  }
}

function requireNumber(value: Record<string, unknown>, key: string): asserts value is Record<string, unknown> & Record<typeof key, number> {
  if (typeof value[key] !== 'number' || Number.isNaN(value[key])) {
    throw new Error(`${String(value.type)}.${key} must be a valid number.`);
  }
}
