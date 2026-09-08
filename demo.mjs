// Optional live verification. Uses at most two subscription calls (Codex build, Kimi review).
import fs from 'node:fs';
import path from 'node:path';
import { Coordinator, git } from './lib/core.mjs';
const root = path.resolve('data', 'live-demo-' + Date.now()); const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
git(repo, 'init');
fs.writeFileSync(path.join(repo, 'math.mjs'), "export function add() { throw new Error('not implemented'); }\n");
fs.writeFileSync(path.join(repo, 'test/math.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import {add} from '../math.mjs';
test('addition handles positive, negative and fractional numbers',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,1),-1);assert.equal(add(.5,.25),.75)});
test('addition rejects invalid inputs',()=>{for(const x of ['1',null,undefined,NaN,Infinity])assert.throws(()=>add(x,2),TypeError)});
`);
git(repo, 'add', '.'); git(repo, '-c', 'user.name=Demo', '-c', 'user.email=demo@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Disposable acceptance fixture');
const c = new Coordinator(path.join(root, 'state'));
c.configure({ repo, requirements: 'Implement and independently review a tiny arithmetic module. No other changes.', testCommands: [[process.execPath, '--test', 'test/*.test.mjs']] });
c.setLimits({ maxCalls: 2, maxAttempts: 1, timeoutMs: 60000 });
const task = c.addTask({ title: 'Implement finite-number addition', requirements: 'Implement exported add(a,b) in math.mjs. Return a+b for finite numbers; throw TypeError if either input is not a finite number. Do not change tests. Keep the implementation minimal.', acceptance: 'Existing tests pass. Both arguments validated with Number.isFinite. Only math.mjs changes.', scope: ['math.mjs'], eligible: ['codex', 'kimi'] });
c.control('start');
console.log('Live fixture:', root);
const timer = setInterval(() => {
  c.tick();
  if (!c.running.size && !c.integrating && ['integrated', 'blocked', 'waiting', 'interrupted'].includes(task.status)) {
    clearInterval(timer); c.control('pause');
    const report = { at: new Date().toISOString(), status: task.status, blocked: task.blocked, calls: c.state.calls, task, runs: c.state.runs, root };
    fs.mkdirSync('data/verification', { recursive: true }); fs.writeFileSync('data/verification/live-workflow.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: task.status, blocked: task.blocked, calls: c.state.calls, builder: task.builder, reviewer: task.review?.provider, integrationCommit: task.integrationCommit }));
    if (task.status !== 'integrated') process.exitCode = 1;
  }
}, 500);
