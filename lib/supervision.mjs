export const RESTART_DELAYS_MS = [2000, 5000, 15000, 30000, 60000, 120000, 300000];
export const RESTART_WINDOW_MS = 3600000;
export const MAX_RESTARTS_PER_WINDOW = 8;

export function restartDecision({ code, signal, stopping, starts = [], now = Date.now() }) {
  if (stopping || code === 0) return { restart: false, reason: stopping ? 'operator_stop' : 'clean_exit', starts: [] };
  const recent = starts.filter(start => now - start < RESTART_WINDOW_MS);
  if (recent.length >= MAX_RESTARTS_PER_WINDOW) {
    return { restart: false, reason: 'restart_cap', starts: recent };
  }
  const delayMs = RESTART_DELAYS_MS[Math.min(recent.length, RESTART_DELAYS_MS.length - 1)];
  return { restart: true, reason: signal ? `signal:${signal}` : `exit:${code ?? 'unknown'}`, delayMs, starts: [...recent, now] };
}
