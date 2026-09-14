import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Coordinator, git, defaults } from '../lib/core.mjs';
import { parseResult, invocation, codexSandbox } from '../lib/adapters.mjs';
import { run, safeEnv, redact } from '../lib/process.mjs';
import { createServer, openDashboard } from '../server.mjs';
import { createLocal, createProject, githubTarget, pushCandidate } from '../lib/repositories.mjs';
import { setupStatus, privateRepositories, listRepositories, githubReadiness } from '../lib/setup.mjs';
import { launchAutonomous, cloneFromGitHub } from '../lib/autostart.mjs';
import { projectChoices } from '../lib/project-picker.mjs';
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
  c.provider('claude', false); // an operator-disabled provider must be re-enabled by hand
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
test('failed tests never reach review, and the work is preserved for the repair', async () => {
  const c = fixture(async (p, cfg, prompt, role, cwd) => { fs.writeFileSync(path.join(cwd, 'app.txt'), 'new'); return okay(); }, async () => ({ code: 1, output: 'assertion failed', reason: '' }));
  const t = add(c); c.control('start'); await stage(c);
  assert.equal(t.tests.passed, false);
  assert.equal(t.stage, 'build', 'it does not advance to review on a failing test');
  assert.equal(t.review, undefined, 'no reviewer was spent on failing work');
  assert.equal(c.state.calls, 1, 'exactly the one build call was spent');
  assert.ok(fs.existsSync(path.join(t.worktree, 'app.txt')), 'the candidate is preserved for the next attempt');
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
  const { c, t } = await ready();
  c.state.policy.autoPlan = false; // this test counts integration calls, not continuation
  c.control('resume'); c.tick();
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
test('recovery probes obey pause, call budget and cooldown without abandoning unattended work',async()=>{
  let calls=0;const c=fixture(async()=>{calls++;return {status:'quota',text:'',diagnostic:'quota'}});add(c);c.state.providers.kimi.blocked='quota';
  await c.recoverProvider();assert.equal(calls,0);c.control('start');
  await c.recoverProvider();assert.equal(calls,1);const firstDelay=c.state.providers.kimi.nextProbe-Date.now();
  await c.recoverProvider();assert.equal(calls,1,'cooldown prevents a retry storm');
  for(let i=0;i<4;i++){c.state.providers.kimi.nextProbe=0;await c.recoverProvider()}
  assert.equal(calls,5);assert.equal(c.state.calls,5);
  assert.ok(firstDelay>1700000&&firstDelay<=1800000);
  assert.ok(c.state.providers.kimi.nextProbe-Date.now()<=14400000,'backoff is capped at four hours');
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
  assert.deepEqual(seen[1].repairRound, { round: 1, of: c.state.limits.maxRepairRounds });
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

test('an unknown provider window keeps its backoff and probes again when due', async () => {
  let calls=0;const c = fixture(async () => { calls++; return okay(); });
  const kimi = c.state.providers.kimi;
  kimi.blocked = 'quota: exhausted'; kimi.recoveryAttempts = 3; kimi.availableAt = Date.now() - 1000; kimi.nextProbe = Date.now() + 9e9;
  const waiting = add(c); waiting.status = 'waiting';
  c.control('start');
  await c.recoverProvider();assert.equal(calls,0,'a guessed display time never overrides the real probe cooldown');
  kimi.nextProbe=0;await c.recoverProvider();
  assert.equal(calls,1);assert.equal(kimi.blocked,null);assert.equal(waiting.status,'queued');
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

test('autonomy is on by default and can be turned off', async () => {
  const c = fixture(async () => okay(planReply()));
  assert.equal(c.state.policy.autoPlan, true, 'a run continues without being asked to');
  c.setPolicy({ autoIntegrate: true, autoPush: false, autoPlan: false });
  const t = add(c); t.status = 'integrated';
  c.control('start'); await settle(c, 5);
  assert.equal(c.state.planningRounds, 0, 'turning it off stops the continuation');
});

test('the dashboard is opened with the platform browser command, and never crashes the server', () => {
  const calls = [];
  const spawner = (command, args) => { calls.push({ command, args }); return { on() {}, unref() {} }; };
  assert.equal(openDashboard('http://127.0.0.1:4317', spawner), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('http://127.0.0.1:4317'), 'the dashboard URL is passed through');
  const expected = { win32: 'explorer.exe', darwin: 'open' }[process.platform] || 'xdg-open';
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
  const c = consensusFixture([{ codex: true, kimi: false, claude: true }]);
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
  const c = consensusFixture([{ codex: true, kimi: true, claude: true }]);
  const t = add(c); t.status = 'integrated';
  await c.settleCompletion();
  assert.equal(c.state.consensus.complete, true);
  assert.deepEqual(c.state.consensus.agreed.sort(), ['claude', 'codex', 'kimi']);
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
  const c = consensusFixture([{ codex: true, kimi: true, claude: true }]);
  c.setLimits({ ...c.state.limits, maxCalls: 1 });
  const t = add(c); t.status = 'integrated';
  assert.equal(await c.consensusComplete(), null, 'it declines rather than assuming completion');
  await c.settleCompletion();
  assert.match(c.state.autoPlanStopped, /not enough budget or enough available agents/);
});

test('every agent is told what budget is left and how milestones consume it', async () => {
  const prompts = {};
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    prompts[role] = prompt;
    if (prompt.includes('Act as the project lead')) return okay(planReply());
    if (role === 'review') return okay('Good.\nREVIEW: PASS');
    fs.writeFileSync(path.join(cwd, 'app.txt'), 'new\n'); return okay('Implemented');
  });
  c.control('pause');
  await c.chat({ provider: 'codex', intent: 'plan', autoStart: false, message: 'Plan it.' });
  assert.match(prompts.review, /callsRemaining/, 'the lead is told what is left');
  assert.match(prompts.review, /prefer fewer higher-value milestones/, 'and how to spend it');
  assert.match(prompts.review, /eachMilestoneCosts/, 'and what a milestone costs');

  const t = add(c); c.control('start'); await stage(c);
  const context = contextOf(prompts.build);
  assert.equal(context.budget.callsTotal, c.state.limits.maxCalls);
  assert.equal(typeof context.budget.callsRemaining, 'number');
  assert.ok(context.budget.callsRemaining < c.state.limits.maxCalls, 'spent calls are reflected');
});

test('the budget brief reports measured subscription usage when a provider gives it', async () => {
  const c = fixture(async () => okay());
  await c.monitorProviders(true, async () => ({ rateLimits: { primary: { usedPercent: 75, resetsAt: Math.floor(Date.now() / 1000) + 600 } } }));
  const brief = c.budgetBrief();
  assert.ok(Array.isArray(brief.subscriptionUsage), 'measured windows are passed through');
  assert.equal(brief.subscriptionUsage[0].remainingPercent, 25);
  assert.match(brief.subscriptionUsage[0].resetsAt, /^\d{4}-/);

  const fresh = fixture(async () => okay());
  assert.equal(fresh.budgetBrief().subscriptionUsage, 'Not reported by these providers', 'unmeasured usage is never reported as zero');
});

// --- One-button launch ------------------------------------------------------
function launchEngine(executor) {
  const dir = fs.mkdtempSync(path.join(fixtures, 'launch-'));
  return new Coordinator(path.join(dir, 'state'), { executor, testRunner: async () => ({ code: 0, reason: '', output: 'ok', durationMs: 1 }) });
}
const leadExecutor = async (provider, config, prompt) => prompt.includes('Act as the project lead') ? okay(planReply()) : okay('Good.\nREVIEW: PASS');

test('launching sets up the project, GitHub and every automatic policy with no approvals', async () => {
  const c = launchEngine(leadExecutor);
  const authorized = [];
  const result = await launchAutonomous(c, { name: 'my-app', requirements: 'Build something valuable' }, {
    readiness: async () => ({ ready: true, user: 'adelrio23', detail: 'Signed in as adelrio23.' }),
    repositories: async () => [{ name: 'adelrio23/other', isPrivate: true, eligible: true }],
    target: async (engine, options) => { authorized.push(options); engine.state.github = { name: options.name, branch: 'coordinator/x/integration', authorized: true }; return engine.state.github; }
  });
  assert.ok(c.state.repo, 'the project repository exists');
  assert.deepEqual(authorized, [{ name: 'adelrio23/my-app', create: true, authorizeAutoPush: true }], 'a private repository is created and push authorized');
  assert.equal(c.state.policy.autoIntegrate, true);
  assert.equal(c.state.policy.autoPush, true);
  assert.equal(c.state.policy.autoPlan, true);
  assert.equal(result.pushing, true);
  assert.equal(c.state.mode, 'running', 'it is already working');
});

test('launching connects to an existing private repository instead of trying to create it', async () => {
  const c = launchEngine(leadExecutor);
  const authorized = [];
  await launchAutonomous(c, { name: 'my-app', requirements: 'Build it' }, {
    readiness: async () => ({ ready: true, user: 'adelrio23' }),
    repositories: async () => [{ name: 'adelrio23/my-app', isPrivate: true, eligible: true }],
    target: async (engine, options) => { authorized.push(options); engine.state.github = { name: options.name, branch: 'b', authorized: true }; return engine.state.github; }
  });
  assert.equal(authorized[0].create, false, 'an existing repository is connected, not recreated');
});

test('a GitHub problem does not stop the run; it continues locally and says so', async () => {
  const c = launchEngine(leadExecutor);
  const result = await launchAutonomous(c, { name: 'my-app', requirements: 'Build it' }, {
    readiness: async () => ({ ready: false, user: null, detail: 'GitHub CLI is not installed or not signed in.' }),
    repositories: async () => [], target: async () => { throw Error('should not be reached'); }
  });
  assert.equal(result.pushing, false);
  assert.equal(c.state.policy.autoPlan, true, 'the autonomous run still starts');
  assert.equal(c.state.mode, 'running');
  assert.ok(result.notes.some(n => /Continuing without GitHub/.test(n)), 'the reason is reported, not hidden');
});

test('launching refuses to start with only one agent rather than skipping review', async () => {
  const c = launchEngine(leadExecutor);
  c.provider('kimi', false); c.provider('claude', false);
  await assert.rejects(() => launchAutonomous(c, { name: 'my-app', requirements: 'Build it', github: false }), /Two signed-in agents are required/);
});

test('the project picker finds repositories in the home folder and common project directories', () => {
  const home = fs.mkdtempSync(path.join(fixtures, 'home-'));
  const make = dir => { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init'); return path.resolve(dir); };
  const inHome = make(path.join(home, 'ytfactory'));                      // straight in the home folder
  const inDocuments = make(path.join(home, 'Documents', 'side-project'));
  const inOneDrive = make(path.join(home, 'OneDrive', 'Desktop', 'redirected'));
  fs.mkdirSync(path.join(home, 'not-a-repo'), { recursive: true });        // no .git

  const realHome = os.homedir;
  os.homedir = () => home;
  try {
    const found = projectChoices({ dir: fs.mkdtempSync(path.join(fixtures, 'state-')), state: { repo: null } }).map(p => p.path);
    for (const expected of [inHome, inDocuments, inOneDrive]) assert.ok(found.includes(expected), `found ${expected}`);
    assert.ok(!found.some(p => p.endsWith('not-a-repo')), 'a plain folder is not offered as a repository');
  } finally { os.homedir = realHome; }
});

test('a GitHub repository can be downloaded and configured as the project', async () => {
  const dir = fs.mkdtempSync(path.join(fixtures, 'clone-'));
  const c = new Coordinator(path.join(dir, 'state'), { executor: async () => okay() });
  const issued = [];
  const runner = async (command, args, opts) => {
    issued.push({ command, args });
    // Stand in for gh: produce a real repository at the requested destination.
    const target = path.join(opts.cwd, 'ytfactory');
    fs.mkdirSync(target, { recursive: true }); git(target, 'init');
    fs.writeFileSync(path.join(target, 'app.py'), 'print("hi")\n'); git(target, 'add', '.');
    git(target, '-c', 'user.name=T', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
    return { code: 0, reason: '', output: 'Cloning…', durationMs: 1 };
  };
  const result = await cloneFromGitHub(c, { name: 'adelrio23/ytfactory', requirements: 'Fix the scene queries', testCommands: [['python', '-m', 'unittest']] },
    { runner, repositories: async () => [{ name: 'adelrio23/ytfactory', isPrivate: true, eligible: true }] });

  assert.ok(issued[0].args.includes('clone'), 'it clones through the GitHub CLI');
  assert.ok(issued[0].args.includes('adelrio23/ytfactory'));
  assert.equal(c.state.repo, result.repo, 'the clone becomes the project');
  assert.ok(fs.existsSync(path.join(result.repo, '.git')));
  assert.equal(c.state.requirements, 'Fix the scene queries');
  assert.deepEqual(c.state.testCommands, [['python', '-m', 'unittest']], 'the project keeps its own test command');
});

test('downloading refuses a repository that is not on the account, and a bad name', async () => {
  const c = new Coordinator(fs.mkdtempSync(path.join(fixtures, 'clone2-')), { executor: async () => okay() });
  const deps = { runner: async () => { throw Error('must not clone'); }, repositories: async () => [{ name: 'adelrio23/mine', isPrivate: true, eligible: true }] };
  await assert.rejects(() => cloneFromGitHub(c, { name: 'someoneelse/theirs', requirements: 'x' }, deps), /not in your GitHub account/);
  await assert.rejects(() => cloneFromGitHub(c, { name: 'not-a-repo-name', requirements: 'x' }, deps), /owner\/repository/);
});

test('a failed download reports the reason instead of leaving a half-configured project', async () => {
  const c = new Coordinator(fs.mkdtempSync(path.join(fixtures, 'clone3-')), { executor: async () => okay() });
  await assert.rejects(() => cloneFromGitHub(c, { name: 'adelrio23/ytfactory', requirements: 'x' }, {
    runner: async () => ({ code: 1, reason: '', output: 'gh: repository not found', durationMs: 1 }),
    repositories: async () => [{ name: 'adelrio23/ytfactory', isPrivate: true, eligible: true }]
  }), /Could not clone/);
  assert.equal(c.state.repo, null, 'no project is configured when the download fails');
});

test('a confirmed-stopped agent is retried automatically instead of halting the run', async () => {
  let attempts = 0;
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (++attempts === 1) return { status: 'interrupted', reason: 'timeout', text: '', diagnostic: 'timed out', usage: { source: 'unavailable', values: null } };
    fs.writeFileSync(path.join(cwd, 'app.txt'), 'new\n'); return okay('Implemented');
  });
  const t = add(c); c.control('start'); await stage(c);
  assert.equal(t.status, 'queued', 'the task is retried');
  assert.equal(c.state.recoveryRequired, undefined, 'no human confirmation is demanded');
  assert.equal(c.state.mode, 'running', 'the run keeps going');
  await stage(c);
  assert.equal(t.stage, 'review', 'the retry succeeded');
});

test('a stop whose cause is unknown still halts for a human', async () => {
  const c = fixture(async () => ({ status: 'interrupted', reason: 'termination_uncertain', text: '', diagnostic: '', usage: { source: 'unavailable', values: null } }));
  const t = add(c); c.control('start'); await stage(c);
  assert.equal(t.status, 'interrupted');
  assert.equal(c.state.mode, 'paused');
  assert.match(c.state.recoveryRequired, /termination uncertain/i);
});

test('the watchdog stops a call that has hung well past its own timeout', async () => {
  let aborted = false;
  const c = fixture(async (provider, config, prompt, role, cwd, limits, signal) => {
    signal?.addEventListener('abort', () => { aborted = true; });
    await new Promise(resolve => setTimeout(resolve, 400));
    return { status: 'interrupted', reason: 'cancelled', text: '', diagnostic: '', usage: { source: 'unavailable', values: null } };
  });
  c.setLimits({ ...c.state.limits, timeoutMs: 1000, stuckAfterMs: 60000 });
  const t = add(c); c.control('start'); c.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  t.startedAt = Date.now() - 3600000; // pretend it has been hanging for an hour
  c.watchdog();
  assert.equal(aborted, true, 'the hung call is aborted');
  assert.equal(t.stuckStops, 1, 'the intervention is recorded');
  assert.ok(c.state.events.some(e => e.type === 'watchdog_stopped'), 'and reported in the timeline');
  await drain(c);
});

test('the watchdog leaves a call that is merely slow alone', async () => {
  const c = fixture(async () => { await new Promise(r => setTimeout(r, 300)); return okay('done'); });
  c.setLimits({ ...c.state.limits, timeoutMs: 300000, stuckAfterMs: 600000 });
  const t = add(c); c.control('start'); c.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  t.startedAt = Date.now() - 60000; // one minute in, well inside its timeout
  c.watchdog();
  assert.equal(t.stuckStops, undefined, 'a slow call is not disturbed');
  await drain(c);
});

test('refusing a dirty repository names the files that are in the way', () => {
  const dir = fs.mkdtempSync(path.join(fixtures, 'dirty-')), repo = path.join(dir, 'repo');
  fs.mkdirSync(repo); git(repo, 'init');
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'x\n'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'scratch.log'), 'junk\n');
  const c = new Coordinator(path.join(dir, 'state'), { executor: async () => okay() });
  assert.throws(() => c.configure({ repo, requirements: 'x', testCommands: [['node', '--version']] }), err => {
    assert.match(err.message, /2 uncommitted change/);
    assert.match(err.message, /committed\.txt/);
    assert.match(err.message, /scratch\.log/);
    assert.match(err.message, /Commit or stash/);
    return true;
  });
});

test('a download that checks out dirty is normalised instead of being refused', async () => {
  const dir = fs.mkdtempSync(path.join(fixtures, 'crlf-'));
  const c = new Coordinator(path.join(dir, 'state'), { executor: async () => okay() });
  const runner = async (command, args, opts) => {
    const target = path.join(opts.cwd, 'ytfactory');
    fs.mkdirSync(target, { recursive: true }); git(target, 'init');
    fs.writeFileSync(path.join(target, 'app.py'), 'print("hi")\n'); git(target, 'add', '.');
    git(target, '-c', 'user.name=T', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
    fs.writeFileSync(path.join(target, 'app.py'), 'print("hi")\r\n');  // what autocrlf does on Windows
    fs.writeFileSync(path.join(target, 'stray.tmp'), 'junk');
    assert.ok(git(target, 'status', '--porcelain'), 'the checkout really is dirty first');
    return { code: 0, reason: '', output: 'Cloning…', durationMs: 1 };
  };
  const result = await cloneFromGitHub(c, { name: 'adelrio23/ytfactory', requirements: 'Fix the queries', testCommands: [['python', '-m', 'unittest']] },
    { runner, repositories: async () => [{ name: 'adelrio23/ytfactory', isPrivate: true, eligible: true }] });
  assert.equal(c.state.repo, result.repo, 'it configured despite the dirty checkout');
  assert.equal(git(result.repo, 'status', '--porcelain'), '', 'the checkout was normalised');
  assert.ok(!fs.existsSync(path.join(result.repo, 'stray.tmp')), 'untracked leftovers are cleared');
});

test('downloading again reuses the copy already on disk instead of dead-ending', async () => {
  const dir = fs.mkdtempSync(path.join(fixtures, 'reuse-'));
  const c = new Coordinator(path.join(dir, 'state'), { executor: async () => okay() });
  const target = path.join(c.dir, 'projects', 'ytfactory');
  fs.mkdirSync(target, { recursive: true }); git(target, 'init');
  fs.writeFileSync(path.join(target, 'app.py'), 'x\n'); git(target, 'add', '.');
  git(target, '-c', 'user.name=T', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  let cloned = false;
  const result = await cloneFromGitHub(c, { name: 'adelrio23/ytfactory', requirements: 'Fix it', testCommands: [['python', '-m', 'unittest']] },
    { runner: async () => { cloned = true; return { code: 0, reason: '', output: '', durationMs: 1 }; }, repositories: async () => [{ name: 'adelrio23/ytfactory', isPrivate: true, eligible: true }] });
  assert.equal(cloned, false, 'it does not re-download what is already there');
  assert.equal(path.resolve(result.repo), path.resolve(target));
  assert.equal(c.state.repo, result.repo);
});

test('every agent starts enabled; availability comes from the live check, not a stale note', () => {
  const c = new Coordinator(fs.mkdtempSync(path.join(fixtures, 'providers-')), { executor: async () => okay() });
  for (const [name, provider] of Object.entries(c.state.providers)) {
    assert.equal(provider.enabled, true, `${name} starts enabled`);
    assert.equal(provider.blocked, null, `${name} starts unblocked`);
  }
  // Three agents means a build, an independent review and a three-way vote.
  assert.equal(Object.values(c.state.providers).filter(p => p.enabled && !p.blocked).length, 3);
});

test('failing tests send the build back with the failure output, not to a dead end', async () => {
  let builds = 0, seen = null;
  const c = fixture(
    async (provider, config, prompt, role, cwd) => {
      if (role === 'review') return okay('Good.\nREVIEW: PASS');
      seen = contextOf(prompt); builds++;
      fs.writeFileSync(path.join(cwd, 'app.txt'), `attempt ${builds}\n`); return okay('Implemented');
    },
    async () => builds === 1
      ? { code: 1, reason: '', output: 'FAIL test_scene_query: expected 3 results, got 0', durationMs: 1 }
      : { code: 0, reason: '', output: 'ok', durationMs: 1 }
  );
  const t = add(c); c.control('start');
  await stage(c);
  assert.equal(t.status, 'queued', 'the task is handed back to the builder');
  assert.equal(t.repairs, 1);
  assert.equal(t.blocked, null, 'it is not blocked');
  await stage(c);
  assert.equal(seen.failingTestsToAddress.length, 1, 'the second attempt was told what failed');
  assert.match(seen.failingTestsToAddress[0].output, /expected 3 results, got 0/);
  assert.equal(seen.failingTestsToAddress[0].exitCode, 1);
  assert.equal(t.stage, 'review', 'the repaired build passed and moved on');
});

test('tests that keep failing stop after the repair rounds are spent', async () => {
  const c = fixture(
    async (provider, config, prompt, role, cwd) => { fs.writeFileSync(path.join(cwd, 'app.txt'), `x${Math.random()}\n`); return okay('Implemented'); },
    async () => ({ code: 1, reason: '', output: 'still failing', durationMs: 1 })
  );
  c.setLimits({ ...c.state.limits, maxRepairRounds: 2 });
  const t = add(c); c.control('start');
  for (let i = 0; i < 8 && t.status !== 'blocked'; i++) await stage(c);
  assert.equal(t.status, 'blocked');
  assert.match(t.blocked, /Tests still failing after 2 repair round/);
});

test('the test command can be corrected after milestones are queued', async () => {
  const c = fixture(async () => okay());
  add(c); add(c);
  assert.ok(c.state.tasks.length, 'work is queued, so configure() would refuse');
  assert.throws(() => c.configure({ repo: c.state.repo, requirements: 'x', testCommands: [['python', '-m', 'pytest']] }), /fresh workspace/);

  const updated = c.setTestCommands({ testCommands: [['python', '-m', 'tests.offline', 'discover', '-s', 'tests', '-t', '.']] });
  assert.deepEqual(updated.testCommands, [['python', '-m', 'tests.offline', 'discover', '-s', 'tests', '-t', '.']]);
  assert.deepEqual(c.state.testCommands, updated.testCommands, 'the queued work now runs the corrected command');
  assert.ok(c.state.events.some(e => e.type === 'test_commands_changed'), 'the change is recorded');
});

test('changing the test command is refused while work is running or malformed', async () => {
  const c = fixture(async () => okay());
  c.control('start');
  assert.throws(() => c.setTestCommands({ testCommands: [['python']] }), /Pause and let active work finish/);
  c.control('pause');
  for (const bad of [[], [[]], [['ok'], ['a'], ['b'], ['c'], ['d'], ['e']], ['not-an-array'], [[123]]]) {
    assert.throws(() => c.setTestCommands({ testCommands: bad }), /test commands|Invalid test command/);
  }
  assert.deepEqual(c.state.testCommands, [[process.execPath, '--test']], 'a rejected change leaves the command alone');
});

test('the Codex sandbox is configurable and defaults to read-only', () => {
  assert.equal(codexSandbox({}), 'read-only', 'the default is unchanged');
  assert.equal(codexSandbox({ sandbox: 'nonsense' }), 'read-only', 'an unknown value falls back rather than widening access');
  assert.equal(codexSandbox({ sandbox: 'workspace-write' }), 'workspace-write');
  const args = invocation('codex', { command: 'codex', sandbox: 'workspace-write', models: {} }, 'p', 'build', '/tmp').args;
  assert.ok(args.includes('workspace-write'), 'the chosen sandbox reaches the CLI');
  assert.ok(!args.includes('read-only'));
  assert.ok(invocation('codex', { command: 'codex', models: {} }, 'p', 'build', '/tmp').args.includes('read-only'), 'unconfigured stays read-only');
});

test('only Codex takes a sandbox setting, and only a valid one', () => {
  const c = fixture(async () => okay());
  c.control('pause');
  c.setModels({ provider: 'codex', build: 'gpt-6-astra', review: 'gpt-6-astra', sandbox: 'workspace-write' });
  assert.equal(c.state.adapters.codex.sandbox, 'workspace-write');
  assert.throws(() => c.setModels({ provider: 'codex', build: 'gpt-6-astra', review: 'gpt-6-astra', sandbox: 'anything-goes' }), /Invalid Codex sandbox/);
  assert.equal(c.state.adapters.codex.sandbox, 'workspace-write', 'a rejected value leaves the setting alone');
  c.setModels({ provider: 'kimi', build: 'kimi-code/kimi-for-coding', review: 'kimi-code/kimi-for-coding', sandbox: 'danger-full-access' });
  assert.equal(c.state.adapters.kimi.sandbox, undefined, 'other providers are unaffected');
});

test('the fast command runs every build; the full suite runs once per merge', async () => {
  const ran = [];
  const c = fixture(
    async (provider, config, prompt, role, cwd) => { if (role === 'build') fs.writeFileSync(path.join(cwd, 'app.txt'), 'new\n'); return okay(role === 'review' ? 'Good.\nREVIEW: PASS' : 'Implemented'); },
    async (command, args) => { ran.push([command, ...args].join(' ')); return { code: 0, reason: '', output: 'ok', durationMs: 1 }; }
  );
  c.setTestCommands({ testCommands: [['fast', 'unit']], integrationTestCommands: [['slow', 'everything']] });
  const t = add(c); c.control('start'); await stage(c); await stage(c);
  assert.deepEqual(ran, ['fast unit'], 'only the fast command gates the build');
  c.control('pause'); await c.integrate(t.id);
  assert.deepEqual(ran, ['fast unit', 'slow everything'], 'the full suite runs at the merge');
});

test('without a separate full suite the same command is used for both', async () => {
  const ran = [];
  const c = fixture(
    async (provider, config, prompt, role, cwd) => { if (role === 'build') fs.writeFileSync(path.join(cwd, 'app.txt'), 'new\n'); return okay(role === 'review' ? 'Good.\nREVIEW: PASS' : 'Implemented'); },
    async (command, args) => { ran.push([command, ...args].join(' ')); return { code: 0, reason: '', output: 'ok', durationMs: 1 }; }
  );
  c.setTestCommands({ testCommands: [['only', 'suite']] });
  assert.ok(!c.state.integrationTestCommands, 'no separate full suite is configured');
  const t = add(c); c.control('start'); await stage(c); await stage(c);
  c.control('pause'); await c.integrate(t.id);
  assert.deepEqual(ran, ['only suite', 'only suite']);
});

test('a slow suite is allowed a realistic timeout', () => {
  const c = fixture(async () => okay());
  c.control('pause');
  c.setLimits({ ...c.state.limits, testTimeoutMs: 1800000 }); // a 30-minute suite
  assert.equal(c.state.limits.testTimeoutMs, 1800000);
  assert.throws(() => c.setLimits({ ...c.state.limits, testTimeoutMs: 5400001 }), /Invalid limit/);
});

test('a long brief is accepted rather than truncated at four thousand characters', async () => {
  const c = fixture(async () => okay('ack'));
  c.control('pause');
  const brief = 'Fix the scene queries. '.repeat(700); // ~16k characters, well past the old cap
  assert.ok(brief.length > 4000 && brief.length < 20000);
  const record = await c.chat({ provider: 'codex', message: brief });
  assert.equal(record.status, 'ok', 'a long brief is accepted');
  await assert.rejects(() => c.chat({ provider: 'codex', message: 'x'.repeat(20001) }), /at most/);
});

test('each integrated milestone is remembered and reaches later agents for free', async () => {
  let seen = null;
  const c = fixture(async (provider, config, prompt, role, cwd) => {
    if (role === 'build') { seen = contextOf(prompt); fs.writeFileSync(path.join(cwd, 'app.txt'), `v${Math.random()}\n`); return okay('Added the parser and its tests'); }
    return okay('Meets the criteria.\nREVIEW: PASS');
  });
  c.state.policy.autoPlan = false;
  const first = add(c, { title: 'Add the parser' });
  c.control('start'); await stage(c); await stage(c);
  c.control('pause'); await c.integrate(first.id);
  const callsAfterMemory = c.state.calls;
  assert.equal(c.state.memory.length, 1, 'the milestone is recorded');
  assert.match(c.state.memory[0].summary, /Added the parser/);
  assert.equal(c.state.memory[0].title, 'Add the parser');
  assert.equal(callsAfterMemory, 2, 'remembering costs no model call');

  const second = add(c, { title: 'Use the parser' });
  c.control('start'); await stage(c);
  assert.equal(seen.completedMilestones.length, 1, 'the next agent is told what came before');
  assert.equal(seen.completedMilestones[0].milestone, 'Add the parser');
  assert.match(seen.completedMilestones[0].what, /Added the parser/);
});

test('project memory is bounded so a long run cannot grow the prompt without limit', () => {
  const c = fixture(async () => okay());
  for (let i = 0; i < 260; i++) c.remember({ title: `Milestone ${i}`, summary: 'x'.repeat(2000) });
  assert.equal(c.state.memory.length, 200, 'older entries fall off');
  const brief = c.memoryBrief();
  assert.equal(brief.length, 12, 'only the recent ones are carried into a prompt');
  assert.ok(brief.every(entry => entry.what.length <= 600), 'each is truncated');
});

test('a discussion gives every agent a turn, each hearing the ones before', async () => {
  const prompts = [];
  const c = fixture(async (provider, config, prompt) => { prompts.push({ provider, prompt }); return okay(`${provider} thinks the floor should stay as it is.`); });
  c.control('pause');
  const discussion = await c.discuss({ topic: 'Should the relevance floor judge against the scene query?' });

  assert.equal(discussion.turns.length, 3, 'all three available agents speak');
  assert.equal(c.state.calls, 3, 'one call each, no more');
  assert.match(prompts[0].prompt, /You are speaking first/);
  assert.doesNotMatch(prompts[0].prompt, /WHAT THE OTHERS HAVE SAID/);
  assert.match(prompts[1].prompt, /WHAT THE OTHERS HAVE SAID/, 'the second hears the first');
  assert.match(prompts[1].prompt, new RegExp(`${prompts[0].provider} said`));
  assert.match(prompts[2].prompt, new RegExp(`${prompts[1].provider} said`), 'the third hears both');
  assert.match(prompts[2].prompt, /Say plainly where you disagree/);
});

test('a discussion becomes binding only when its outcome is recorded', async () => {
  const c = fixture(async (provider) => okay(`${provider}: keep the floor.`));
  c.control('pause');
  await c.discuss({ topic: 'The floor' });
  assert.ok(!c.state.discussion.adopted);
  assert.equal(c.state.decisions.length, 0, 'talking alone changes nothing');

  c.adoptDiscussion('Keep relevance_to as the scene query; investigate the caller instead.');
  assert.equal(c.state.discussion.adopted, true);
  assert.match(c.state.decisions.at(-1).text, /Keep relevance_to/);
});

test('a discussion is refused without two agents or enough budget', async () => {
  const c = fixture(async () => okay('a view'));
  c.control('pause');
  c.provider('kimi', false); c.provider('claude', false);
  await assert.rejects(() => c.discuss({ topic: 'anything' }), /at least two available agents/);
  c.provider('kimi', true); c.provider('claude', true);
  c.setLimits({ ...c.state.limits, maxCalls: 2 });
  await assert.rejects(() => c.discuss({ topic: 'anything' }), /Not enough call budget/);
  assert.equal(c.state.calls, 0, 'nothing is spent on a refused discussion');
});

test('a workspace still on superseded defaults is carried forward on load', () => {
  const dir = fs.mkdtempSync(path.join(fixtures, 'migrate-'));
  const first = new Coordinator(dir, { executor: async () => okay() });
  // The values this project shipped with before the defaults were raised.
  Object.assign(first.state.limits, { maxCalls: 12, testTimeoutMs: 60000, maxAttempts: 2, maxFiles: 10 });
  first.save();

  const reloaded = new Coordinator(dir, { executor: async () => okay() });
  assert.equal(reloaded.state.limits.maxCalls, defaults.maxCalls, 'the call budget is raised');
  assert.equal(reloaded.state.limits.testTimeoutMs, defaults.testTimeoutMs, 'the one-minute test timeout is gone');
  assert.equal(reloaded.state.limits.maxAttempts, defaults.maxAttempts);
  assert.equal(reloaded.state.limits.maxFiles, defaults.maxFiles);
  assert.ok(reloaded.state.events.some(e => e.type === 'limit_default_raised'), 'the change is recorded, not silent');
});

test('a limit somebody actually chose is never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(fixtures, 'keep-'));
  const first = new Coordinator(dir, { executor: async () => okay() });
  first.setLimits({ ...first.state.limits, maxCalls: 25, testTimeoutMs: 45000 });
  first.save();

  const reloaded = new Coordinator(dir, { executor: async () => okay() });
  assert.equal(reloaded.state.limits.maxCalls, 25, 'a deliberate budget survives');
  assert.equal(reloaded.state.limits.testTimeoutMs, 45000, 'a deliberate timeout survives');
});

test('a safe idle restart resumes unattended work but active ownership still pauses', () => {
  const safe=fixture(async()=>okay());add(safe);safe.state.mode='running';safe.save();
  const resumed=new Coordinator(safe.dir);assert.equal(resumed.state.mode,'running');assert.equal(resumed.state.recoveryRequired,null);
  const unsafe=fixture(async()=>okay());const task=add(unsafe);task.status='building';task.owner='codex';unsafe.state.mode='running';unsafe.save();
  const stopped=new Coordinator(unsafe.dir);assert.equal(stopped.state.mode,'paused');assert.match(stopped.state.recoveryRequired,/Interrupted/);
});

test('automatic planning replaces a quota-failed lead on the next tick', async () => {
  let codexCalls=0,kimiCalls=0;
  const c=fixture(async(provider,config,prompt)=>{
    if(provider==='codex'){codexCalls++;return {status:'quota',text:'',diagnostic:'quota'};}
    kimiCalls++;return okay('<coordinator-plan>{"summary":"done","questions":["Need input"],"tasks":[]}</coordinator-plan>');
  });
  const done=add(c);done.status='integrated';c.state.policy.autoPlan=true;c.state.mode='running';
  c.autoPlan();while(c.planning)await new Promise(r=>setTimeout(r,5));
  assert.match(c.state.providers.codex.blocked,/quota/);
  c.autoPlan();while(c.planning)await new Promise(r=>setTimeout(r,5));
  assert.equal(codexCalls,1);assert.equal(kimiCalls,1);
});