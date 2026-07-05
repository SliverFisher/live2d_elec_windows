import { app, protocol } from 'electron';
import { createRendererWindow, handleHostCommand, registerWindowIpc } from './windowManager';
import { log } from './logger';
import { startNamedPipeProtocol, startStdioProtocol } from './stdioProtocol';

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

app.whenReady().then(() => {
  log('Renderer starting');
  log('Env check', {
    isPackaged: app.isPackaged,
    electronRendererUrl: process.env.ELECTRON_RENDERER_URL || 'NOT SET',
    appPath: app.getAppPath()
  });
  registerWindowIpc();
  startCommandProtocol();
  createRendererWindow();
});

app.on('window-all-closed', () => {
  log('All windows closed');
  app.quit();
});

app.on('before-quit', () => {
  log('Renderer exiting');
});

function startCommandProtocol(): void {
  const commandPipe = getArgValue('--command-pipe');
  const eventPipe = getArgValue('--event-pipe');

  if (commandPipe && eventPipe) {
    startNamedPipeProtocol(commandPipe, eventPipe, handleHostCommand);
    return;
  }

  startStdioProtocol(handleHostCommand);
}

function getArgValue(name: string): string | null {
  const prefix = `${name}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name) {
      return process.argv[index + 1] ?? null;
    }

    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }

  return null;
}
