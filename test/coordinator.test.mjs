import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Coordinator, git } from '../lib/core.mjs';
import { parseResult, invocation } from '../lib/adapters.mjs';
import { run, safeEnv, redact } from '../lib/process.mjs';
import { createServer } from '../server.mjs';
import { createLocal, createProject, githubTarget, pushCandidate } from '../lib/repositories.mjs';

const fixtures = path.resolve('data/test-fixtures'); fs.mkdirSync(fixtures, { recursive: true });
function fixture(executor, testRunner) {
  const dir = fs.mkdtempSync(path.join(fixtures, 'case-')), repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init'); fs.writeFileSync(path.join(repo, 'app.txt'), 'initial\n'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Tests', '-c', 'user.email=tests@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  const c = new Coordinator(path.join(dir, 'state'), { executor, testRunner: testRunner || (async () => ({ code: 0, reason: '', output: 'Passed', durationMs: 1 })) });
  c.configure({ repo, requirements: 'A useful app', testCommands: [[process.execPath, '--test']] }); return c;
}
function add(c, extra = {}) { return c.addTask({ title: 'Implement app', requirements: 'Update app', acceptance: 'App has new content', scope: ['app.txt'], ...extra }); }
function okay(text = 'Implemented') { return { status: 'ok', text, usage: { source: 'unavailable', values: null }, durationMs: 1 }; }
async function drain(c) { for (let i = 0; i < 500 && c.running.size; i++) await new Promise(r => setTimeout(r, 10)); assert.equal(c.running.size, 0, 'work drained'); }
async function stage(c) { c.tick(); await drain(c); }
async function ready() {
  const c = fixture(async (provider, config, prompt, role, cwd) => { if (role === 'build') fs.writeFileSync(path.join(cwd, 'app.txt'), 'new\n'); return okay(role === 'review' ? 'All criteria met.\nREVIEW: PASS' : 'Implemented and tested'); });
  const t = add(c); c.control('start'); await stage(c); await stage(c); assert.equal(t.status, 'ready'); c.control('pause'); return { c, t };
}

test('full build → independent review → controlled integration leaves source untouched', async () => {
  const { c, t } = await ready(); const original = git(c.state.repo, 'rev-parse', 'HEAD');
  assert.notEqual(t.builder, t.review.provider); assert.notEqual(t.worktree, t.reviewTree);
  await c.integrate(t.id); assert.equal(t.status, 'integrated'); assert.equal(git(c.state.repo, 'rev-parse', 'HEAD'), original);
  assert.equal(fs.readFileSync(path.join(c.state.repo, 'app.txt'), 'utf8'), 'initial\n');
  assert.equal(fs.readFileSync(path.join(c.state.integration.dir, 'app.txt'), 'utf8').trim(), 'new');
  assert.equal(c.state.calls, 2);
});
test('quota checkpoints edits, reassigns eligible builder, never retries blocked provider', async () => {
  const calls = [];
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    calls.push(provider);
    if (provider === 'claude') { fs.writeFileSync(path.join(cwd, 'app.txt'), 'partial'); return { status: 'quota', diagnostic: 'Usage limit reached' }; }
    assert.match(fs.readFileSync(path.join(cwd, 'app.txt'), 'utf8'), /partial/); return okay('<coordinator-files>{"files":[{"path":"app.txt","content":"done"}]}</coordinator-files>');
  });
  c.provider('claude', true); const t = add(c, { eligible: ['claude', 'kimi'] }); c.control('start');
  await stage(c); assert.equal(t.status, 'queued'); assert.match(c.state.providers.claude.blocked, /quota/);
  await stage(c); await stage(c); assert.equal(t.status, 'waiting'); assert.deepEqual(calls, ['claude', 'kimi']);
  for (let i = 0; i < 5; i++) c.tick(); assert.deepEqual(calls, ['claude', 'kimi']);
});
test('simulated Claude recovery requires explicit enable; independent review resumes', async () => {
  const c = fixture(async (provider, config, prompt, role, cwd) => { if (role === 'build') fs.writeFileSync(path.join(cwd, 'app.txt'), 'new'); return okay(role === 'review' ? 'REVIEW: PASS' : 'done'); });
  const t = add(c, { eligible: ['codex', 'claude'] }); c.control('start'); await stage(c); await stage(c); assert.equal(t.status, 'waiting');
  c.provider('claude', true); await stage(c); assert.equal(t.status, 'ready'); assert.equal(t.review.provider, 'claude');
});
test('auth failure blocks provider and attempt/call caps survive restart', async () => {
  const c = fixture(async () => ({ status: 'auth', diagnostic: 'Login required' })); c.setLimits({ maxCalls: 1 }); const t = add(c); c.control('start'); await stage(c); await stage(c);
  assert.equal(c.state.calls, 1); assert.equal(c.state.mode, 'paused'); assert.match(c.state.providers.codex.blocked, /auth/);
  const reload = new Coordinator(c.dir); assert.equal(reload.state.calls, 1); assert.equal(reload.task(t.id).handoffs.length, 1);
});
test('pause drains active call and resume cannot overlap ownership', async () => {
  let finish;
  const c = fixture(async (p, cfg, prompt, role, cwd) => { fs.writeFileSync(path.join(cwd, 'app.txt'), 'new'); await new Promise(r => finish = r); return okay(); });
  const t = add(c); c.control('start'); c.tick(); c.tick(); assert.equal(c.state.calls, 1); c.control('pause'); assert.equal(t.status, 'building');
  finish(); await drain(c); c.tick(); assert.equal(c.state.calls, 1); assert.equal(t.status, 'queued');
});
test('parallel requires explicit independence and disjoint ownership', async () => {
  const releases = [];
  const c = fixture(async () => { await new Promise(r => releases.push(r)); return { status: 'error', diagnostic: 'finish' }; });
  c.setLimits({ concurrency: 3 }); add(c, { independent: true }); add(c, { independent: true }); add(c, { independent: true, scope: ['other.txt'] }); c.control('start'); c.tick();
  assert.equal(c.running.size, 2); releases.forEach(r => r()); await drain(c);
});
test('dependencies wait for integrated acceptance', async () => {
  const c = fixture(async () => ({ status: 'error' })); const a = add(c); const b = add(c, { dependencies: [a.id], scope: ['other.txt'] }); c.control('start'); await stage(c); c.tick(); assert.equal(b.status, 'queued'); assert.equal(c.state.calls, 1);
});
test('out-of-scope edits cannot become candidate commits', async () => {
  const c = fixture(async (p, cfg, prompt, role, cwd) => { fs.writeFileSync(path.join(cwd, 'extra.txt'), 'bad'); return okay(); }); const t = add(c); c.control('start'); await stage(c); assert.equal(t.status, 'blocked'); assert.match(t.blocked, /outside owned scope/); assert.equal(t.commit, undefined);
});
test('tests mutating existing candidate invalidate tested content', async () => {
  const c = fixture(async (p, cfg, prompt, role, cwd) => { fs.writeFileSync(path.join(cwd, 'app.txt'), 'new'); return okay(); }, async (cmd, args, { cwd }) => { fs.writeFileSync(path.join(cwd, 'app.txt'), 'unverified mutation'); return { code: 0, output: '', reason: '' }; });
  const t = add(c); c.control('start'); await stage(c); assert.equal(t.status, 'blocked'); assert.match(t.blocked, /changed candidate/); assert.equal(t.commit, undefined);
});
test('failed tests block review and preserve work', async () => {
  const c = fixture(async (p, cfg, prompt, role, cwd) => { fs.writeFileSync(path.join(cwd, 'app.txt'), 'new'); return okay(); }, async () => ({ code: 1, output: 'assertion failed', reason: '' }));
  const t = add(c); c.control('start'); await stage(c); assert.equal(t.status, 'blocked'); assert.equal(c.state.calls, 1); assert.equal(t.tests.passed, false);
});
test('review failure cannot integrate', async () => {
  const c = fixture(async (p, cfg, prompt, role, cwd) => { if (role === 'build') fs.writeFileSync(path.join(cwd, 'app.txt'), 'new'); return okay(role === 'review' ? 'Bug found.\nREVIEW: FAIL' : 'done'); });
  const t = add(c); c.control('start'); await stage(c); await stage(c); c.control('pause'); await assert.rejects(c.integrate(t.id), /Passing tests/);
});
test('candidate tampering after review prevents integration', async () => { const { c, t } = await ready(); fs.writeFileSync(path.join(t.worktree, 'app.txt'), 'tampered'); await assert.rejects(c.integrate(t.id), /changed since review/); });
test('integration holds dispatch lock and rejects test mutations', async () => {
  const { c, t } = await ready(); let release;
  c.testRunner = async (cmd, args, { cwd }) => { await new Promise(r => release = r); fs.writeFileSync(path.join(cwd, 'app.txt'), 'mutation'); return { code: 0, reason: '', output: '' }; };
  const job = c.integrate(t.id); assert.throws(() => c.control('resume'), /integration/); c.tick(); assert.equal(c.state.calls, 2); release(); await assert.rejects(job, /changed integration/); assert.equal(t.status, 'blocked');
});
test('crash recovery checkpoints ownership and requires explicit process confirmation', () => {
  const c = fixture(); const t = add(c); t.status = 'building'; t.owner = 'codex'; c.save(); const reload = new Coordinator(c.dir); assert.equal(reload.task(t.id).status, 'interrupted'); assert.equal(reload.state.mode, 'paused'); assert.throws(() => reload.retry(t.id), /Confirm old processes/); reload.retry(t.id, 'old processes stopped'); assert.equal(reload.task(t.id).status, 'queued');
});
test('termination uncertainty pauses and requires process confirmation', async () => {
  const c = fixture(async () => ({ status: 'interrupted', diagnostic: 'timeout' })); const t = add(c); c.control('start'); await stage(c); assert.equal(t.status, 'interrupted'); assert.equal(c.state.mode, 'paused'); assert.throws(() => c.retry(t.id), /Confirm old processes/);
});
test('scope traversal, sensitive paths and invalid limits are rejected', () => {
  const c = fixture(); for (const scope of ['../x', 'C:/x', '.git/config', '/root', 'src/../x']) assert.throws(() => add(c, { scope: [scope] })); assert.throws(() => c.setLimits({ concurrency: 20 })); assert.throws(() => c.setLimits({ maxCalls: NaN }));
});
test('adapters preserve permissions and omit paid fallback flags', () => {
  const configs = { codex: { command: 'codex' }, kimi: { command: 'kimi' }, claude: { command: 'wsl.exe', wsl: true } };
  for (const name of Object.keys(configs)) { const spec = invocation(name, configs[name], 'hello $(danger)', 'build', 'C:/repo with spaces'); assert.doesNotMatch(spec.args.join(' '), /bypass|dangerously|--auto|--yolo|fallback-model/); }
  assert.equal(invocation('claude', configs.claude, 'secret prompt', 'review', 'C:/repo with spaces').input, 'secret prompt');
});
test('parses measured usage, auth, quota, malformed output and termination conservatively', () => {
  const p = output => parseResult('codex', { code: 0, output, durationMs: 1 });
  assert.equal(p('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":42}}').usage.source, 'measured_cli');
  assert.equal(p('{"type":"result","is_error":true,"result":"Usage limit reached"}').status, 'quota');
  assert.equal(p('{"type":"result","is_error":true,"result":"Authentication required"}').status, 'auth');
  assert.equal(p('not JSON').status, 'protocol');
  assert.equal(p('{"role":"meta","type":"system.version","version":"0.41.0"}\n{"role":"assistant","content":"COORDINATOR_OK"}').text, 'COORDINATOR_OK');
  assert.equal(parseResult('claude', { code: -1, output: '', reason: 'termination_uncertain' }).status, 'interrupted');
});
test('automatic integration runs once after approval', async () => {
  const { c, t } = await ready(); c.control('resume'); c.tick();
  for (let i = 0; i < 200 && c.integrating; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(t.status, 'integrated'); assert.ok(t.integrationAttempt);
  c.tick(); assert.equal(c.state.calls, 2); c.control('pause'); await assert.rejects(c.integrate(t.id), /already attempted/);
});
test('chat is durable, read-only, bounded and respects active ownership', async () => {
  let calledRole;
  const c = fixture(async (p, cfg, prompt, role) => { calledRole = role; return okay('Here is the design.'); });
  const response = await c.chat({ provider: 'codex', message: 'Explain the design' }); assert.equal(calledRole, 'review'); assert.equal(response.status, 'ok'); assert.equal(c.state.calls, 1);
  const reload = new Coordinator(c.dir); assert.equal(reload.state.chats[0].response, 'Here is the design.');
  c.control('start'); await assert.rejects(c.chat({ provider: 'codex', message: 'Again' }), /Pause/);
});
test('local repo creation never overwrites an existing project', () => {
  const c = fixture(); const result = createLocal(c, 'brand-new-app'); assert.ok(fs.existsSync(path.join(result.repo, '.git'))); assert.throws(() => createLocal(c, 'brand-new-app')); assert.throws(() => createLocal(c, '../escape'));
});
test('GitHub creation and push each occur at most once and never force or publish publicly', async () => {
  const { c, t } = await ready(); const calls = [];
  const fake = async (command, args) => { calls.push([command, ...args]); return { code: 0, reason: '', output: args.includes('view') ? '{"nameWithOwner":"example/my-app","isPrivate":true}' : 'ok' }; };
  await githubTarget(c, { name: 'example/my-app', create: true, authorizeAutoPush: true }, fake);
  assert.ok(calls.some(args => args.includes('--private'))); assert.ok(!calls.some(args => args.includes('--public')));
  await assert.rejects(githubTarget(c, { name: 'example/my-app', create: true }, fake), /already attempted/);
  await c.integrate(t.id); await pushCandidate(c, t, fake); assert.equal(t.pushAttempt.status, 'pushed');
  const count = calls.length; await assert.rejects(pushCandidate(c, t, fake), /already attempted/); assert.equal(calls.length, count);
  assert.ok(!calls.some(args => args.includes('--force')));
});
test('failed push stays checkpointed and cannot storm retry', async () => {
  const { c, t } = await ready(); await c.integrate(t.id);
  c.state.github = { authorized: true, repo: c.state.repo, name: 'example/my-app', url: 'https://github.com/example/my-app.git', branch: c.state.integration.branch };
  let count = 0; const fail = async (cmd, args) => { if (!args.includes('push')) return { code: 0, output: '', reason: '' }; count++; return { code: 1, output: 'auth failed', reason: '' }; };
  await assert.rejects(pushCandidate(c, t, fail), /Push failed/); await assert.rejects(pushCandidate(c, t, fail), /already attempted/); assert.equal(count, 1); assert.equal(t.pushAttempt.status, 'failed_or_uncertain');
});
test('Kimi proposals are scope constrained and validate all paths before writing', () => {
  const c = fixture(); const t = add(c); const cwd = c.tree(t);
  assert.throws(() => c.applyProposals(t, '<coordinator-files>{"files":[{"path":"app.txt","content":"bad"},{"path":"../escape","content":"bad"}]}</coordinator-files>', cwd));
  assert.equal(fs.readFileSync(path.join(cwd, 'app.txt'), 'utf8').trim(), 'initial');
  c.applyProposals(t, '<coordinator-files>{"files":[{"path":"app.txt","content":"good"}]}</coordinator-files>', cwd); assert.equal(fs.readFileSync(path.join(cwd, 'app.txt'), 'utf8'), 'good');
});
test('interrupted tests and chats gate all subsequent dispatch until recovery', async () => {
  const c = fixture(async (p, cfg, prompt, role, cwd) => { fs.writeFileSync(path.join(cwd, 'app.txt'), 'new'); return okay(); }, async () => ({ code: -1, reason: 'termination_uncertain', output: '' }));
  const t = add(c); c.control('start'); await stage(c); assert.equal(t.status, 'interrupted'); assert.ok(c.state.recoveryRequired); assert.throws(() => c.control('resume'), /Tests interrupted/);
  await assert.rejects(c.chat({ provider: 'codex', message: 'hi' }), /recover/); c.retry(t.id, 'old processes stopped'); assert.equal(c.state.recoveryRequired, null);
  c.executor = async () => ({ status: 'interrupted', diagnostic: 'timeout' }); await c.chat({ provider: 'codex', message: 'hi' }); assert.throws(() => c.control('resume'), /Chat interrupted/);
});
test('one-step new project creates and configures its repository', () => {
  const dir = fs.mkdtempSync(path.join(fixtures, 'new-project-')); const c = new Coordinator(dir);
  const { repo } = createProject(c, { name: 'new-app', requirements: 'Build an app with tests', testCommands: [[process.execPath, '--test', 'test/*.test.mjs']] });
  assert.equal(c.state.repo, fs.realpathSync(repo)); assert.ok(fs.existsSync(path.join(repo, '.git'))); assert.equal(c.state.mode, 'paused');
});
test('GitHub authorization prevents repository configuration races', async () => {
  const c = fixture(); let release;
  const pending = githubTarget(c, { name: 'example/my-app' }, async (command, args) => { if (args.includes('auth')) await new Promise(r => release = r); return { code: 0, reason: '', output: args.includes('view') ? '{"nameWithOwner":"example/my-app","isPrivate":true}' : '' }; });
  assert.throws(() => c.configure({ repo: c.state.repo, requirements: 'changed', testCommands: [[process.execPath, '--test']] }), /Pause/);
  release(); await pending; assert.equal(c.state.github.repo, c.state.repo);
});
test('merge conflict is preserved, stops automatic integration and is never retried', async () => {
  const { c, t } = await ready(); const dir = path.join(c.dir, 'worktrees', 'integration'); const branch = `coordinator/${c.state.id}/integration`;
  git(c.state.repo, 'worktree', 'add', '-b', branch, dir, git(c.state.repo, 'rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(dir, 'app.txt'), 'conflicting change'); git(dir, 'add', 'app.txt'); git(dir, '-c', 'user.name=Tests', '-c', 'user.email=tests@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Conflicting integration');
  c.state.integration = { dir, branch, head: git(dir, 'rev-parse', 'HEAD') };
  await assert.rejects(c.integrate(t.id)); assert.equal(t.status, 'blocked'); assert.ok(git(dir, 'rev-parse', '--verify', 'MERGE_HEAD'));
  await assert.rejects(c.integrate(t.id), /already attempted/);
});
test('process timeout and output limit are bounded', async () => {
  const r = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }); assert.ok(['timeout', 'termination_uncertain'].includes(r.reason)); assert.ok(r.durationMs < 15000);
  const large = await run(process.execPath, ['-e', 'console.log("x".repeat(50000))'], { maxBytes: 1000, timeout: 5000 }); assert.ok(['output_limit', 'termination_uncertain'].includes(large.reason));
});
test('environment strips API credentials and redaction masks common secrets', () => { process.env.TEST_API_KEY = 'private'; assert.equal(safeEnv().TEST_API_KEY, undefined); delete process.env.TEST_API_KEY; assert.doesNotMatch(redact('api_key=secretthing Bearer abcdefg sk-abcdefghijklmnopqrstuv'), /secretthing|abcdefg/); });
test('local HTTP mutations require session token and matching origin', async () => {
  const c = fixture(); const server = createServer(c); await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`; const html = await (await fetch(base)).text(); const token = html.match(/const token='([^']+)'/)[1];
    assert.equal((await fetch(base + '/api/state')).status, 403);
    assert.equal((await fetch(base + '/api/control', { method: 'POST', headers: { 'X-Coordinator-Token': token, 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"action":"start"}' })).status, 400);
    const r = await fetch(base + '/api/control', { method: 'POST', headers: { 'X-Coordinator-Token': token, 'Content-Type': 'application/json' }, body: '{"action":"start"}' }); assert.equal(r.status, 200); assert.equal(c.state.mode, 'running');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
