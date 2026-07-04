import { contextBridge, ipcRenderer } from 'electron';
import type { HostCommand, RendererEvent } from '../main/protocolTypes';

export type RendererApi = {
  onHostCommand: (callback: (command: HostCommand) => void) => () => void;
  emitEvent: (event: RendererEvent) => Promise<void>;
  petDragStart: () => Promise<void>;
  petDragMove: () => Promise<void>;
  petDragEnd: () => Promise<void>;
  petResizeToFit: (width: number, height: number) => Promise<void>;
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => Promise<void>;
  resolveModelUrl: (modelPath: string) => Promise<string>;
  getCubismCoreUrl: () => Promise<string>;
};

const api: RendererApi = {
  onHostCommand(callback) {
    const listener = (_event: Electron.IpcRendererEvent, command: HostCommand) => callback(command);
    ipcRenderer.on('host-command', listener);
    return () => ipcRenderer.off('host-command', listener);
  },
  emitEvent(event) {
    return ipcRenderer.invoke('renderer-event', event);
  },
  petDragStart() {
    return ipcRenderer.invoke('pet:drag-start');
  },
  petDragMove() {
    return ipcRenderer.invoke('pet:drag-move');
  },
  petDragEnd() {
    return ipcRenderer.invoke('pet:drag-end');
  },
  petResizeToFit(width, height) {
    return ipcRenderer.invoke('pet:resize-to-fit', { width, height });
  },
  setIgnoreMouseEvents(ignore, options) {
    return ipcRenderer.invoke('set-ignore-mouse-events', { ignore, options });
  },
  resolveModelUrl(modelPath) {
    return ipcRenderer.invoke('resolve-model-url', modelPath);
  },
  getCubismCoreUrl() {
    return ipcRenderer.invoke('get-cubism-core-url');
  }
};

contextBridge.exposeInMainWorld('live2dRenderer', api);
