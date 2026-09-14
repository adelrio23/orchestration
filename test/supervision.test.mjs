import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RESTARTS_PER_WINDOW, restartDecision } from '../lib/supervision.mjs';

test('supervisor never restarts a clean or operator-requested stop', () => {
  assert.equal(restartDecision({ code: 0, stopping: false }).restart, false);
  assert.equal(restartDecision({ code: 1, stopping: true }).restart, false);
});

test('supervisor backs off repeated crashes and retains the rolling window', () => {
  const now=1_000_000;
  const first=restartDecision({code:1,stopping:false,starts:[],now});
  const second=restartDecision({code:1,stopping:false,starts:first.starts,now:now+100});
  assert.equal(first.restart,true);assert.equal(first.delayMs,2000);
  assert.equal(second.restart,true);assert.equal(second.delayMs,5000);
  assert.equal(second.starts.length,2);
});

test('supervisor stops a crash loop after the hourly cap', () => {
  const now=5_000_000;
  const starts=Array.from({length:MAX_RESTARTS_PER_WINDOW},(_,i)=>now-i*1000);
  const decision=restartDecision({code:1,stopping:false,starts,now});
  assert.equal(decision.restart,false);assert.equal(decision.reason,'restart_cap');
});

test('old crashes age out of the restart window', () => {
  const now=10_000_000;
  const decision=restartDecision({code:1,stopping:false,starts:[now-4_000_000],now});
  assert.equal(decision.restart,true);assert.equal(decision.delayMs,2000);
});
