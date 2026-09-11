import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Coordinator, git } from '../lib/core.mjs';
import { parseResult, invocation } from '../lib/adapters.mjs';
import { run, safeEnv, redact } from '../lib/process.mjs';
import { createServer, openDashboard } from '../server.mjs';
import { createLocal, createProject, githubTarget, pushCandidate } from '../lib/repositories.mjs';
import { setupStatus, privateRepositories, listRepositories, githubReadiness } from '../lib/setup.mjs';
import { assertPublicHttps, fetchSource, gatherEvidence, usableEvidence, parseFindings, verifyFindings, evidenceFromFindings } from '../lib/research.mjs';

const fixtures = path.resolve('data/test-fixtures'); fs.mkdirSync(fixtures, { recursive: true });
const planReply = (tasks = [{ title: 'First milestone', requirements: 'Implement a useful feature and tests', acceptance: 'Feature tests pass', scope: ['app.txt', 'test/'] }], questions = []) => '<coordinator-plan>'+JSON.stringify({summary:'A small sequential plan',questions,tasks})+'</coordinator-plan>';
function fixture(executor, testRunner) {
  const dir = fs.mkdtempSync(path.join(fixtures, 'case-')), repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init'); fs.writeFileSync(path.join(repo, 'app.txt'), 'initial\n'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Tests', '-c', 'user.email=tests@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  const c = new Coordinator(path.join(dir, 'state'), { executor, testRunner: testRunner || (async () => ({ code: 0, reason: '', output: 'Passed', durationMs: 1 })) });
  c.configure({ repo, requirements: 'A useful app', testCommands: [[process.execPath, '--test']] }); return c;
}
function add(c, extra = {}) { return c.addTask({ title: 'Implement app', requirements: 'Update app', acceptance: 'App has new content', scope: ['app.txt'], ...extra }); }
function contextOf(prompt) { return JSON.parse(prompt.slice(prompt.indexOf('CONTEXT\n') + 8).split('\nReturn complete UTF-8')[0]); }
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
test('lead plan is durable and does not start work when draft mode is requested', async () => {
  const c = fixture(async () => okay(planReply())); const r = await c.chat({provider:'codex',intent:'plan',message:'Plan the app'});
  assert.equal(r.plan.status,'draft'); assert.equal(c.state.calls,1); assert.equal(c.state.tasks.length,0); assert.equal(c.state.mode,'paused');
  const reload = new Coordinator(c.dir); const tasks = reload.acceptPlan(r.id); assert.equal(tasks.length,1); assert.equal(reload.state.mode,'paused'); assert.equal(tasks[0].independent,false);
  assert.throws(()=>reload.acceptPlan(r.id),/unqueued/);
});
test('automatic planning uses one independent review then queues and starts sequential milestones', async () => {
  const calls=[]; const c=fixture(async(p)=>{calls.push(p);return okay(calls.length===1?planReply([{title:'Foundation',requirements:'Build foundation',acceptance:'Foundation tests pass',scope:['app.txt']},{title:'Follow-up',requirements:'Extend foundation',acceptance:'New tests pass',scope:['app.txt']} ]):'The plan is scoped and testable.\nREVIEW: PASS')});
  const r=await c.chat({provider:'codex',intent:'plan',autoStart:true,message:'Build it'});
  assert.deepEqual(calls,['codex','kimi']);assert.equal(c.state.calls,2);assert.equal(c.state.mode,'running');assert.equal(r.plan.status,'queued');assert.equal(c.state.tasks.length,2);assert.deepEqual(c.state.tasks[1].dependencies,[c.state.tasks[0].id]);
});
test('rejected or quota-failed independent plan review never loops or starts tasks', async () => {
  for(const failed of [okay('Scope is too broad.\nREVIEW: FAIL'),{status:'quota',diagnostic:'Usage limit'}]){
    let calls=0;const c=fixture(async()=>++calls===1?okay(planReply()):failed);const r=await c.chat({provider:'codex',intent:'plan',autoStart:true,message:'Build it'});
    assert.equal(calls,2);assert.equal(c.state.tasks.length,0);assert.equal(c.state.mode,'paused');assert.equal(r.plan.status,'needs_attention');c.tick();assert.equal(calls,2);
  }
});
test('questions or unsafe plans cannot create tasks', async () => {
  const c=fixture(async()=>okay(planReply([],['Who will use this?'])));const r=await c.chat({provider:'codex',intent:'plan',autoStart:true,message:'Build something'});assert.equal(r.plan.status,'questions');assert.equal(c.state.calls,1);assert.throws(()=>c.acceptPlan(r.id),/unqueued/);
  c.executor=async()=>okay(planReply([{title:'Unsafe',requirements:'bad',acceptance:'bad',scope:['../escape']} ]));const bad=await c.chat({provider:'codex',intent:'plan',message:'Try again'});assert.equal(bad.status,'invalid_plan');assert.equal(c.state.tasks.length,0);
});
test('plan acceptance rejects stale decisions and atomically respects task/call limits', async () => {
  const c=fixture(async()=>okay(planReply()));const r=await c.chat({provider:'codex',intent:'plan',message:'Plan'});c.decision('Change the goal');assert.throws(()=>c.acceptPlan(r.id),/changed/);assert.equal(c.state.tasks.length,0);
  const two=fixture(async()=>okay(planReply([{title:'One',requirements:'one',acceptance:'one',scope:['app.txt']},{title:'Two',requirements:'two',acceptance:'two',scope:['app.txt']} ])));const draft=await two.chat({provider:'codex',intent:'plan',message:'Plan'});two.setLimits({maxTasks:1});assert.throws(()=>two.acceptPlan(draft.id),/Task budget/);assert.equal(two.state.tasks.length,0);assert.equal(draft.plan.status,'draft');
  two.setLimits({maxTasks:20,maxCalls:2});assert.throws(()=>two.acceptPlan(draft.id),/Not enough calls/);
});
test('Pause during plan review prevents automatic start and persists a running review for crash recovery', async () => {
  let release,calls=0;const c=fixture(async()=>{if(++calls===1)return okay(planReply());await new Promise(r=>release=r);return okay('REVIEW: PASS')});
  const pending=c.chat({provider:'codex',intent:'plan',autoStart:true,message:'Build'});while(!release)await new Promise(r=>setTimeout(r,1));
  const disk=JSON.parse(fs.readFileSync(c.file));assert.equal(disk.chats[0].status,'running');assert.equal(disk.chats[0].phase,'independent_plan_review');c.control('pause');release();const r=await pending;assert.equal(c.state.mode,'paused');assert.equal(r.phase,'queued_and_paused');assert.equal(c.state.tasks.length,1);
});
test('planning context includes bounded tracked source while excluding secrets and untracked files', () => {
  const c=fixture();fs.mkdirSync(path.join(c.state.repo,'test'));fs.writeFileSync(path.join(c.state.repo,'test/sample.test.mjs'),'// test evidence\n'+'x'.repeat(8000));
  fs.writeFileSync(path.join(c.state.repo,'.env'),'SECRET=do-not-send');fs.writeFileSync(path.join(c.state.repo,'secret.json'),'do-not-send');fs.writeFileSync(path.join(c.state.repo,'untracked.js'),'untracked-private');
  git(c.state.repo,'add','--','test/sample.test.mjs','.env','secret.json');
  const snapshot=c.projectSnapshot(), serialized=JSON.stringify(snapshot);
  assert.ok(snapshot.excerpts.some(e=>e.path==='test/sample.test.mjs'));assert.ok(snapshot.excerpts.reduce((n,e)=>n+e.content.length,0)<=6000);assert.ok(snapshot.excerpts.every(e=>e.content.length<=1500));assert.doesNotMatch(serialized,/do-not-send|untracked-private|\.env|secret\.json/);
});
test('source edits after planning invalidate automatic plan acceptance', async () => {
  const c=fixture(async()=>okay(planReply()));const r=await c.chat({provider:'codex',intent:'plan',message:'Plan'});fs.writeFileSync(path.join(c.state.repo,'app.txt'),'changed after planning');assert.throws(()=>c.acceptPlan(r.id),/changed/);assert.equal(c.state.tasks.length,0);
});
test('later milestones receive integrated source context instead of the untouched checkout', async () => {
  const {c,t}=await ready();await c.integrate(t.id);fs.writeFileSync(path.join(c.state.integration.dir,'sample.mjs'),'export const integrated = true;');git(c.state.integration.dir,'add','sample.mjs');git(c.state.integration.dir,'-c','user.name=Tests','-c','user.email=tests@localhost','-c','commit.gpgsign=false','commit','-m','Additional integrated fixture');c.state.integration.head=git(c.state.integration.dir,'rev-parse','HEAD');
  assert.ok(c.projectSnapshot().excerpts.some(e=>e.path==='sample.mjs'&&e.content.includes('integrated')));c.planBasis();fs.writeFileSync(path.join(c.state.integration.dir,'sample.mjs'),'external change');assert.throws(()=>c.planBasis(),/integration worktree/);
});

test('explicit model settings persist and reach every CLI without shell parsing', () => {
  const c=fixture(async()=>okay());c.setModels({provider:'codex',build:'gpt-5.6-sol',review:'gpt-6-astra'});
  assert.equal(new Coordinator(c.dir).state.adapters.codex.models.review,'gpt-6-astra');
  for(const name of ['codex','kimi','claude']){const spec=invocation(name,{command:name,models:{build:'test-model',review:'review-model'}},'hello','build',c.state.repo);assert.equal(spec.args[spec.args.indexOf('--model')+1],'test-model')}
  assert.throws(()=>c.setModels({provider:'codex',build:'--bad',review:'x'}));
  const parsed=parseResult('claude',{code:0,output:JSON.stringify({type:'result',result:'ok',modelUsage:{'claude-example':{}}})});assert.deepEqual(parsed.reportedModels,['claude-example']);
});
test('measured quota blocks and recovers eligible work without overriding pause or disabled providers',async()=>{
  const c=fixture(async()=>okay());const t=add(c);t.status='waiting';
  const reader=remaining=>async(config,method)=>method==='model/list'?{data:[{model:'example'}]}:{rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:100-remaining,resetsAt:123}}}};
  await c.monitorProviders(true,reader(0));assert.match(c.state.providers.codex.blocked,/quota/);assert.equal(c.state.calls,0);
  await c.monitorProviders(true,reader(10));assert.equal(c.state.providers.codex.blocked,null);assert.equal(t.status,'queued');assert.equal(c.state.mode,'paused');
  c.provider('codex',false);await c.monitorProviders(true,reader(20));assert.equal(c.state.providers.codex.enabled,false);
  await c.monitorProviders(true,async()=>{throw Error('offline')});assert.deepEqual(c.state.monitor.windows,[]);assert.equal(c.state.monitor.error,'offline');
});
test('recovery probes obey pause, call budget, cooldown and three-attempt cap',async()=>{
  let calls=0;const c=fixture(async()=>{calls++;return {status:'quota',text:'',diagnostic:'quota'}});add(c);c.state.providers.kimi.blocked='quota';
  await c.recoverProvider();assert.equal(calls,0);c.control('start');
  await c.recoverProvider();assert.equal(calls,1);await c.recoverProvider();assert.equal(calls,1);
  for(let i=0;i<4;i++){c.state.providers.kimi.nextProbe=0;await c.recoverProvider()}assert.equal(calls,3);assert.equal(c.state.calls,3);
  assert.equal(c.state.externalOperation,null);
});
test('successful recovery queues waiting work and pauses remain respected during an in-flight check',async()=>{
  let resolve;const c=fixture(()=>new Promise(r=>resolve=r));const t=add(c);t.status='waiting';c.state.providers.kimi.blocked='quota';c.control('start');
  const pending=c.recoverProvider();assert.equal(c.monitoring,true);assert.throws(()=>c.setModels({provider:'kimi',build:'a',review:'b'}));c.control('pause');resolve(okay('READY'));await pending;
  assert.equal(c.state.providers.kimi.blocked,null);assert.equal(t.status,'queued');assert.equal(c.state.mode,'paused');
});

test('compatibility checks use saved models, synthetic fixtures and the shared budget',async()=>{
 const {checkCompatibility}=await import('../lib/compatibility.mjs');
 const c=fixture(async(name,config,prompt,role)=>okay(role==='build'?'<coordinator-files>{"files":[{"path":"math.mjs","content":"export function add(a,b){if(!Number.isFinite(a)||!Number.isFinite(b))throw new TypeError();return a+b}"}]}</coordinator-files>':'Defective implementation.\nREVIEW: FAIL'));
 const head=git(c.state.repo,'rev-parse','HEAD');const r=await checkCompatibility(c,'kimi');assert.equal(r.status,'passed');assert.equal(c.state.calls,2);assert.equal(git(c.state.repo,'rev-parse','HEAD'),head);assert.equal(git(c.state.repo,'status','--porcelain'),'');assert.equal(c.chatting,false);
 c.state.providers.codex.blocked='quota: exhausted';assert.equal((await checkCompatibility(c,'codex')).status,'pending_quota');assert.equal(c.state.calls,2);
 c.state.limits.maxCalls=2;assert.equal((await checkCompatibility(c,'kimi')).status,'pending_budget');
});
test('routine access stays bounded and permission denials are explicit',()=>{
 const c=invocation('codex',{command:'codex'},'x','build','.');assert.ok(c.args.includes('approval_policy="never"'));assert.ok(c.args.includes('read-only'));assert.ok(!c.args.includes('--dangerously-bypass-approvals-and-sandbox'));
 const a=invocation('claude',{command:'claude'},'x','build','.');assert.equal(a.args[a.args.indexOf('--allowedTools')+1],'Read(./**),Glob,Grep');assert.ok(!a.args.includes('--dangerously-skip-permissions'));
 assert.equal(parseResult('claude',{code:0,output:JSON.stringify({type:'result',result:'Could not inspect source',permission_denials:[{tool_name:'Read'}]})}).status,'permission');
});
test('Pause during compatibility prevents the second model call',async()=>{
 const {checkCompatibility}=await import('../lib/compatibility.mjs');let resolve;
 const c=fixture(()=>new Promise(r=>resolve=r));const pending=checkCompatibility(c,'kimi');c.control('pause');
 resolve(okay('<coordinator-files>{"files":[{"path":"math.mjs","content":"export function add(a,b){if(!Number.isFinite(a)||!Number.isFinite(b))throw new TypeError();return a+b}"}]}</coordinator-files>'));
 const result=await pending;assert.equal(c.state.calls,1);assert.match(result.detail,/stopped by Pause/);assert.equal(c.chatting,false);
});

test('setup reporting names the fix for every unready dependency without model calls', async () => {
  const c = fixture(async () => { throw Error('setup must never invoke a model'); });
  // Every local probe fails: nothing is installed or signed in.
  const runner = async () => ({ code: 1, reason: '', output: 'not found', durationMs: 1 });
  const status = await setupStatus(c, runner);
  assert.equal(status.canBuild, false);
  assert.equal(status.canReview, false);
  assert.equal(status.github.ready, false);
  assert.deepEqual(status.agents.map(a => a.name).sort(), ['claude', 'codex', 'kimi']);
  for (const agent of status.agents) {
    assert.equal(agent.ready, false);
    assert.ok(agent.fix, `${agent.name} reports how to fix it`);
  }
  assert.ok(status.github.fix, 'GitHub CLI reports how to sign in');
  assert.equal(status.project.ready, true, 'the fixture already configured a repository');
  assert.equal(status.target.ready, false, 'no GitHub target is authorized by default');
});

test('setup reporting distinguishes an installed-but-signed-out agent from a missing one', async () => {
  const c = fixture(async () => { throw Error('setup must never invoke a model'); });
  const runner = async (command, args) => {
    if (args.includes('--version')) return { code: 0, reason: '', output: 'codex 1.2.3', durationMs: 1 };
    return { code: 1, reason: '', output: 'not logged in', durationMs: 1 }; // auth probes fail
  };
  const status = await setupStatus(c, runner);
  for (const agent of status.agents) {
    assert.equal(agent.installed, true, `${agent.name} is detected as installed`);
    assert.equal(agent.ready, false, `${agent.name} is not signed in`);
    assert.match(agent.detail, /authentication|login|auth/i);
  }
  assert.equal(status.canBuild, false);
});

test('review readiness requires two independent signed-in agents', async () => {
  const c = fixture(async () => { throw Error('setup must never invoke a model'); });
  // Codex passes both probes; kimi and claude are absent.
  const runner = async (command, args) => {
    const codex = String(command).includes('codex');
    if (args.includes('--version')) return { code: codex ? 0 : 1, reason: '', output: codex ? 'codex 1.2.3' : '', durationMs: 1 };
    if (args.includes('status') && codex) return { code: 0, reason: '', output: 'Logged in using ChatGPT', durationMs: 1 };
    return { code: 1, reason: '', output: '', durationMs: 1 };
  };
  const status = await setupStatus(c, runner);
  assert.deepEqual(status.usableAgents, ['codex']);
  assert.equal(status.canBuild, true, 'one agent can build');
  assert.equal(status.canReview, false, 'independent review still needs a second agent');
});

test('only private repositories are offered as GitHub targets', async () => {
  const runner = async () => ({ code: 0, reason: '', durationMs: 1, output: JSON.stringify([
    { nameWithOwner: 'me/public-one', isPrivate: false },
    { nameWithOwner: 'me/private-b', isPrivate: true },
    { nameWithOwner: 'me/private-a', isPrivate: true }
  ]) });
  assert.deepEqual(await privateRepositories(process.cwd(), runner), ['me/private-a', 'me/private-b']);
});

test('repository listing reports a signed-out GitHub CLI instead of returning nothing', async () => {
  const runner = async () => ({ code: 1, reason: '', output: 'gh: not authenticated', durationMs: 1 });
  await assert.rejects(() => privateRepositories(process.cwd(), runner), /Sign in to the GitHub CLI/);
});

test('the GitHub sign-in report names the account', async () => {
  const runner = async () => ({ code: 0, reason: '', durationMs: 1, output: '✓ Logged in to github.com account adelrio23 (keyring)' });
  const status = await githubReadiness(process.cwd(), runner);
  assert.equal(status.ready, true);
  assert.equal(status.user, 'adelrio23');
});

test('a failed review returns the task to the builder with the findings, then integrates once fixed', async () => {
  const seen = [];
  let reviews = 0;
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (role === 'build') { seen.push(contextOf(prompt)); fs.writeFileSync(path.join(cwd, 'app.txt'), `round ${seen.length}\n`); return okay('Implemented'); }
    reviews++;
    return okay(reviews === 1 ? 'Missing error handling on the empty input path.\nREVIEW: FAIL' : 'All criteria met.\nREVIEW: PASS');
  });
  const t = add(c); c.control('start');
  await stage(c); await stage(c); // build, failing review
  assert.equal(t.repairs, 1, 'one repair round was started');
  assert.equal(t.stage, 'build', 'the task went back to the builder');
  assert.equal(t.status, 'queued');
  await stage(c); await stage(c); // repair build, passing review
  assert.equal(t.status, 'ready');
  assert.equal(t.review.passed, true);
  // The second build brief carried the reviewer's concrete findings.
  assert.equal(seen.length, 2);
  assert.equal(seen[0].reviewFindingsToAddress, null);
  assert.match(seen[1].reviewFindingsToAddress, /Missing error handling/);
  assert.deepEqual(seen[1].repairRound, { round: 1, of: 2 });
});

test('repair rounds are bounded and then stop for inspection', async () => {
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (role === 'build') { fs.writeFileSync(path.join(cwd, 'app.txt'), `attempt ${Math.random()}\n`); return okay('Implemented'); }
    return okay('Still wrong.\nREVIEW: FAIL');
  });
  c.setLimits({ ...c.state.limits, maxRepairRounds: 1 });
  const t = add(c); c.control('start');
  for (let i = 0; i < 6 && t.status !== 'blocked'; i++) await stage(c);
  assert.equal(t.repairs, 1, 'stopped at the configured round limit');
  assert.equal(t.status, 'blocked');
  assert.match(t.blocked, /after 1 repair round/);
});

test('a repair round is refused when the call budget cannot fund it', async () => {
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (role === 'build') { fs.writeFileSync(path.join(cwd, 'app.txt'), 'new\n'); return okay('Implemented'); }
    return okay('Not good enough.\nREVIEW: FAIL');
  });
  c.setLimits({ ...c.state.limits, maxCalls: 2 }); // exactly one build + one review
  const t = add(c); c.control('start');
  await stage(c); await stage(c);
  assert.equal(t.repairs || 0, 0, 'no repair round was started');
  assert.equal(t.status, 'blocked');
  assert.match(t.blocked, /call budget/);
});

test('builders see recent handoffs and the remaining budget', async () => {
  let context;
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (role === 'build') { context = contextOf(prompt); fs.writeFileSync(path.join(cwd, 'app.txt'), 'new\n'); return okay('Implemented'); }
    return okay('All criteria met.\nREVIEW: PASS');
  });
  const t = add(c); c.control('start'); await stage(c);
  assert.ok(Array.isArray(context.handoffs), 'the full recent handoff chain is supplied');
  assert.equal(context.budget.callsRemaining, c.state.limits.maxCalls - 1);
  assert.equal(context.budget.maxFilesPerAttempt, c.state.limits.maxFiles);
});

test('the file-proposal cap follows the configured limit', async () => {
  const files = n => '<coordinator-files>' + JSON.stringify({ files: Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.txt`, content: 'x' })) }) + '</coordinator-files>';
  const c = fixture(async (provider, config, prompt, role, cwd) => role === 'build' ? okay(files(12)) : okay('REVIEW: PASS'));
  c.setLimits({ ...c.state.limits, maxFiles: 40 });
  const t = add(c, { scope: ['src/'] }); c.control('start'); await stage(c);
  assert.equal(t.stage, 'review', 'twelve files are accepted under a cap of forty');

  const c2 = fixture(async (provider, config, prompt, role, cwd) => role === 'build' ? okay(files(12)) : okay('REVIEW: PASS'));
  c2.setLimits({ ...c2.state.limits, maxFiles: 5 });
  const t2 = add(c2, { scope: ['src/'] }); c2.control('start'); await stage(c2);
  assert.equal(t2.status, 'blocked');
  assert.match(t2.blocked, /at most 5/);
});

// --- Cited research -------------------------------------------------------
const page = (title, body) => ({ ok: true, status: 200, text: async () => `<html><head><title>${title}</title></head><body><p>${body}</p><script>ignored()</script></body></html>` });
const publicDns = { lookup: async () => [{ address: '93.184.216.34' }] };

test('research refuses anything but a public https source', async () => {
  const cases = ['http://example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://user:pw@example.com', 'ftp://example.com', 'not a url'];
  for (const url of cases) await assert.rejects(() => assertPublicHttps(url, publicDns), Error, `refused ${url}`);
  await assert.rejects(() => assertPublicHttps('https://intranet.example.com', { lookup: async () => [{ address: '192.168.1.9' }] }), /private or loopback/);
  assert.equal((await assertPublicHttps('https://example.com/pricing', publicDns)).href, 'https://example.com/pricing');
});

test('retrieved evidence keeps the URL, fetch time and verbatim text', async () => {
  const fetcher = async () => page('Competitor pricing', 'Plans start at 19 dollars per month.');
  const source = await fetchSource('https://example.com/pricing', { fetcher, resolver: publicDns });
  assert.equal(source.ok, true);
  assert.equal(source.url, 'https://example.com/pricing');
  assert.equal(source.title, 'Competitor pricing');
  assert.match(source.excerpt, /19 dollars per month/);
  assert.doesNotMatch(source.excerpt, /ignored\(\)/, 'script contents are stripped');
  assert.ok(!Number.isNaN(Date.parse(source.fetchedAt)), 'records when it was fetched');
});

test('a failed source is recorded as failed rather than silently dropped', async () => {
  const fetcher = async url => url.includes('good') ? page('Good', 'Real text.') : { ok: false, status: 404 };
  const evidence = await gatherEvidence('What do competitors charge?', ['https://good.example.com/a', 'https://bad.example.com/b'], { fetcher, resolver: publicDns });
  assert.equal(evidence.retrieved, 1);
  assert.deepEqual(evidence.failed.map(f => f.error), ['HTTP 404']);
  assert.equal(evidence.sources.length, 2);
  assert.equal(evidence.review, null, 'evidence starts unreviewed');
});

test('unreviewed or rejected evidence never reaches the planner', async () => {
  const fetcher = async () => page('Source', 'Some market text.');
  const evidence = await gatherEvidence('Question?', ['https://example.com/a'], { fetcher, resolver: publicDns });
  assert.equal(usableEvidence(evidence), null, 'unreviewed evidence is withheld');
  evidence.review = { provider: 'kimi', passed: false, at: new Date().toISOString(), text: 'REVIEW: FAIL' };
  assert.equal(usableEvidence(evidence), null, 'rejected evidence is withheld');
  evidence.review = { provider: 'kimi', passed: true, at: new Date().toISOString(), text: 'REVIEW: PASS' };
  const usable = usableEvidence(evidence);
  assert.equal(usable.citations.length, 1);
  assert.equal(usable.citations[0].url, 'https://example.com/a');
  assert.match(usable.rules, /not supported by the retrieved sources/);
});

test('research retrieval spends no call budget and reviewing spends exactly one', async () => {
  let prompts = 0;
  const c = fixture(async (provider, config, prompt) => { prompts++; return okay('The excerpts are on-topic and recent.\nREVIEW: PASS'); });
  c.control('pause');
  c.state.research = await gatherEvidence('Who competes?', ['https://example.com/a'], { fetcher: async () => page('Rival', 'Rival charges 19 dollars.'), resolver: publicDns });
  assert.equal(c.state.calls, 0, 'retrieval is free');
  const review = await c.reviewResearch({ provider: 'codex' });
  assert.equal(review.passed, true);
  assert.equal(c.state.calls, 1, 'review costs exactly one call');
  assert.equal(prompts, 1);
  assert.equal(c.state.runs.at(-1).role, 'research_review');
});

test('the lead is given passed evidence and told to cite it', async () => {
  let leadPrompt = '';
  const c = fixture(async (provider, config, prompt, role) => { leadPrompt = prompt; return okay(planReply()); });
  c.control('pause');
  c.state.research = await gatherEvidence('Who competes?', ['https://example.com/a'], { fetcher: async () => page('Rival', 'Rival charges 19 dollars.'), resolver: publicDns });
  c.state.research.review = { provider: 'kimi', passed: true, at: new Date().toISOString(), text: 'REVIEW: PASS' };
  await c.chat({ provider: 'codex', intent: 'plan', message: 'Plan the next milestones.', autoStart: false });
  assert.match(leadPrompt, /CITED EVIDENCE/);
  assert.match(leadPrompt, /https:\/\/example\.com\/a/);
  assert.match(leadPrompt, /not supported by the retrieved sources/);
});

test('the lead assigns a role to each milestone and the builder is told its role', async () => {
  let buildPrompt = '';
  const plan = planReply([{ title: 'Add the API', role: 'backend', requirements: 'Implement the endpoint and tests', acceptance: 'Endpoint tests pass', scope: ['app.txt', 'test/'] }]);
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (prompt.includes('Act as the project lead')) return okay(plan);
    if (role === 'review') return okay('Sound plan.\nREVIEW: PASS');
    buildPrompt = prompt; fs.writeFileSync(path.join(cwd, 'app.txt'), 'new\n'); return okay('Implemented');
  });
  c.control('pause');
  await c.chat({ provider: 'codex', intent: 'plan', message: 'Plan it.', autoStart: true });
  const queued = c.state.tasks.at(-1);
  assert.equal(queued.role, 'backend', 'the assigned role is stored on the task');
  c.control('start'); await stage(c);
  assert.match(buildPrompt, /backend specialist the project lead assigned/);
  assert.match(buildPrompt, /"assignedRole":"backend"/);
});

test('the research role gets web tools and no other role does', () => {
  const claudeResearch = invocation('claude', { command: 'claude', models: {} }, 'p', 'research', '/tmp');
  assert.ok(claudeResearch.args.join(' ').includes('WebSearch,WebFetch'), 'research may search');
  assert.doesNotMatch(claudeResearch.args.join(' '), /Read\(/, 'research gets no file access');
  const claudeBuild = invocation('claude', { command: 'claude', models: {} }, 'p', 'build', '/tmp');
  assert.doesNotMatch(claudeBuild.args.join(' '), /WebSearch|WebFetch/, 'building stays offline');
  assert.ok(invocation('codex', { command: 'codex', models: {} }, 'p', 'research', '/tmp').args.includes('--search'));
  assert.ok(!invocation('codex', { command: 'codex', models: {} }, 'p', 'build', '/tmp').args.includes('--search'));
  assert.match(invocation('kimi', { command: 'kimi', models: {} }, 'p', 'research', '/tmp').args.join(' '), /kimi-researcher\.md/);
  assert.match(invocation('kimi', { command: 'kimi', models: {} }, 'p', 'build', '/tmp').args.join(' '), /kimi-reader\.md/);
});

test('a fabricated citation is discarded, a real one is kept', async () => {
  const findings = [
    { claim: 'Rival charges 19 dollars', url: 'https://real.example.com/pricing', quote: 'Plans start at 19 dollars per month' },
    { claim: 'Rival has 40 million users', url: 'https://real.example.com/pricing', quote: 'We serve 40 million users worldwide' },
    { claim: 'Invented statistic', url: 'https://missing.example.com/report', quote: 'anything' }
  ];
  const fetcher = async url => url.includes('real') ? page('Pricing', 'Plans start at 19 dollars per month. Contact sales.') : { ok: false, status: 404 };
  const verified = await verifyFindings(findings, { fetcher, resolver: publicDns });
  assert.equal(verified[0].verified, true, 'a quote actually on the page is kept');
  assert.equal(verified[1].verified, false, 'a quote the page does not contain is rejected');
  assert.equal(verified[2].verified, false, 'an unreachable source is rejected');
  assert.match(verified[2].reason, /could not be re-fetched/);

  const evidence = evidenceFromFindings('Who competes?', 'codex', verified);
  assert.equal(evidence.retrieved, 1);
  assert.equal(evidence.sources.length, 1, 'only the confirmed finding becomes citable evidence');
  assert.equal(evidence.failed.length, 2);
  assert.equal(evidence.review, null, 'agent-found evidence still needs independent review');
});

test('quote matching ignores whitespace and smart quotes but not substance', async () => {
  const fetcher = async () => page('Doc', 'We charge $19 per month for the “Pro” plan.');
  const verified = await verifyFindings([
    { claim: 'a', url: 'https://example.com/a', quote: 'we charge $19   per month for the "Pro" plan' },
    { claim: 'b', url: 'https://example.com/a', quote: 'we charge $29 per month' }
  ], { fetcher, resolver: publicDns });
  assert.equal(verified[0].verified, true, 'formatting differences are tolerated');
  assert.equal(verified[1].verified, false, 'a different number is not');
});

test('malformed research output is rejected rather than half-trusted', () => {
  assert.throws(() => parseFindings('no block here'), /exactly one <coordinator-research> block/);
  assert.throws(() => parseFindings('<coordinator-research>{"findings":[]}</coordinator-research>'), /no findings/);
  assert.throws(() => parseFindings('<coordinator-research>{"findings":[{"claim":"x","quote":"y"}]}</coordinator-research>'), /source URL/);
  assert.throws(() => parseFindings('<coordinator-research>{"findings":[{"claim":"x","url":"https://e.com"}]}</coordinator-research>'), /verbatim quote/);
  const ok = parseFindings('<coordinator-research>{"findings":[{"claim":"x","url":"https://e.com","quote":"y"}]}</coordinator-research>');
  assert.deepEqual(ok, [{ claim: 'x', url: 'https://e.com', quote: 'y' }]);
});

test('every repository is listed, with public ones shown but marked ineligible', async () => {
  const runner = async () => ({ code: 0, reason: '', durationMs: 1, output: JSON.stringify([
    { nameWithOwner: 'me/public-site', isPrivate: false, updatedAt: '2026-09-01T00:00:00Z' },
    { nameWithOwner: 'me/older-private', isPrivate: true, updatedAt: '2026-01-01T00:00:00Z' },
    { nameWithOwner: 'me/recent-private', isPrivate: true, updatedAt: '2026-09-10T00:00:00Z' }
  ]) });
  const repos = await listRepositories(process.cwd(), runner);
  assert.equal(repos.length, 3, 'nothing is hidden from the list');
  assert.deepEqual(repos.map(r => r.name), ['me/recent-private', 'me/older-private', 'me/public-site'], 'usable and most recent first');
  assert.equal(repos[2].eligible, false);
  assert.match(repos[2].reason, /only pushes to a private repository/);
  assert.equal(repos[0].reason, null);
  // The narrower helper still returns only what can actually be authorized.
  assert.deepEqual(await privateRepositories(process.cwd(), runner), ['me/recent-private', 'me/older-private']);
});

test('project tests run locally on demand without spending the call budget', async () => {
  const ran = [];
  const c = fixture(async () => { throw Error('running tests must never call a model'); }, async (command, args, opts) => { ran.push({ command, cwd: opts.cwd }); return { code: 0, reason: '', output: 'ok', durationMs: 1 }; });
  c.control('pause');
  const outcome = await c.runProjectTests();
  assert.equal(outcome.passed, true);
  assert.equal(c.state.calls, 0, 'no call budget is spent');
  assert.equal(ran.length, 1);
  assert.equal(ran[0].cwd, c.state.repo, 'tests run against the project checkout on this machine');
  assert.equal(c.state.localTests.passed, true);
});

test('a failing local test run is reported as failed with its output', async () => {
  const c = fixture(async () => okay(), async () => ({ code: 1, reason: '', output: 'AssertionError: expected 2', durationMs: 1 }));
  c.control('pause');
  const outcome = await c.runProjectTests();
  assert.equal(outcome.passed, false);
  assert.match(outcome.results[0].output, /AssertionError/);
});

test('an exhausted Codex window records when it is expected back', async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const c = fixture(async () => okay());
  await c.monitorProviders(true, async () => ({ rateLimits: { primary: { usedPercent: 100, resetsAt } } }));
  const codex = c.state.providers.codex;
  assert.match(codex.blocked, /^quota/);
  assert.equal(codex.availableAt, resetsAt * 1000, 'the reported reset time is stored, not a guess');
  assert.match(c.availability().find(p => p.name === 'codex').availableAt, /^\d{4}-/);
});

test('recovering Codex requeues work that was only waiting for a provider', async () => {
  const c = fixture(async () => okay());
  c.state.providers.codex.blocked = 'quota: measured Codex limit exhausted';
  c.state.providers.codex.availableAt = Date.now() - 1000;
  const t = add(c); t.status = 'waiting'; t.blocked = 'No eligible independent provider available';
  await c.monitorProviders(true, async () => ({ rateLimits: { primary: { usedPercent: 10, resetsAt: null } } }));
  assert.equal(c.state.providers.codex.blocked, null);
  assert.equal(c.state.providers.codex.availableAt, null);
  assert.equal(t.status, 'queued', 'waiting work resumes automatically');
  assert.equal(t.blocked, null);
});

test('a passed reset time restores the recovery allowance instead of giving up', async () => {
  const c = fixture(async () => okay());
  const kimi = c.state.providers.kimi;
  kimi.blocked = 'quota: exhausted'; kimi.recoveryAttempts = 3; kimi.availableAt = Date.now() - 1000; kimi.nextProbe = Date.now() + 9e9;
  const waiting = add(c); waiting.status = 'waiting'; // there is work for it to come back to
  c.control('start');
  await c.recoverProvider();
  assert.equal(kimi.recoveryAttempts, 1, 'a new quota window resets the attempt count and probes again');
  assert.equal(kimi.availableAt !== null, true);
});

// --- Autonomous continuation ------------------------------------------------
function autoFixture(planSequence) {
  let plans = 0;
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (prompt.includes('Act as the project lead')) return okay(planSequence[Math.min(plans++, planSequence.length - 1)]);
    if (role === 'review') return okay('Good.\nREVIEW: PASS');
    fs.writeFileSync(path.join(cwd, 'app.txt'), `build ${Math.random()}\n`); return okay('Implemented');
  });
  c.state.policy.autoPlan = true;
  return c;
}
async function settle(c, rounds = 40) { for (let i = 0; i < rounds; i++) { c.tick(); await new Promise(r => setTimeout(r, 12)); } }

test('with autoPlan on it plans, builds and integrates repeatedly without approvals', async () => {
  const milestone = n => planReply([{ title: `Milestone ${n}`, role: 'backend', requirements: 'Do the next valuable thing', acceptance: 'Tests pass', scope: ['app.txt'] }]);
  const c = autoFixture([milestone(1), milestone(2), milestone(3)]);
  await c.chat({ provider: 'codex', intent: 'plan', autoStart: true, message: 'Start.' });
  c.control('start');
  await settle(c);
  assert.ok(c.state.planningRounds >= 1, 'it planned again on its own after finishing');
  assert.ok(c.state.tasks.length >= 2, `more milestones were queued and built (${c.state.tasks.length})`);
  assert.ok(c.state.tasks.every(t => ['integrated', 'queued', 'building', 'reviewing', 'testing', 'ready'].includes(t.status)), 'nothing is blocked awaiting a human');
});

test('an autonomous run stops itself when the lead needs an answer', async () => {
  const c = autoFixture([planReply([], ['Which payment provider should we support?'])]);
  c.state.tasks.push({ ...add(c), status: 'integrated' });
  for (const t of c.state.tasks) t.status = 'integrated';
  c.control('start');
  await settle(c, 25);
  assert.match(c.state.autoPlanStopped || '', /needs an answer|payment provider/i);
  assert.equal(c.state.mode, 'paused', 'it pauses rather than looping');
});

test('an autonomous run stops at the planning round cap instead of looping forever', async () => {
  const c = autoFixture([planReply([{ title: 'M', role: 'backend', requirements: 'r', acceptance: 'a', scope: ['app.txt'] }])]);
  c.setLimits({ ...c.state.limits, maxPlanningRounds: 2 });
  for (const t of c.state.tasks) t.status = 'integrated';
  c.state.tasks.push({ ...add(c), status: 'integrated' });
  for (const t of c.state.tasks) t.status = 'integrated';
  c.control('start');
  await settle(c, 60);
  assert.ok(c.state.planningRounds <= 2, `respected the cap (${c.state.planningRounds})`);
  if (c.state.autoPlanStopped) assert.match(c.state.autoPlanStopped, /planning round cap|call budget/);
});

test('autoPlan stays off unless it is turned on', async () => {
  const c = fixture(async () => okay());
  assert.equal(c.state.policy.autoPlan, false, 'autonomy is opt-in');
  const t = add(c); t.status = 'integrated';
  c.control('start'); await settle(c, 5);
  assert.equal(c.state.planningRounds, 0, 'no planning happens on its own');
});

test('the dashboard is opened with the platform browser command, and never crashes the server', () => {
  const calls = [];
  const spawner = (command, args) => { calls.push({ command, args }); return { on() {}, unref() {} }; };
  assert.equal(openDashboard('http://127.0.0.1:4317', spawner), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('http://127.0.0.1:4317'), 'the dashboard URL is passed through');
  const expected = { win32: 'cmd', darwin: 'open' }[process.platform] || 'xdg-open';
  assert.equal(calls[0].command, expected);

  // A machine with no opener must not take the server down with it.
  assert.equal(openDashboard('http://127.0.0.1:4317', () => { throw Error('no browser here'); }), false);

  process.env.COORDINATOR_NO_OPEN = '1';
  try { assert.equal(openDashboard('http://127.0.0.1:4317', spawner), false, 'opt-out is honoured'); assert.equal(calls.length, 1); }
  finally { delete process.env.COORDINATOR_NO_OPEN; }
});

test('Claude is invoked by its resolved WSL path, not a bare name off a shell-less PATH', () => {
  const config = { command: 'wsl.exe', wsl: true, exe: '/home/u/.npm-global/bin/claude', models: { build: 'sonnet' } };
  const build = invocation('claude', config, 'prompt', 'build', 'C:\\work\\repo');
  assert.ok(build.args.includes('/home/u/.npm-global/bin/claude'), 'the resolved path is used');
  assert.ok(!build.args.includes('claude'), 'the bare name is not used');
  // --exec is kept, so no argument is ever handed to a shell.
  assert.ok(build.args.includes('--exec'));
  assert.ok(build.args.includes('/mnt/c/work/repo'), 'the Windows path is translated for WSL');
  // Without a resolved path it still falls back rather than breaking.
  assert.ok(invocation('claude', { command: 'wsl.exe', wsl: true, models: {} }, 'p', 'build', 'C:\\x').args.includes('claude'));
});

test('adapter locations are re-detected on load rather than trusted from saved state', () => {
  const dir = fs.mkdtempSync(path.join(fixtures, 'adapters-'));
  const first = new Coordinator(dir, { executor: async () => okay() });
  first.state.adapters.claude.command = 'C:/stale/path/wsl.exe';
  first.state.adapters.claude.exe = '/gone/claude';
  first.save();
  const reloaded = new Coordinator(dir, { executor: async () => okay() });
  assert.notEqual(reloaded.state.adapters.claude.command, 'C:/stale/path/wsl.exe', 'a stale command is replaced');
  assert.notEqual(reloaded.state.adapters.claude.exe, '/gone/claude', 'a stale executable path is replaced');
  assert.ok(reloaded.state.adapters.claude.models.build, 'model choices are preserved across the refresh');
});

// --- Unanimous completion ---------------------------------------------------
function consensusFixture(verdictsByRound) {
  let round = 0, plansIssued = 0;
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (prompt.includes('Judge whether this project now fully meets')) {
      const verdicts = verdictsByRound[Math.min(round, verdictsByRound.length - 1)];
      const verdict = verdicts[provider];
      if (provider === Object.keys(verdicts).at(-1)) round++;
      return okay(verdict ? 'Looks done.\nVERDICT: COMPLETE' : 'Missing password reset and error handling.\nVERDICT: INCOMPLETE');
    }
    if (prompt.includes('Act as the project lead')) { plansIssued++; return okay(planReply([])); }
    if (role === 'review') return okay('Good.\nREVIEW: PASS');
    fs.writeFileSync(path.join(cwd, 'app.txt'), `b${Math.random()}\n`); return okay('Implemented');
  });
  c.state.policy.autoPlan = true;
  return c;
}

test('a single dissenting agent keeps the run going and records what is missing', async () => {
  const c = consensusFixture([{ codex: true, kimi: false }]);
  const t = add(c); t.status = 'integrated';
  await c.settleCompletion();
  assert.equal(c.state.consensus.complete, false);
  assert.deepEqual(c.state.consensus.dissenting, ['kimi']);
  assert.equal(c.state.autoPlanStopped, null, 'the run is not stopped by a dissent');
  assert.match(c.state.decisions.at(-1).text, /Completion review found remaining gaps/);
  assert.match(c.state.decisions.at(-1).text, /password reset/, 'the specific gap is carried forward');
  assert.ok(c.state.decisions.at(-1).text.length <= 2000, 'the recorded decision fits the field');
});

test('the run ends only when every available agent agrees', async () => {
  const c = consensusFixture([{ codex: true, kimi: true }]);
  const t = add(c); t.status = 'integrated';
  await c.settleCompletion();
  assert.equal(c.state.consensus.complete, true);
  assert.deepEqual(c.state.consensus.agreed.sort(), ['codex', 'kimi']);
  assert.match(c.state.autoPlanStopped, /All agents agree the goal is met/);
  assert.equal(c.state.mode, 'paused');
});

test('completion needs a real verdict line, not an agent merely sounding positive', async () => {
  const c = fixture(async () => okay('This looks great to me, excellent work, ship it.'));
  c.state.policy.autoPlan = true;
  const t = add(c); t.status = 'integrated';
  const consensus = await c.consensusComplete();
  assert.equal(consensus.complete, false, 'praise without VERDICT: COMPLETE is not agreement');
  assert.equal(consensus.agreed.length, 0);
});

test('completion is not declared when there is no budget to ask', async () => {
  const c = consensusFixture([{ codex: true, kimi: true }]);
  c.setLimits({ ...c.state.limits, maxCalls: 1 });
  const t = add(c); t.status = 'integrated';
  assert.equal(await c.consensusComplete(), null, 'it declines rather than assuming completion');
  await c.settleCompletion();
  assert.match(c.state.autoPlanStopped, /not enough budget or enough available agents/);
});
