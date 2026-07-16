import { app, protocol } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRendererWindow, handleAiMaidCommand, registerWindowIpc } from './windowManager';
import { log, setLogDir, logStartupBanner, logFatal, getLogFilePath } from './logger';
import { parseStartupArgs, isAiMaidMode, type StartupArgs } from './args';
import { startProtocol, closeProtocol, type CommandRouter } from './protocol';
import { ParentWatcher } from './parentWatcher';

// ============================================================
// Requirement 1: Single-instance lock
// Prevents process storms when WPF repeatedly relaunches us.
// Only ONE Live2DRendererHost.exe can run at a time.
// ============================================================
const SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!SINGLE_INSTANCE_LOCK) {
  // Another instance is already running — exit silently (not a crash).
  process.exit(0);
}

app.on('second-instance', () => {
  // WPF tried to launch a second copy while we're already running.
  // Log and ignore — the existing instance stays alive.
  try {
    const { log: lateLog } = require('./logger');
    lateLog('Second instance launch blocked by single-instance lock');
  } catch { /* logger may not be available yet */ }
});

// ============================================================
// Requirement 2: Crash-rate limiter (defense-in-depth)
//
// Live code has NO app.relaunch/spawn/fork/restart logic — the
// process storm comes from WPF repeatedly launching a crashing
// renderer. This limiter is a safety net: if the renderer crashes
// > MAX_CRASHES times within CRASH_WINDOW_MS, we refuse to start.
//
// 30 秒内最多 1 次重启，连续失败 2 次直接退出
// ============================================================
const CRASH_TRACKER_FILE = join(app.getPath('userData'), 'live2d-crash-counter.json');
const MAX_CRASHES = 2;           // 最多允许 2 次
const CRASH_WINDOW_MS = 30_000;  // 30 秒窗口

interface CrashRecord { timestamp: number; }

function loadCrashTracker(): CrashRecord[] {
  try {
    if (existsSync(CRASH_TRACKER_FILE)) {
      const raw = readFileSync(CRASH_TRACKER_FILE, 'utf-8');
      const arr: CrashRecord[] = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch { /* corrupt file — start fresh */ }
  return [];
}

function saveCrashTracker(records: CrashRecord[]): void {
  try {
    mkdirSync(dirname(CRASH_TRACKER_FILE), { recursive: true });
    writeFileSync(CRASH_TRACKER_FILE, JSON.stringify(records), 'utf-8');
  } catch { /* best-effort */ }
}

function checkCrashRateLimit(): boolean {
  const records = loadCrashTracker();
  const now = Date.now();
  // Keep only entries within the window
  const recent = records.filter(r => now - r.timestamp < CRASH_WINDOW_MS);
  if (recent.length >= MAX_CRASHES) {
    const oldest = recent[0]?.timestamp ?? now;
    const waitMs = CRASH_WINDOW_MS - (now - oldest);
    process.stderr.write(
      `[FATAL] Too many crashes (${recent.length}) within ${CRASH_WINDOW_MS}ms. ` +
      `Refusing to start for ${Math.round(waitMs / 1000)}s.\n`
    );
    return false;
  }
  return true;
}

function recordStartupAttempt(): void {
  const records = loadCrashTracker();
  const now = Date.now();
  records.push({ timestamp: now });
  // Keep only the last MAX_CRASHES * 2 entries
  const trimmed = records.slice(-(MAX_CRASHES * 2));
  saveCrashTracker(trimmed);
}

function clearCrashTracker(): void {
  try {
    if (existsSync(CRASH_TRACKER_FILE)) {
      writeFileSync(CRASH_TRACKER_FILE, JSON.stringify([]), 'utf-8');
    }
  } catch { /* best-effort */ }
}

// Block startup if we're in a crash storm. Don't even init Electron.
if (!checkCrashRateLimit()) {
  app.exit(1);
}

// Record this attempt. Cleared on successful init (app.whenReady success).
recordStartupAttempt();

// Windows 透明、无边框且跨虚拟桌面的 BrowserWindow 在部分显卡驱动上会在
// Chromium GPU 初始化阶段直接退出，甚至来不及创建应用日志。Live2D 的 Pixi
// WebGL 渲染仍由 Chromium 的 SwiftShader 路径完成；PetPanel 的拖动/缩放优化
// 不依赖原生窗口合成，因此保留兼容开关。
app.commandLine.appendSwitch('disable-gpu');
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
// Requirement 3+4: Child process & renderer process crash monitoring
//
// Electron spawns child processes for GPU, utility, renderer, etc.
// Only real crashes (crashed / launch-failed / abnormal-exit) are
// fatal — 'killed' means an external actor ended the process
// (task manager, OOM killer, parent cleanup), not our bug.
//
// Utility processes like Network Service can be killed by the OS
// under memory pressure; Electron will restart them automatically.
// ============================================================
app.on('child-process-gone', (_event, details) => {
  log('child-process-gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: (details as unknown as Record<string, unknown>).serviceName,
    name: (details as unknown as Record<string, unknown>).name
  });

  // Only treat genuine crashes as fatal.
  // 'killed' = external termination (task manager, OOM, WPF cleanup) — not a bug.
  const isFatal =
    details.reason === 'crashed' ||
    details.reason === 'launch-failed' ||
    details.reason === 'abnormal-exit';

  if (isFatal && (details.type === 'GPU' || details.type === 'Utility')) {
    logFatal(
      `child-process-gone FATAL: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
      details
    );
    app.exit(1);
  }
});

app.on('render-process-gone', (_event, _webContents, details) => {
  log('render-process-gone (app-level)', {
    reason: details.reason,
    exitCode: details.exitCode
  });
});

// ============================================================
// Process-level error guards
//
// When AI_maid closes / crashes / is killed, the named pipe breaks.
// Any subsequent write to the pipe (or to stderr/stdout) throws EPIPE.
// Electron's default behavior is to pop a "A JavaScript error occurred
// in the main process" dialog — we must suppress that.
//
// Strategy:
//   - EPIPE-family errors → log and silently shut down
//   - Real bugs → log to file + stderr, then exit(1)
//   - NEVER re-throw in process-level handlers → that triggers the dialog
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
    log('uncaughtException (silent, pipe disconnected)', {
      code: (err as { code?: string }).code,
      message: err.message
    });
    shutdown('PipeDisconnected');
    return;
  }

  // Real error — write to log, then exit cleanly.
  // Do NOT re-throw — that would trigger Electron's error dialog.
  logFatal('uncaughtException (fatal)', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  if (isSilentError(reason)) {
    log('unhandledRejection (silent, pipe disconnected)', {
      code: (reason as { code?: string }).code,
      message: (reason as Error)?.message ?? String(reason)
    });
    return;
  }

  // Non-silent unhandled rejection — log and exit.
  // These often come from async startup failures that would otherwise
  // silently kill the process with no diagnostic info.
  logFatal('unhandledRejection (fatal)', reason);
  process.exit(1);
});

let startupArgs: StartupArgs;
let parentWatcher: ParentWatcher | null = null;
let isQuitting = false;

app.whenReady().then(() => {
  try {
    startupArgs = parseStartupArgs(process.argv);

    // Configure log directory if provided (must happen before first log)
    if (startupArgs.logDir) {
      setLogDir(startupArgs.logDir);
    }

    const logFilePath = getLogFilePath();

    // ============================================================
    // Requirement 4 (previous): Startup diagnostic banner
    // Logs PID, cwd, argv, pipeName, parentPid, logDir, resource
    // paths — all in the first ~50 log lines.
    // ============================================================
    logStartupBanner({
      pipeName: startupArgs.pipeName,
      parentPid: startupArgs.parentPid,
      logDir: startupArgs.logDir,
      logFilePath,
      model: startupArgs.model,
      noDefaultModel: startupArgs.noDefaultModel,
      argv: process.argv,
      cwd: process.cwd(),
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      platform: process.platform
    });

    log('Renderer starting');

    // Log GPU status for diagnostics
    log('GPU status', {
      gpuFeatureStatus: app.getGPUFeatureStatus(),
      hardwareAccelerationDisabled: true
    });

    log('Env check', {
      isPackaged: app.isPackaged,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      electronRendererUrl: process.env.ELECTRON_RENDERER_URL || 'NOT SET',
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
      cwd: process.cwd(),
      arch: process.arch,
      platform: process.platform,
      userData: app.getPath('userData')
    });

    // ============================================================
    // Requirement 7: Log full command line for Process Explorer
    // cross-reference. Each process.argv entry is logged so we can
    // correlate with Process Explorer's Command Line column.
    // ============================================================
    log('Full command line (for Process Explorer cross-reference)', {
      execPath: process.execPath,
      argvCount: process.argv.length,
      argv: process.argv.map((a, i) => `[${i}] ${a}`)
    });

    // ============================================================
    // Initialization (each step wrapped for clear error reporting)
    // ============================================================

    registerWindowIpc();
    log('IPC registered');

    const mainWindow = createRendererWindow();
    log('Renderer window created', { id: mainWindow.id });

    // Start the protocol transport (Named Pipe for AI_maid mode, stdio for debug).
    const router: CommandRouter = (command, requestId) => {
      handleAiMaidCommand(command, requestId);
    };
    startProtocol(startupArgs, router, (reason) => {
      log('Protocol transport disconnected, initiating shutdown', { reason });
      shutdown('PipeDisconnected');
    });

    log('Protocol transport started', {
      mode: isAiMaidMode(startupArgs) ? 'pipe' : 'stdio',
      pipeName: startupArgs.pipeName
    });

    // Start parent process watcher if --parent-pid provided
    if (startupArgs.parentPid && startupArgs.parentPid > 0) {
      parentWatcher = new ParentWatcher(startupArgs.parentPid, () => {
        log('Parent process exited, shutting down');
        shutdown('AI_maidExit');
      });
      parentWatcher.start();
      log('ParentWatcher started', { parentPid: startupArgs.parentPid });
    }

    // ============================================================
    // Startup SUCCESS — clear crash tracker.
    // From this point, any future crash is a "new" crash,
    // not a rapid restart storm.
    // ============================================================
    clearCrashTracker();
    log('Startup complete — crash tracker cleared');
  } catch (err) {
    // ============================================================
    // Initialization failure — log clearly and exit.
    // Covers: missing files, config errors, BrowserWindow failure,
    // protocol registration failure, pipe connect failure, etc.
    // ============================================================
    logFatal('Initialization failed — renderer cannot start', err);
    process.exit(1);
  }
});

app.on('window-all-closed', () => {
  log('All windows closed');
  shutdown('WindowClosed');
});

app.on('before-quit', () => {
  log('Renderer exiting');
});

app.on('quit', () => {
  log('Renderer quit');
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
