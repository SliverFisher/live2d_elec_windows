import type { Socket } from 'node:net';
import type { AiMaidCommand, Envelope, RendererEventPayload } from './protocolTypes';
import { makeEnvelope } from './protocolTypes';
import { log } from './logger';

type CommandHandler = (command: AiMaidCommand, requestId: string | null) => void;
type DisconnectHandler = (reason: string) => void;

/**
 * Error codes that indicate the peer (AI_maid) has gone away or the pipe is
 * broken. These are NOT real errors from our perspective — they are the
 * expected signal that the host process exited. We treat them as a clean
 * disconnect and never let them bubble as uncaught exceptions (which would
 * make Electron pop its default JS error dialog).
 */
const PIPE_DISCONNECT_CODES = new Set<string>([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_PREMATURE_CLOSE'
]);

function isPipeDisconnectError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  return !!code && PIPE_DISCONNECT_CODES.has(code);
}

/**
 * Named Pipe JSON Lines client.
 *
 * Connects to a Windows Named Pipe created by AI_maid and exchanges
 * line-delimited JSON messages following the protocol envelope structure.
 *
 * Protocol: each line is a UTF-8 JSON object:
 *   { "type": "...", "requestId": "...", "timestamp": "...", "payload": {...} }
 */
export class PipeClient {
  private pipePath: string;
  private connected = false;
  private commandHandler: CommandHandler | null = null;
  private disconnectHandler: DisconnectHandler | null = null;
  private netClient: Socket | null = null;
  private buffer = '';
  /**
   * Once we have observed a clean disconnect (Close command, host exit,
   * EPIPE/ECONNRESET), we stop trying to send anything else. The host is
   * gone — Live should exit quietly via the disconnect handler.
   */
  private detached = false;

  constructor(pipeName: string) {
    // Windows named pipe path: \\.\pipe\<name>
    this.pipePath = `\\\\.\\pipe\\${pipeName}`;
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  /**
   * Register a handler that fires once when the pipe disconnects unexpectedly
   * (EPIPE, socket close, socket end after a successful connection). The
   * handler should trigger app.quit() — Live must not linger as a ghost
   * window after its WPF host is gone.
   *
   * Not fired for intentional close() calls (Close/Shutdown commands), since
   * those already drive their own app.quit().
   */
  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandler = handler;
  }

  async connect(): Promise<void> {
    log('PipeClient connecting', { pipePath: this.pipePath });

    return new Promise((resolve, reject) => {
      try {
        // Use Node's net module to connect to the Windows named pipe.
        // On Windows, net.connect with a path connects to \\.\pipe\<name>.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const netModule = require('net') as typeof import('net');
        const client = netModule.connect(this.pipePath, () => {
          this.connected = true;
          log('PipeClient connected', { pipePath: this.pipePath });
          resolve();
        });

        this.netClient = client;

        client.on('data', (data: Buffer) => {
          this.handleData(data.toString('utf8'));
        });

        client.on('error', (err: Error & { code?: string }) => {
          if (isPipeDisconnectError(err)) {
            // Expected when AI_maid exits — do NOT log as error, do NOT
            // let it propagate.
            log('PipeClient pipe disconnected (expected)', {
              code: err.code,
              message: err.message
            });
            if (!this.connected) {
              // Was never connected — reject the initial connect promise
              // so callers know, but treat it as a clean disconnect.
              this.markDisconnected();
              reject(err);
            } else {
              // Was connected, now disconnected — WPF is gone. Trigger
              // app.quit() via the disconnect handler.
              this.notifyDisconnect(`pipe error: ${err.code}`);
            }
            return;
          }

          log('PipeClient error', { code: err.code, message: err.message });
          if (!this.connected) {
            reject(err);
          }
          this.markDisconnected();
        });

        client.on('close', () => {
          log('PipeClient closed', { pipePath: this.pipePath });
          if (this.detached) return;
          if (this.connected) {
            // Unexpected close after successful connection — WPF gone.
            this.notifyDisconnect('pipe closed');
          } else {
            this.markDisconnected();
          }
        });

        client.on('end', () => {
          log('PipeClient ended', { pipePath: this.pipePath });
          if (this.detached) return;
          if (this.connected) {
            // WPF closed its write end — treat as disconnect.
            this.notifyDisconnect('pipe ended');
          } else {
            this.markDisconnected();
          }
        });
      } catch (e) {
        log('PipeClient connect failed', e);
        reject(e);
      }
    });
  }

  /**
   * Mark the client as disconnected and tear down the socket.
   * Subsequent sendEvent calls become silent no-ops (only file log).
   */
  private markDisconnected(): void {
    this.connected = false;
    if (this.netClient) {
      try {
        this.netClient.destroy();
      } catch {
        // ignore — socket may already be destroyed
      }
    }
  }

  /**
   * Mark the client as permanently detached — host is gone, stop trying
   * to send. Used after receiving an explicit Close/Shutdown command or
   * after observing a pipe disconnect.
   */
  detach(reason: string): void {
    if (this.detached) return;
    this.detached = true;
    log('PipeClient detached', { reason });
    this.markDisconnected();
  }

  /**
   * Called when the pipe disconnects unexpectedly (EPIPE, socket close,
   * socket end) after a successful connection. Detaches the client and
   * fires the disconnect handler once, which should trigger app.quit().
   *
   * Idempotent: if detach() was already called (e.g. intentional Close),
   * this is a no-op — the disconnect handler will NOT fire.
   */
  private notifyDisconnect(reason: string): void {
    if (this.detached) return;
    this.detach(reason);
    if (this.disconnectHandler) {
      try {
        this.disconnectHandler(reason);
      } catch (e) {
        log('PipeClient disconnect handler error', e);
      }
    }
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.processLine(trimmed);
    }
  }

  private processLine(line: string): void {
    let envelope: Envelope<any>;
    try {
      envelope = JSON.parse(line);
    } catch {
      log('PipeClient JSON parse failed', { line });
      this.sendEvent({
        type: 'Error',
        code: 'ProtocolParseFailed',
        message: 'invalid json line'
      }, null);
      return;
    }

    log('PipeClient received command', {
      type: envelope.type,
      requestId: envelope.requestId
    });

    const command = envelope.payload as AiMaidCommand;
    if (!command || typeof command.type !== 'string') {
      this.sendEvent({
        type: 'Error',
        code: 'InvalidCommand',
        message: 'missing command type'
      }, envelope.requestId);
      return;
    }

    if (this.commandHandler) {
      try {
        this.commandHandler(command, envelope.requestId);
      } catch (e) {
        log('PipeClient command handler error', e);
        this.sendEvent({
          type: 'Error',
          code: 'CommandHandlerError',
          message: e instanceof Error ? e.message : String(e)
        }, envelope.requestId);
      }
    }
  }

  /** Send an event to AI_maid via the pipe. Silently skipped if detached. */
  sendEvent(payload: RendererEventPayload, requestId: string | null): void {
    if (this.detached) {
      // Host is gone — silently drop. Do NOT attempt to write or log to pipe.
      return;
    }
    const envelope = makeEnvelope(payload, requestId);
    const line = JSON.stringify(envelope) + '\n';
    log('PipeClient sendEvent', { type: envelope.type, requestId: envelope.requestId });
    this.write(line);
  }

  private write(data: string): void {
    if (!this.connected || !this.netClient) {
      let type = 'unknown';
      try { type = JSON.parse(data).type; } catch { /* ignore */ }
      log('PipeClient write skipped (not connected)', { type });
      return;
    }
    try {
      this.netClient.write(data, 'utf8');
    } catch (e) {
      if (isPipeDisconnectError(e)) {
        // EPIPE / ECONNRESET / ERR_STREAM_DESTROYED — peer is gone.
        // Mark disconnected so we stop trying. Do NOT log as error.
        log('PipeClient write EPIPE ignored', {
          code: (e as { code?: string }).code
        });
        this.markDisconnected();
      } else {
        log('PipeClient write failed', e);
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  isDetached(): boolean {
    return this.detached;
  }

  close(): void {
    this.detach('close');
    if (this.netClient) {
      try {
        this.netClient.end();
      } catch {
        // ignore
      }
      try {
        this.netClient.destroy();
      } catch {
        // ignore
      }
      this.netClient = null;
    }
  }
}
