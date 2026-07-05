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

  log('Shutdown initiated', { reason });

  if (parentWatcher) {
    parentWatcher.stop();
    parentWatcher = null;
  }

  closeProtocol(reason);
  app.quit();
}
