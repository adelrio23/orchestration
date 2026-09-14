const ACTIVE = new Set(['building', 'reviewing', 'testing', 'integrating']);
const PENDING = new Set(['queued', 'waiting']);

export function providerOperationalState(name, provider, timestamp = Date.now()) {
  const base = { name, enabled: !!provider.enabled };
  if (!provider.enabled) return { ...base, state: 'disabled', usable: false, automatic: false, message: 'Disabled by you.' };
  const blocked = provider.blocked || '';
  if (/^quota/.test(blocked)) {
    const availableAt = provider.availableAt || null;
    const waiting = availableAt && availableAt > timestamp;
    return { ...base, state: 'quota', usable: false, automatic: true, availableAt, message: waiting ? `Usage exhausted. Automatic recovery is scheduled for ${new Date(availableAt).toISOString()}.` : 'Usage exhausted. An automatic recovery check is due.' };
  }
  if (/^auth/.test(blocked)) return { ...base, state: 'authentication', usable: false, automatic: false, message: 'Sign in to this CLI again, then re-enable the provider.' };
  if (blocked) return { ...base, state: 'blocked', usable: false, automatic: false, message: blocked };
  return { ...base, state: 'available', usable: true, automatic: true, message: 'Available for dispatch; live access is confirmed on use.' };
}

export function taskOperationalState(task, providers, timestamp = Date.now()) {
  const states = providers.map(([name, provider]) => providerOperationalState(name, provider, timestamp));
  if (!PENDING.has(task.status)) return { id: task.id, title: task.title, state: ACTIVE.has(task.status) ? 'working' : task.status, runnable: false, reason: task.blocked || `Task is ${task.status}.`, candidates: [] };
  const eligible = new Set(task.eligible || []);
  const candidates = states.filter(provider => eligible.has(provider.name) && (task.stage !== 'review' || provider.name !== task.builder));
  const usable = candidates.filter(provider => provider.usable);
  if (usable.length) return { id: task.id, title: task.title, stage: task.stage, state: 'runnable', runnable: true, reason: `${usable.map(provider => provider.name).join(', ')} can ${task.stage} this task now.`, candidates };
  if (!candidates.length && task.stage === 'review') return { id: task.id, title: task.title, stage: task.stage, state: 'blocked', runnable: false, reason: `No independent reviewer is eligible because ${task.builder || 'the builder'} cannot review its own work.`, candidates };
  const quota = candidates.filter(provider => provider.state === 'quota');
  const authentication = candidates.filter(provider => provider.state === 'authentication');
  const disabled = candidates.filter(provider => provider.state === 'disabled');
  const recoveryTimes = quota.map(provider => provider.availableAt).filter(Boolean);
  const nextRecoveryAt = recoveryTimes.length ? Math.min(...recoveryTimes) : null;
  let reason = candidates.map(provider => `${provider.name}: ${provider.message}`).join(' ');
  if (authentication.length) reason = `Login required for ${authentication.map(provider => provider.name).join(', ')}. ${reason}`;
  else if (quota.length) reason = `Waiting for usage from ${quota.map(provider => provider.name).join(', ')}. ${reason}`;
  else if (disabled.length) reason = `Eligible providers are disabled: ${disabled.map(provider => provider.name).join(', ')}.`;
  return { id: task.id, title: task.title, stage: task.stage, state: authentication.length ? 'action_required' : quota.length ? 'waiting_for_usage' : 'blocked', runnable: false, reason: reason || 'No eligible provider is available.', nextRecoveryAt, candidates };
}

export function estimateKnownWork(tasks) {
  return tasks.reduce((total, task) => {
    if (!PENDING.has(task.status)) return total;
    if (task.stage === 'review') return total + 1;
    if (task.stage === 'build') return total + 2;
    return total;
  }, 0);
}

export function teamOperationalStatus(state, runningCount = 0, timestamp = Date.now()) {
  const providers = Object.entries(state.providers).map(([name, provider]) => providerOperationalState(name, provider, timestamp));
  const tasks = state.tasks.map(task => taskOperationalState(task, Object.entries(state.providers), timestamp));
  const pending = tasks.filter(task => PENDING.has(state.tasks.find(item => item.id === task.id)?.status));
  const remainingCalls = Math.max(0, state.limits.maxCalls - state.calls);
  const minimumCalls = estimateKnownWork(state.tasks);
  const budget = { remainingCalls, minimumCalls, enoughForKnownWork: remainingCalls >= minimumCalls };
  const base = { state: 'idle', headline: 'Team is ready', detail: 'No work is waiting.', providers, tasks, budget, nextRecoveryAt: null };

  if (state.recoveryRequired) return { ...base, state: 'action_required', headline: 'Your attention is required', detail: state.recoveryRequired };
  if (!remainingCalls) return { ...base, state: 'budget_exhausted', headline: 'Coordinator call budget exhausted', detail: `${state.calls} of ${state.limits.maxCalls} CLI attempts used. Raise the limit while paused to continue.` };
  if (runningCount) return { ...base, state: 'working', headline: `${runningCount} agent call${runningCount === 1 ? '' : 's'} working`, detail: budget.enoughForKnownWork ? 'The known queue fits the remaining minimum call budget.' : `Known work needs at least ${minimumCalls} calls; only ${remainingCalls} remain.` };
  if (state.mode === 'paused') return { ...base, state: 'paused', headline: 'Coordinator paused', detail: pending.length ? `${pending.length} task${pending.length === 1 ? '' : 's'} waiting; nothing dispatches until you resume.` : 'No new work will dispatch.' };
  if (!pending.length) return base;
  if (!budget.enoughForKnownWork) return { ...base, state: 'budget_at_risk', headline: 'Not enough budget for the known queue', detail: `At least ${minimumCalls} calls are needed for current build/review stages; ${remainingCalls} remain. Repairs and future planning would need more.` };

  const runnable = pending.filter(task => task.runnable);
  if (runnable.length) return { ...base, state: 'ready', headline: `${runnable.length} task${runnable.length === 1 ? '' : 's'} ready to dispatch`, detail: `Known work needs at least ${minimumCalls} calls; ${remainingCalls} remain.` };

  const recoveryTimes = pending.map(task => task.nextRecoveryAt).filter(Boolean);
  const nextRecoveryAt = recoveryTimes.length ? Math.min(...recoveryTimes) : null;
  const actionable = pending.filter(task => task.state === 'action_required');
  if (actionable.length) return { ...base, state: 'action_required', headline: 'Agent login required', detail: actionable.map(task => task.reason).join(' '), nextRecoveryAt };
  if (nextRecoveryAt) return { ...base, state: 'waiting_for_usage', headline: 'Waiting for usage to reset', detail: `${pending.length} task${pending.length === 1 ? '' : 's'} waiting. Automatic recovery is scheduled.`, nextRecoveryAt };
  return { ...base, state: 'blocked', headline: 'No queued task is routable', detail: pending.map(task => `${task.title}: ${task.reason}`).join(' ') };
}
