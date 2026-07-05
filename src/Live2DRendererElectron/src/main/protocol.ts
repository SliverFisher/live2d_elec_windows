import { log } from './logger';
import { PipeClient } from './pipeClient';
import type { AiMaidCommand, RendererEventPayload } from './protocolTypes';
import { makeEnvelope } from './protocolTypes';
import type { StartupArgs } from './args';
import { isAiMaidMode } from './args';

export type CommandRouter = (command: AiMaidCommand, requestId: string | null) => void;

let transport: 'pipe' | 'stdio' | 'none' = 'none';
let pipeClient: PipeClient | null = null;
let stdioWriter: ((line: string) => void) | null = null;

/**
 * Start the protocol transport based on startup args.
 * - --pipe-name → Named Pipe JSON Lines (AI_maid mode)
 * - otherwise   → stdio JSON Lines (debug fallback)
 */
export function startProtocol(args: StartupArgs, router: CommandRouter): void {
  if (isAiMaidMode(args)) {
    startPipe(args.pipeName!, router);
  } else {
    log('No --pipe-name provided, entering standalone debug mode (stdio protocol)');
    startStdio(router);
  }
}

function startPipe(pipeName: string, router: CommandRouter): void {
  transport = 'pipe';
  pipeClient = new PipeClient(pipeName);
  pipeClient.onCommand((command, requestId) => {
    router(command, requestId);
  });

  pipeClient.connect().then(() => {
    log('Pipe protocol connected, sending RendererReady');
    sendEvent(
      { type: 'RendererReady', protocolVersion: 1, rendererVersion: '1.0.0' },
      null
    );
  }).catch((e) => {
    log('Pipe protocol connect failed', e);
  });
}

function startStdio(router: CommandRouter): void {
  transport = 'stdio';
  stdioWriter = (line) => process.stdout.write(line);

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      processStdioLine(trimmed, router);
    }
  });

  process.stdin.on('end', () => {
    if (buffer.trim()) {
      processStdioLine(buffer.trim(), router);
      buffer = '';
    }
  });

  // Send RendererReady in stdio mode too
  sendEvent(
    { type: 'RendererReady', protocolVersion: 1, rendererVersion: '1.0.0' },
    null
  );

  log('stdio protocol started');
}

function processStdioLine(line: string, router: CommandRouter): void {
  let envelope: any;
  try {
    envelope = JSON.parse(line);
  } catch {
    log('stdio JSON parse failed', { line });
    sendEvent({ type: 'Error', code: 'ProtocolParseFailed', message: 'invalid json line' }, null);
    return;
  }

  const command = envelope.payload ?? envelope;
  if (!command || typeof command.type !== 'string') {
    sendEvent({ type: 'Error', code: 'InvalidCommand', message: 'missing command type' }, envelope.requestId ?? null);
    return;
  }

  log('stdio received command', { type: command.type, requestId: envelope.requestId });
  try {
    router(command as AiMaidCommand, envelope.requestId ?? null);
  } catch (e) {
    log('stdio command handler error', e);
    sendEvent({
      type: 'Error',
      code: 'CommandHandlerError',
      message: e instanceof Error ? e.message : String(e)
    }, envelope.requestId ?? null);
  }
}

/**
 * Send an event to AI_maid.
 * Uses requestId from the originating command for response events,
 * or null for spontaneous events.
 */
export function sendEvent(payload: RendererEventPayload, requestId: string | null): void {
  const envelope = makeEnvelope(payload, requestId);
  const line = JSON.stringify(envelope) + '\n';

  if (transport === 'pipe' && pipeClient) {
    pipeClient.sendEvent(payload, requestId);
  } else if (transport === 'stdio' && stdioWriter) {
    stdioWriter(line);
  } else {
    log('sendEvent: no transport available', { type: payload.type });
  }
}

/** Send a Closed event and close the transport. */
export function closeProtocol(reason: string): void {
  sendEvent({ type: 'Closed', reason }, null);
  if (pipeClient) {
    pipeClient.close();
    pipeClient = null;
  }
  transport = 'none';
}
