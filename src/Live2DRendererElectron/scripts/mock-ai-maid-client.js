#!/usr/bin/env node
/**
 * Mock AI_maid client for testing the Live2DRenderer Named Pipe protocol.
 *
 * Usage:
 *   node scripts/mock-ai-maid-client.js [modelPath]
 *
 * Flow:
 *   1. Creates a Named Pipe server at \\.\pipe\ai_maid-live2d-mock-<pid>
 *   2. Launches Live2DRenderer (dev mode: electron .) with --pipe-name
 *   3. Waits for Live to connect and send RendererReady
 *   4. Sends Init → expects InitAck
 *   5. Sends LoadModel → expects ModelLoaded (or ModelLoadFailed)
 *   6. Waits 2s, sends SetActionTag(speak)
 *   7. Waits 3s, sends SpeakStop
 *   8. Tails events for 60s, then sends Close
 *
 * Requirements:
 *   - Run from the Live2DRendererElectron directory (npm run dev must be available)
 *   - Or set ELECTRON_PATH and APP_DIR env vars
 */

const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const APP_DIR = process.env.APP_DIR || path.resolve(__dirname, '..');
// Priority: RENDERER_EXE (real wrapper) > ELECTRON_PATH (dev electron) > default
const RENDERER_EXE = process.env.RENDERER_EXE ||
  path.join(APP_DIR, '..', '..', 'release', 'MaidAI', 'Live2DRenderer', 'Live2DRenderer.exe');
const ELECTRON_PATH = process.env.ELECTRON_PATH ||
  path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
// Use real wrapper exe if it exists, otherwise fall back to dev electron
const USE_WRAPPER = fs.existsSync(RENDERER_EXE);
const LAUNCH_EXE = USE_WRAPPER ? RENDERER_EXE : ELECTRON_PATH;
const LAUNCH_ARGS_PREFIX = USE_WRAPPER ? [] : [APP_DIR]; // wrapper doesn't need APP_DIR, electron does
const ASSETS_ROOT = process.env.ASSETS_ROOT ||
  path.resolve(APP_DIR, '..', '..', 'assests', 'live2d');
const PIPE_NAME = `ai_maid-live2d-mock-${process.pid}`;
const PIPE_PATH = `\\\\.\\pipe\\${PIPE_NAME}`;
const LOG_DIR = path.join(APP_DIR, 'release', 'MaidAI', 'logs');

// --- Helpers ---
let requestId = 0;

function nextRequestId() {
  requestId += 1;
  return String(requestId);
}

function makeEnvelope(payload, id = null) {
  return {
    type: payload.type,
    requestId: id,
    timestamp: new Date().toISOString(),
    payload
  };
}

function sendCommand(socket, payload, id = null) {
  const env = makeEnvelope(payload, id);
  const line = JSON.stringify(env) + '\n';
  console.log(`[SEND] ${JSON.stringify(env)}`);
  socket.write(line, 'utf8');
}

function findModelPath() {
  if (process.argv[2]) {
    return process.argv[2].replace(/\\/g, '/');
  }
  // Auto-discover first .model3.json under assets
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.endsWith('.model3.json')) {
        return full;
      }
    }
    return null;
  }
  const found = walk(ASSETS_ROOT);
  if (!found) {
    console.error(`No .model3.json found under ${ASSETS_ROOT}`);
    console.error('Pass a model path as the first argument.');
    process.exit(1);
  }
  return found.replace(/\\/g, '/');
}

// --- Main ---
async function main() {
  const modelPath = findModelPath();
  console.log(`[MOCK] Model path: ${modelPath}`);
  console.log(`[MOCK] Pipe: ${PIPE_PATH}`);
  console.log(`[MOCK] Log dir: ${LOG_DIR}`);

  // Ensure log dir exists
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

  // Create Named Pipe server
  const server = net.createServer((socket) => {
    console.log('[MOCK] Live connected to pipe');
    handleLiveConnection(socket, modelPath);
  });

  server.on('error', (err) => {
    console.error('[MOCK] Server error:', err.message);
    process.exit(1);
  });

  // Listen on the named pipe
  await new Promise((resolve) => {
    server.listen(PIPE_PATH, resolve);
  });
  console.log('[MOCK] Pipe server listening');

  // Launch Live2DRenderer
  const args = [
    ...LAUNCH_ARGS_PREFIX,
    '--pipe-name', PIPE_NAME,
    '--parent-pid', String(process.pid),
    '--log-dir', LOG_DIR
  ];
  console.log(`[MOCK] Use wrapper: ${USE_WRAPPER}`);
  console.log(`[MOCK] Launching: ${LAUNCH_EXE} ${args.join(' ')}`);

  const liveProc = spawn(LAUNCH_EXE, args, {
    cwd: USE_WRAPPER ? path.dirname(LAUNCH_EXE) : APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  liveProc.stdout.on('data', (data) => {
    process.stdout.write(`[LIVE STDOUT] ${data}`);
  });
  liveProc.stderr.on('data', (data) => {
    process.stderr.write(`[LIVE STDERR] ${data}`);
  });
  liveProc.on('exit', (code) => {
    console.log(`[MOCK] Live exited with code ${code}`);
    server.close();
    process.exit(code ?? 0);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('[MOCK] SIGINT received, killing Live...');
    liveProc.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  });
}

let initSent = false;
let modelLoadSent = false;
let speakSent = false;

function handleLiveConnection(socket, modelPath) {
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      handleEvent(socket, trimmed, modelPath);
    }
  });

  socket.on('end', () => {
    console.log('[MOCK] Live disconnected');
  });

  socket.on('error', (err) => {
    console.error('[MOCK] Socket error:', err.message);
  });
}

function handleEvent(socket, line, modelPath) {
  let envelope;
  try {
    envelope = JSON.parse(line);
  } catch {
    console.error(`[MOCK] Failed to parse: ${line}`);
    return;
  }

  console.log(`[RECV] ${JSON.stringify(envelope)}`);

  const type = envelope.type;

  if (type === 'RendererReady' && !initSent) {
    initSent = true;
    setTimeout(() => {
      sendCommand(socket, {
        type: 'Init',
        protocolVersion: 1,
        appName: 'AI_maid-Mock',
        parentPid: process.pid
      }, nextRequestId());
    }, 300);
    return;
  }

  if (type === 'InitAck' && !modelLoadSent) {
    modelLoadSent = true;
    if (envelope.payload?.ok) {
      console.log('[MOCK] InitAck ok, sending LoadModel in 500ms...');
      setTimeout(() => {
        sendCommand(socket, {
          type: 'LoadModel',
          roleId: 'mock-character',
          roleName: '测试角色',
          modelPath: modelPath,
          initialTransform: { scale: 1.0 }
        }, nextRequestId());
      }, 500);
    } else {
      console.error('[MOCK] InitAck failed, not sending LoadModel');
    }
    return;
  }

  if (type === 'ModelLoaded' && !speakSent) {
    speakSent = true;
    console.log('[MOCK] ModelLoaded, sending SetActionTag(speak) in 2s...');
    setTimeout(() => {
      sendCommand(socket, {
        type: 'SetActionTag',
        actionTag: 'speak',
        source: 'llm_reply',
        durationMs: 5000
      }, nextRequestId());

      // Send SpeakStop after 3s
      setTimeout(() => {
        sendCommand(socket, {
          type: 'SpeakStop',
          reason: 'finished'
        }, nextRequestId());
      }, 3000);

      // Send SetExpression after another 2s
      setTimeout(() => {
        sendCommand(socket, {
          type: 'SetExpression',
          name: 'smile',
          durationMs: 3000
        }, nextRequestId());
      }, 6000);

      // Send Close after 15s
      setTimeout(() => {
        console.log('[MOCK] Sending Close...');
        sendCommand(socket, {
          type: 'Close',
          reason: 'MockTestComplete'
        }, nextRequestId());
      }, 15000);
    }, 2000);
    return;
  }

  if (type === 'ModelLoadFailed') {
    console.error('[MOCK] ModelLoadFailed, waiting for further commands...');
    return;
  }

  if (type === 'Closed') {
    console.log('[MOCK] Live sent Closed event');
    setTimeout(() => process.exit(0), 300);
    return;
  }
}

main().catch((err) => {
  console.error('[MOCK] Fatal error:', err);
  process.exit(1);
});
