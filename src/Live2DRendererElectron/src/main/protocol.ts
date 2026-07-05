import { log } from './logger';
import { PipeClient } from './pipeClient';
import type { AiMaidCommand, RendererEventPayload } from './protocolTypes';
import { makeEnvelope } from './protocolTypes';
import type { StartupArgs } from './args';
import { isAiMaidMode } from './args';

export type CommandRouter = (command: AiMaidCommand, requestId: string | null) => void;
export type DisconnectHandler = (reason: string) => void;

let transport: 'pipe' | 'stdio' | 'none' = 'none';
let pipeClient: PipeClient | null = null;
let stdioWriter: ((line: string) => void) | null = null;
let stdioDetached = false;
let stdioDisconnectNotified = false;

/**
 * Start the protocol transport based on startup args.
 * - --pipe-name → Named Pipe JSON Lines (AI_maid mode)
 * - otherwise   → stdio JSON Lines (debug fallback)
 *
 * onDisconnect fires when the transport disconnects unexpectedly (WPF gone,
 * pipe closed, stdin ended). The caller should trigger app.quit() in
 * response — Live must not linger as a ghost window after its host is gone.
 */
export function startProtocol(args: StartupArgs, router: CommandRouter, onDisconnect: DisconnectHandler): void {
  if (isAiMaidMode(args)) {
    startPipe(args.pipeName!, router, onDisconnect);
  } else {
    log('No --pipe-name provided, entering standalone debug mode (stdio protocol)');
    startStdio(router, onDisconnect);
  }
}

function startPipe(pipeName: string, router: CommandRouter, onDisconnect: DisconnectHandler): void {
  transport = 'pipe';
  pipeClient = new PipeClient(pipeName);
  pipeClient.onCommand((command, requestId) => {
    router(command, requestId);
  });
  pipeClient.onDisconnect(onDisconnect);

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

/**
 * Write a line to stdout without ever throwing.
 * EPIPE is expected when the parent (mock client / AI_maid) has exited;
 * letting it propagate would crash Electron with a JS error dialog.
 */
function safeStdoutWrite(line: string): void {
  if (stdioDetached) return;
  try {
    process.stdout.write(line);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END') {
      // Parent is gone — detach so we never try to write again.
      stdioDetached = true;
      log('stdio write EPIPE ignored, detaching writer', { code });
    } else {
      log('stdio write failed', { code, message: (e as Error).message });
    }
  }
}

function startStdio(router: CommandRouter, onDisconnect: DisconnectHandler): void {
  transport = 'stdio';
  stdioWriter = safeStdoutWrite;

  const notifyStdioDisconnect = (reason: string) => {
    if (stdioDisconnectNotified) return;
    stdioDisconnectNotified = true;
    stdioDetached = true;
    log('stdio disconnect, notifying', { reason });
    try { onDisconnect(reason); } catch (e) { log('stdio disconnect handler error', e); }
  };

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
    // In standalone/debug mode (no --pipe-name), stdin 'end' is NOT a
    // disconnect signal — it just means no more commands will arrive via
    // stdin. The window stays open for manual interaction.
    // Only trigger shutdown if we're NOT in standalone mode (i.e., we were
    // launched as a child process with stdin piped from a parent).
    // Since startStdio is only called when !isAiMaidMode (no pipe-name),
    // and in that case stdin 'end' is expected when running from terminal,
    // we treat it as a non-fatal event.
    log('stdio stdin ended (standalone mode — window stays open)');
    // Do NOT call notifyStdioDisconnect here — that would quit the app.
  });

  process.stdin.on('error', (err: Error & { code?: string }) => {
    // ECONNRESET on stdin can also happen when a parent disconnects
    // abruptly (e.g. mock client killed). Treat as disconnect.
    log('stdio stdin error', { code: err.code, message: err.message });
    notifyStdioDisconnect(`stdio stdin error: ${err.code ?? 'unknown'}`);
  });

  process.stdout.on('error', (err: Error & { code?: string }) => {
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED') {
      stdioDetached = true;
      log('stdio stdout EPIPE ignored, detaching writer', { code: err.code });
      notifyStdioDisconnect(`stdio stdout ${err.code}`);
    } else {
      log('stdio stdout error', { code: err.code, message: err.message });
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
 *
 * If the transport is detached (host gone / EPIPE), this is a silent no-op.
 */
export function sendEvent(payload: RendererEventPayload, requestId: string | null): void {
  if (transport === 'pipe' && pipeClient) {
    pipeClient.sendEvent(payload, requestId);
  } else if (transport === 'stdio' && stdioWriter && !stdioDetached) {
    const envelope = makeEnvelope(payload, requestId);
    const line = JSON.stringify(envelope) + '\n';
    stdioWriter(line);
  } else {
    log('sendEvent: no transport available', { type: payload.type });
  }
}

/**
 * Send a Closed event and close the transport.
 * If the pipe is already detached, the Closed event is silently dropped
 * (there is nobody to receive it anyway).
 *
 * Marks stdio as disconnect-notified so the intentional close doesn't
 * later trigger a spurious onDisconnect (and double app.quit()).
 */
export function closeProtocol(reason: string): void {
  sendEvent({ type: 'Closed', reason }, null);
  if (pipeClient) {
    pipeClient.close();
    pipeClient = null;
  }
  stdioDetached = true;
  stdioDisconnectNotified = true;
  transport = 'none';
}
