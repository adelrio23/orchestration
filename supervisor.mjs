import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartDecision } from './lib/supervision.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.COORDINATOR_DATA || path.join(root, 'data'));
const log = path.join(data, 'supervisor.jsonl');
fs.mkdirSync(data, { recursive: true });

let child = null;
let stopping = false;
let starts = [];

function record(event, detail = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n';
  try { fs.appendFileSync(log, line, { encoding: 'utf8', mode: 0o600 }); }
  catch (error) { console.error('Could not write supervisor history:', error.message); }
}

function launch() {
  const startedAt = Date.now();
  console.log('Starting coordinator under crash supervision.');
  record('started', { pid: process.pid });
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: { ...process.env, COORDINATOR_SUPERVISED: '1' },
    stdio: 'inherit',
    windowsHide: true
  });
  child.once('error', error => {
    record('spawn_error', { message: error.message });
    handleExit(null, 'spawn_error', startedAt);
  });
  child.once('exit', (code, signal) => handleExit(code, signal, startedAt));
}

function handleExit(code, signal, startedAt) {
  child = null;
  if (Date.now() - startedAt >= 600000) starts = [];
  const decision = restartDecision({ code, signal, stopping, starts });
  starts = decision.starts;
  record('stopped', { code, signal, decision: decision.reason, delayMs: decision.delayMs || null });
  if (!decision.restart) {
    if (decision.reason === 'restart_cap') {
      console.error('Coordinator crashed too often (8 times in one hour). Restarting has stopped to prevent a loop. Inspect data/supervisor.jsonl and run node doctor.mjs.');
      process.exitCode = 1;
    }
    return;
  }
  console.error(`Coordinator stopped unexpectedly. Restarting in ${Math.ceil(decision.delayMs / 1000)} seconds; durable state will be reloaded.`);
  setTimeout(launch, decision.delayMs);
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  record('operator_stop', { signal });
  if (child) child.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

launch();
