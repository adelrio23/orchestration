import test from 'node:test';
import assert from 'node:assert/strict';
import { providerOperationalState, teamOperationalStatus } from '../lib/core.mjs';

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
