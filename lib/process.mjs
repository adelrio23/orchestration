import { spawn, spawnSync } from 'node:child_process';

export function safeEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CLAUDECODE|ANTHROPIC_BASE_URL|OPENAI_BASE_URL|CLAUDE_CODE_USE_|WSLENV/i.test(key)) delete env[key];
  }
  // Windows sandbox shells may omit HOME. Never copy or print credentials.
  if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  return env;
}

export function redact(text) {
  return String(text).replace(/(?:sk-|sk-ant-)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|authorization)["'\s]*[:=]["'\s]*)([^\s,"'}]+)/gi, '$1[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

export function run(command, args, { cwd, input = '', timeout = 300000, maxBytes = 2000000, signal, env = safeEnv() } = {}) {
  return new Promise(resolve => {
    let child, output = '', reason = '', ended = false, bytes = 0, terminationTimer;
    const started = Date.now();
    const finish = (code) => {
      if (ended) return;
      ended = true; clearTimeout(timer); clearTimeout(terminationTimer); signal?.removeEventListener('abort', stop);
      resolve({ code, output: redact(output), reason, durationMs: Date.now() - started });
    };
    const stop = () => {
      reason ||= 'cancelled';
      if (terminationTimer || ended) return;
      terminationTimer = setTimeout(() => { reason = 'termination_uncertain'; child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); finish(-1); }, 6000);
      if (!child?.pid) return;
      // Only terminate the process tree launched by this invocation.
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
        if (killed.status !== 0) { reason = 'termination_uncertain'; child.kill('SIGKILL'); }
      }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { reason = 'timeout'; stop(); }, timeout);
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', error => { output += error.message; finish(-1); });
      const collect = chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { reason = 'output_limit'; stop(); return; }
        output += chunk.toString();
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.on('close', code => finish(code ?? -1));
      child.stdin.on('error', () => {}); child.stdin.end(input);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    } catch (error) { output += error.message; finish(-1); }
  });
}
