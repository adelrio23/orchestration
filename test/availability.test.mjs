import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateKnownWork, providerOperationalState, taskOperationalState, teamOperationalStatus } from '../lib/operations.mjs';

const now = Date.parse('2026-09-14T18:00:00Z');
const base = {
  mode: 'running',
  calls: 4,
  limits: { maxCalls: 20 },
  recoveryRequired: null,
  tasks: [{ status: 'waiting' }],
  providers: {}
};

test('provider state separates quota, authentication, disabled and available agents', () => {
  assert.deepEqual(
    providerOperationalState('codex', { enabled: true, blocked: null }, now),
    { name: 'codex', enabled: true, state: 'available', usable: true, automatic: true, message: 'Available for dispatch; live access is confirmed on use.' }
  );
  const quota = providerOperationalState('kimi', { enabled: true, blocked: 'quota: exhausted', availableAt: now + 60_000 }, now);
  assert.equal(quota.state, 'quota');
  assert.equal(quota.automatic, true);
  assert.equal(quota.availableAt, now + 60_000);
  const auth = providerOperationalState('claude', { enabled: true, blocked: 'auth: login required' }, now);
  assert.equal(auth.state, 'authentication');
  assert.equal(auth.automatic, false);
  assert.equal(providerOperationalState('claude', { enabled: false, blocked: 'Disabled by operator' }, now).state, 'disabled');
});

test('team status explains degraded independence and the next recovery', () => {
  const state = {
    ...base,
    providers: {
      codex: { enabled: true, blocked: null },
      kimi: { enabled: true, blocked: 'quota: exhausted', availableAt: now + 60_000 },
      claude: { enabled: false, blocked: 'Disabled by operator' }
    }
  };
  const status = teamOperationalStatus(state, 0, now);
  assert.equal(status.state, 'degraded');
  assert.equal(status.nextRecoveryAt, now + 60_000);
  assert.match(status.detail, /independent|expected/i);
});

test('team status prioritizes action-required and hard budget boundaries', () => {
  assert.equal(teamOperationalStatus({ ...base, recoveryRequired: 'Verify old processes.' }, 0, now).state, 'action_required');
  assert.equal(teamOperationalStatus({ ...base, calls: 20 }, 0, now).state, 'budget_exhausted');
});

test('team status reports working before provider availability detail', () => {
  const state = { ...base, providers: { codex: { enabled: true, blocked: null } } };
  assert.equal(teamOperationalStatus(state, 2, now).state, 'working');
});

test('task routing respects eligibility and independent review', () => {
  const providers = [
    ['codex', { enabled: true, blocked: null }],
    ['kimi', { enabled: true, blocked: 'quota: exhausted', availableAt: now + 60_000 }],
    ['claude', { enabled: true, blocked: null }]
  ];
  const build = taskOperationalState({ id: 'a', title: 'Build', status: 'queued', stage: 'build', eligible: ['codex', 'kimi'] }, providers, now);
  assert.equal(build.runnable, true);
  assert.match(build.reason, /codex/);
  const review = taskOperationalState({ id: 'b', title: 'Review', status: 'waiting', stage: 'review', builder: 'codex', eligible: ['codex', 'kimi'] }, providers, now);
  assert.equal(review.runnable, false);
  assert.equal(review.state, 'waiting_for_usage');
  assert.equal(review.nextRecoveryAt, now + 60_000);
});

test('task routing reports when no independent reviewer is eligible', () => {
  const status = taskOperationalState(
    { id: 'a', title: 'Review', status: 'queued', stage: 'review', builder: 'codex', eligible: ['codex'] },
    [['codex', { enabled: true, blocked: null }]],
    now
  );
  assert.equal(status.state, 'blocked');
  assert.match(status.reason, /cannot review its own work/);
});

test('known-work forecast counts build plus review and review-only stages', () => {
  assert.equal(estimateKnownWork([
    { status: 'queued', stage: 'build' },
    { status: 'waiting', stage: 'review' },
    { status: 'integrated', stage: 'review' }
  ]), 3);
});

test('team status warns before the queue exceeds remaining call budget', () => {
  const status = teamOperationalStatus({
    ...base,
    calls: 18,
    providers: {
      codex: { enabled: true, blocked: null },
      kimi: { enabled: true, blocked: null }
    },
    tasks: [
      { id: 'a', title: 'One', status: 'queued', stage: 'build', eligible: ['codex', 'kimi'] },
      { id: 'b', title: 'Two', status: 'queued', stage: 'build', eligible: ['codex', 'kimi'] }
    ]
  }, 0, now);
  assert.equal(status.state, 'budget_at_risk');
  assert.equal(status.budget.minimumCalls, 4);
  assert.equal(status.budget.remainingCalls, 2);
});
