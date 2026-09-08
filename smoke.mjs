import fs from 'node:fs';
import path from 'node:path';
import { discover, preflight, invocation, parseResult } from './lib/adapters.mjs';
import { run } from './lib/process.mjs';
import { git } from './lib/core.mjs';
const name = process.argv[2];
if (!['codex', 'kimi'].includes(name)) throw Error('Smoke supports codex or kimi only. Claude intentionally excluded until quota recovery.');
const cfg = discover()[name];
const cwd = path.resolve('data/verification/smoke-repo'); fs.mkdirSync(cwd, { recursive: true });
if (!fs.existsSync(path.join(cwd, '.git'))) { git(cwd, 'init'); fs.writeFileSync(path.join(cwd, 'README.md'), '# Disposable smoke fixture\n'); git(cwd, 'add', 'README.md'); git(cwd, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initialize fixture'); }
await preflight(name, cfg, cwd);
const spec = invocation(name, cfg, 'Reply with exactly COORDINATOR_OK. Do not use tools, read files, or make changes.', 'review', cwd);
const raw = await run(spec.command, spec.args, { cwd, input: spec.input, timeout: 60000, maxBytes: 200000 });
const parsed = parseResult(name, raw);
fs.mkdirSync('data/verification', { recursive: true });
fs.writeFileSync(path.join('data/verification', name + '-smoke.json'), JSON.stringify({ at: new Date().toISOString(), ...parsed, output: raw.output }, null, 2));
console.log(JSON.stringify(parsed, null, 2));
if (parsed.status !== 'ok' || !parsed.text.includes('COORDINATOR_OK')) process.exitCode = 1;
