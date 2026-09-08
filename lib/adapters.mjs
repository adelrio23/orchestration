import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, safeEnv } from './process.mjs';

export function discover() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  let codex = 'codex';
  const root = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'OpenAI/Codex/bin');
  if (fs.existsSync(root)) {
    const candidates = fs.readdirSync(root).map(x => path.join(root, x, 'codex.exe')).filter(x => fs.existsSync(x));
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    codex = candidates[0] || codex;
  }
  const kimi = path.join(home, '.kimi-code/bin/kimi.exe');
  return {
    codex: { command: codex },
    kimi: { command: fs.existsSync(kimi) ? kimi : 'kimi' },
    claude: { command: process.platform === 'win32' ? 'wsl.exe' : 'claude', wsl: process.platform === 'win32' }
  };
}

export function invocation(name, config, prompt, role, cwd) {
  const model = config.models?.[role] || config.model;
  const modelArgs = model ? ['--model', model] : [];
  if (name === 'codex') return { command: config.command, args: ['exec', ...modelArgs, '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--json', '--color', 'never', '-'], input: prompt };
  if (name === 'kimi') return { command: config.command, args: ['--model', model || 'kimi-code/kimi-for-coding', '--agent-file', fileURLToPath(new URL('../profiles/kimi-reader.md', import.meta.url)), '-p', prompt, '--output-format', 'stream-json'] };
  if (name === 'claude') {
    const args = [...modelArgs, '--print', '--output-format', 'json', '--permission-mode', 'plan', '--no-session-persistence', '--strict-mcp-config', '--tools', 'Read,Glob,Grep'];
    // WSL --exec passes argv directly, with no shell interpolation. CLI prompt travels over stdin.
    if (config.wsl) {
      const unix = cwd.replaceAll('\\', '/').replace(/^([a-zA-Z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
      return { command: config.command, args: ['--cd', unix, '--exec', 'env', '-u', 'ANTHROPIC_API_KEY', '-u', 'ANTHROPIC_AUTH_TOKEN', '-u', 'ANTHROPIC_BASE_URL', '-u', 'CLAUDE_CODE_USE_BEDROCK', '-u', 'CLAUDE_CODE_USE_VERTEX', '-u', 'CLAUDE_CODE_USE_FOUNDRY', 'timeout', '--kill-after=5s', '300s', 'claude', ...args], input: prompt };
    }
    return { command: config.command, args, input: prompt };
  }
  throw Error('Unknown adapter');
}

export function parseResult(name, result) {
  const events = result.output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  if (!events.length) { try { events.push(JSON.parse(result.output)); } catch {} }
  const terminal = events.filter(e => ['result', 'turn.completed', 'turn.failed'].includes(e.type));
  const texts = events.flatMap(e => {
    if (e.role === 'assistant' && typeof e.content === 'string') return [e.content];
    if (e.type === 'result') return [e.result || e.error || ''];
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') return [e.item.text || ''];
    if (e.type === 'assistant' && e.message?.content) return e.message.content.filter(c => c.type === 'text').map(c => c.text);
    return [];
  });
  let status = result.code === 0 ? 'ok' : 'error';
  const errors = events.filter(e => /error|fail/.test(e.type || '') || e.is_error).map(e => JSON.stringify(e)).join('\n');
  const diagnostic = `${result.reason}\n${errors}\n${status !== 'ok' ? result.output : texts.join('\n')}`;
  if (result.reason || result.code === 124 || result.code === 137) status = 'interrupted';
  else if (/quota|rate.?limit|usage.?limit|out of usage|hit your limit|insufficient.credit|429/i.test(diagnostic)) status = 'quota';
  else if (/unauthorized|not logged in|authentication|login required|401|invalid.api.key/i.test(diagnostic)) status = 'auth';
  else if (result.reason || errors || terminal.some(e => e.is_error)) status = 'error';
  if (status === 'ok' && !texts.join('').trim()) status = 'protocol';
  const usageEvent = [...events].reverse().find(e => e.usage && (e.type === 'result' || e.type === 'turn.completed'));
  const usage = usageEvent ? { source: 'measured_cli', values: usageEvent.usage } : { source: 'unavailable', values: null };
  const reportedModels = [...new Set(events.flatMap(e => [e.model, e.message?.model, ...Object.keys(e.modelUsage || {})]).filter(v => typeof v === 'string'))];
  return { reportedModels, status, text: texts.join('\n').slice(-120000), usage, durationMs: result.durationMs, exitCode: result.code, diagnostic: status === 'ok' ? '' : result.output.slice(-3000) };
}

export async function preflight(name, config, cwd) {
  let command = config.command, args;
  if (name === 'codex') args = ['login', 'status'];
  if (name === 'kimi') args = ['provider', 'list'];
  if (name === 'claude') args = config.wsl ? ['--cd', cwd.replaceAll('\\', '/').replace(/^([a-zA-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`), '--exec', 'claude', 'auth', 'status'] : ['auth', 'status'];
  const r = await run(command, args, { cwd, timeout: 15000, env: safeEnv() });
  if (r.code !== 0) throw Error(`${name}: authentication check failed (no model call made)`);
  if (name === 'codex' && !/ChatGPT/i.test(r.output)) throw Error('Codex must use ChatGPT login');
  if (name === 'kimi' && !/managed:kimi-code.*source=oauth/.test(r.output)) throw Error('Kimi managed OAuth provider required');
  if (name === 'claude') {
    let auth; try { auth = JSON.parse(r.output); } catch { throw Error('Claude auth status unavailable'); }
    if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty') throw Error('Claude subscription login required');
  }
  return true;
}

export async function execute(name, config, prompt, role, cwd, limits, signal) {
  await preflight(name, config, cwd);
  const spec = invocation(name, config, prompt, role, cwd);
  const result = await run(spec.command, spec.args, { cwd, input: spec.input, timeout: limits.timeoutMs, maxBytes: limits.maxOutputBytes, signal });
  return { ...parseResult(name, result), requestedModel: config.models?.[role] || config.model || (name === 'kimi' ? 'kimi-code/kimi-for-coding' : null) };
}
