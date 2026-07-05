import { app, protocol } from 'electron';
import { createRendererWindow, handleAiMaidCommand, registerWindowIpc } from './windowManager';
import { log, setLogDir } from './logger';
import { parseStartupArgs, isAiMaidMode, type StartupArgs } from './args';
import { startProtocol, closeProtocol, type CommandRouter } from './protocol';
import { ParentWatcher } from './parentWatcher';

app.commandLine.appendSwitch('disable-gpu-sandbox');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'live2d-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

// ============================================================
// Process-level error guards
//
// When AI_maid closes / crashes / is killed, the named pipe breaks.
// Any subsequent write to the pipe (or to stderr/stdout) throws EPIPE.
// Electron's default behavior is to pop a "A JavaScript error occurred
// in the main process" dialog — we must suppress that.
//
// Strategy: filter EPIPE-family errors and silently exit (or ignore).
// Real bugs still go to the log file for diagnosis.
// ============================================================

const SILENT_ERROR_CODES = new Set<string>([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ENOENT' // file vanished — e.g. log file parent dir removed
]);

function isSilentError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  return !!code && SILENT_ERROR_CODES.has(code);
}

process.on('uncaughtException', (err: Error) => {
  if (isSilentError(err)) {
    // Pipe broke because AI_maid exited. Log quietly and shut down.
    // Do NOT re-throw — that would trigger Electron's error dialog.
    log('uncaughtException (silent, pipe disconnected)', {
      code: (err as { code?: string }).code,
      message: err.message
    });
    // Trigger graceful shutdown — detach the pipe so no more writes happen.
    shutdown('PipeDisconnected');
    return;
  }
  log('uncaughtException (fatal)', {
    name: err.name,
    message: err.message,
    stack: err.stack
  });
  // For real errors, let Electron's default handler run (so bugs are visible).
  // We re-throw on next tick to preserve default behavior.
  setImmediate(() => { throw err; });
});

process.on('unhandledRejection', (reason: unknown) => {
  if (isSilentError(reason)) {
    log('unhandledRejection (silent, pipe disconnected)', {
      code: (reason as { code?: string }).code,
      message: (reason as Error)?.message ?? String(reason)
    });
    return;
  }
  log('unhandledRejection (non-fatal)', {
    name: (reason as Error)?.name,
    message: (reason as Error)?.message ?? String(reason),
    stack: (reason as Error)?.stack
  });
});

let startupArgs: StartupArgs;
let parentWatcher: ParentWatcher | null = null;
let isQuitting = false;

app.whenReady().then(() => {
  startupArgs = parseStartupArgs(process.argv);

  // Configure log directory if provided
  if (startupArgs.logDir) {
    setLogDir(startupArgs.logDir);
  }

  log('Renderer starting');
  log('Startup args', {
    pipeName: startupArgs.pipeName,
    parentPid: startupArgs.parentPid,
    logDir: startupArgs.logDir,
    model: startupArgs.model,
    noDefaultModel: startupArgs.noDefaultModel,
    isAiMaidMode: isAiMaidMode(startupArgs)
  });
  log('Env check', {
    isPackaged: app.isPackaged,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    electronRendererUrl: process.env.ELECTRON_RENDERER_URL || 'NOT SET',
    appPath: app.getAppPath()
  });

  registerWindowIpc();
  createRendererWindow();

  // Start the protocol transport (Named Pipe for AI_maid mode, stdio for debug)
  const router: CommandRouter = (command, requestId) => {
    handleAiMaidCommand(command, requestId);
  };
  startProtocol(startupArgs, router);

  // Start parent process watcher if --parent-pid provided
  if (startupArgs.parentPid && startupArgs.parentPid > 0) {
    parentWatcher = new ParentWatcher(startupArgs.parentPid, () => {
      log('Parent process exited, shutting down');
      shutdown('AI_maidExit');
    });
    parentWatcher.start();
  }
});

app.on('window-all-closed', () => {
  log('All windows closed');
  shutdown('WindowClosed');
});

app.on('before-quit', () => {
  log('Renderer exiting');
});

function shutdown(reason: string): void {
  if (isQuitting) {
    return;
  }
  isQuitting = true;

  log('Shutdown initiated', { reason, pid: process.pid });

  if (parentWatcher) {
    parentWatcher.stop();
    parentWatcher = null;
  }

  // Detach the pipe first so no further writes can throw EPIPE during teardown.
  closeProtocol(reason);
  app.quit();
}
