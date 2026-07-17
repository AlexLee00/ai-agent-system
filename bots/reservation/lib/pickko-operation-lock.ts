import { randomUUID } from 'node:crypto';

export function createPickkoOperationLockOwner(role: string): string {
  const normalizedRole = String(role || 'pickko').trim().replace(/[^a-z0-9_-]+/gi, '_');
  return `${normalizedRole || 'pickko'}:${process.pid}:${randomUUID()}`;
}

/**
 * @param {{
 *   owner: string,
 *   ttlMs: number,
 *   waitMs: number,
 *   pollMs: number,
 *   acquireLock: (owner: string, ttlMs: number) => Promise<boolean>,
 *   getLockState: () => Promise<{locked: boolean, by: string|null}>,
 *   delay: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 * }} options
 */
export async function waitForPickkoOperationLock({
  owner,
  ttlMs,
  waitMs,
  pollMs,
  acquireLock,
  getLockState,
  delay,
  now = Date.now,
}) {
  const startedAt = now();
  let attempts = 0;
  let blockedBy = null;

  while (true) {
    attempts += 1;
    if (await acquireLock(owner, ttlMs)) {
      return {
        acquired: true,
        attempts,
        waitedMs: Math.max(0, now() - startedAt),
        blockedBy,
      };
    }

    const state = await getLockState();
    blockedBy = state.locked ? state.by : null;
    const elapsed = Math.max(0, now() - startedAt);
    if (elapsed >= waitMs) {
      return {
        acquired: false,
        attempts,
        waitedMs: elapsed,
        blockedBy,
      };
    }

    await delay(Math.min(Math.max(1, pollMs), waitMs - elapsed));
  }
}

export async function requirePickkoOperationLockRenewal({ owner, ttlMs, renewLock }) {
  if (typeof renewLock !== 'function' || !(await renewLock(owner, ttlMs))) {
    throw new Error('pickko_operation_lock_renew_failed');
  }
}

export function waitForPickkoChildProcess(child, {
  timeoutMs,
  killGraceMs = 5_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeoutTimer = null;
    let forceKillTimer = null;
    let terminationError = null;

    const finish = ({ code, signal, error = null }) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimer(timeoutTimer);
      if (forceKillTimer) clearTimer(forceKillTimer);
      resolve({ code, signal, error, timedOut });
    };

    child.once('error', (error) => { terminationError = error; });
    child.once('close', (code, signal) => finish({ code, signal, error: terminationError }));

    timeoutTimer = setTimer(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch (error) {
        terminationError = error;
      }
      forceKillTimer = setTimer(() => {
        try {
          child.kill('SIGKILL');
        } catch (error) {
          terminationError = error;
        }
      }, Math.max(1, killGraceMs));
    }, Math.max(1, timeoutMs));
  });
}
