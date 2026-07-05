import { log } from './logger';

/**
 * Watches the parent process for exit. When the parent exits, calls onExit
 * so the caller can send a Closed event and quit cleanly.
 *
 * Uses process.kill(pid, 0) to check if the process is still alive.
 * Polls every 3 seconds.
 */
export class ParentWatcher {
  private parentPid: number;
  private onExit: () => void;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(parentPid: number, onExit: () => void) {
    this.parentPid = parentPid;
    this.onExit = onExit;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    log('ParentWatcher started', { parentPid: this.parentPid });
    this.timer = setInterval(() => {
      this.check();
    }, 3000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private check(): void {
    if (this.stopped) {
      return;
    }
    try {
      // process.kill(pid, 0) throws if the process doesn't exist
      process.kill(this.parentPid, 0);
    } catch {
      log('ParentWatcher: parent process exited', { parentPid: this.parentPid });
      this.stopped = true;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.onExit();
    }
  }
}
