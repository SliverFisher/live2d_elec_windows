import type { Socket } from 'node:net';
import type { AiMaidCommand, Envelope, RendererEventPayload } from './protocolTypes';
import { makeEnvelope } from './protocolTypes';
import { log } from './logger';

type CommandHandler = (command: AiMaidCommand, requestId: string | null) => void;

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
  private reconnectTimer: NodeJS.Timeout | null = null;
  private commandHandler: CommandHandler | null = null;
  private netClient: Socket | null = null;
  private buffer = '';

  constructor(pipeName: string) {
    // Windows named pipe path: \\.\pipe\<name>
    this.pipePath = `\\\\.\\pipe\\${pipeName}`;
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
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

        client.on('error', (err: Error) => {
          log('PipeClient error', { message: err.message });
          if (!this.connected) {
            reject(err);
          }
          this.connected = false;
          this.scheduleReconnect();
        });

        client.on('close', () => {
          log('PipeClient closed', { pipePath: this.pipePath });
          this.connected = false;
          this.scheduleReconnect();
        });

        client.on('end', () => {
          log('PipeClient ended', { pipePath: this.pipePath });
          this.connected = false;
          this.scheduleReconnect();
        });
      } catch (e) {
        log('PipeClient connect failed', e);
        reject(e);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected) {
        log('PipeClient attempting reconnect', { pipePath: this.pipePath });
        void this.connect().catch(() => {
          // Error already logged; will retry
        });
      }
    }, 2000);
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

  /** Send an event to AI_maid via the pipe. */
  sendEvent(payload: RendererEventPayload, requestId: string | null): void {
    const envelope = makeEnvelope(payload, requestId);
    const line = JSON.stringify(envelope) + '\n';
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
      log('PipeClient write failed', e);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    if (this.netClient) {
      try {
        this.netClient.end();
        this.netClient.destroy();
      } catch {
        // ignore
      }
      this.netClient = null;
    }
  }
}
