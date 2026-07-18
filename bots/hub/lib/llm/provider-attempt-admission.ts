'use strict';

const { acquireSharedLimiterLease } = require('./shared-limiter');

type ProviderIdentity = {
  team?: string;
  provider?: string;
};

type ProviderAdmissionDeps = {
  acquire?: (identity: ProviderIdentity) => Promise<any>;
  deadlineSignal?: AbortSignal;
  attemptSignal?: AbortSignal;
  // Backward compatibility for vision/embedding callers. This is a total deadline.
  signal?: AbortSignal;
  retryAfterMs?: number;
  releaseTimeoutMs?: number;
  terminationGraceMs?: number;
};

type LeaseAcquisition = { aborted: true } | { aborted: false; lease: any };
type LeaseRelease = { ok: true } | { ok: false; error: string };
type ExecutionSettlement =
  | { settled: true; fulfilled: true; value: any }
  | { settled: true; fulfilled: false; error: unknown }
  | { settled: false };

const DEFAULT_RELEASE_TIMEOUT_MS = 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

function combinedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function timeoutResult(
  deadlineSignal: AbortSignal | undefined,
  attemptSignal: AbortSignal | undefined,
  stage: 'admission' | 'provider_attempt',
  providerAttempted: boolean,
  durationMs = 0,
): Record<string, unknown> | null {
  if (deadlineSignal?.aborted) {
    return {
      ok: false,
      provider: 'failed',
      durationMs,
      error: `llm_total_deadline_exceeded:${stage}`,
      providerAttempted,
    };
  }
  if (attemptSignal?.aborted) {
    return {
      ok: false,
      provider: 'failed',
      durationMs,
      error: `llm_provider_attempt_timeout:${stage}`,
      providerAttempted,
    };
  }
  return null;
}

function releaseLateLease(leasePromise: Promise<any>): void {
  leasePromise
    .then((lease) => Promise.resolve(lease?.ok ? lease.release?.() : undefined))
    .catch(() => {});
}

async function releaseLeaseBounded(lease: any, timeoutMs: number): Promise<LeaseRelease> {
  let timeout: NodeJS.Timeout | null = null;
  const release: Promise<LeaseRelease> = Promise.resolve()
    .then(() => lease?.release?.())
    .then(() => ({ ok: true }) as LeaseRelease)
    .catch(() => ({ ok: false, error: 'shared_limiter_release_failed' }) as LeaseRelease);
  const timedOut = new Promise<LeaseRelease>((resolve) => {
    timeout = setTimeout(
      () => resolve({ ok: false, error: 'shared_limiter_release_timeout' }),
      Math.max(1, timeoutMs),
    );
  });
  const result = await Promise.race([release, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function acquireBeforeAbort(
  acquire: (identity: ProviderIdentity) => Promise<any>,
  identity: ProviderIdentity,
  signal?: AbortSignal,
): Promise<LeaseAcquisition> {
  const leasePromise = Promise.resolve().then(() => acquire(identity));
  if (!signal) return { aborted: false, lease: await leasePromise };
  if (signal.aborted) {
    releaseLateLease(leasePromise);
    return { aborted: true };
  }

  return new Promise<LeaseAcquisition>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      releaseLateLease(leasePromise);
      resolve({ aborted: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    leasePromise.then((lease) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve({ aborted: false, lease });
    }, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

async function waitForExecutionSettlement(
  execution: Promise<any>,
  signal: AbortSignal | undefined,
  terminationGraceMs: number,
): Promise<{ settlement: ExecutionSettlement; settledExecution: Promise<ExecutionSettlement> }> {
  const settledExecution: Promise<ExecutionSettlement> = execution.then(
    (value) => ({ settled: true, fulfilled: true, value }),
    (error) => ({ settled: true, fulfilled: false, error }),
  );
  if (!signal) return { settlement: await settledExecution, settledExecution };

  let removeAbortListener = () => {};
  const aborted = new Promise<ExecutionSettlement>((resolve) => {
    const onAbort = () => resolve({ settled: false });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const first = await Promise.race([settledExecution, aborted]);
  removeAbortListener();
  if (first.settled) return { settlement: first, settledExecution };

  let graceTimer: NodeJS.Timeout | null = null;
  const graceExpired = new Promise<ExecutionSettlement>((resolve) => {
    graceTimer = setTimeout(() => resolve({ settled: false }), Math.max(1, terminationGraceMs));
  });
  const afterGrace = await Promise.race([settledExecution, graceExpired]);
  if (graceTimer) clearTimeout(graceTimer);
  return { settlement: afterGrace, settledExecution };
}

function releaseQuarantinedLeaseWhenSettled(
  settledExecution: Promise<ExecutionSettlement>,
  lease: any,
  releaseTimeoutMs: number,
): void {
  void settledExecution.then(async () => {
    const release = await releaseLeaseBounded(lease, releaseTimeoutMs);
    if (!release.ok) console.error(`[llm/admission] quarantined lease release failed: ${release.error}`);
  });
}

async function runWithProviderAdmission(
  identity: ProviderIdentity,
  execute: (context: { signal: AbortSignal; scopes: string[] }) => Promise<any>,
  deps: ProviderAdmissionDeps = {},
): Promise<any> {
  const acquire = deps.acquire || acquireSharedLimiterLease;
  const deadlineSignal = deps.deadlineSignal || deps.signal;
  const attemptSignal = deps.attemptSignal;
  const admissionSignal = combinedSignal(deadlineSignal, attemptSignal);
  let acquisition: LeaseAcquisition;
  try {
    acquisition = await acquireBeforeAbort(acquire, identity, admissionSignal);
  } catch (error: any) {
    console.warn(`[llm/admission] shared limiter acquire failed: ${error?.message || String(error)}`);
    return {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      error: 'shared_limiter_acquire_failed',
      retryAfterMs: Number(deps.retryAfterMs || 1_000),
      admissionScope: null,
      limiterBackpressure: true,
      providerAttempted: false,
    };
  }
  if (!('lease' in acquisition)) {
    return timeoutResult(deadlineSignal, attemptSignal, 'admission', false)
      || {
        ok: false,
        provider: 'failed',
        durationMs: 0,
        error: 'llm_provider_attempt_timeout:admission',
        providerAttempted: false,
      };
  }
  const lease = acquisition.lease;
  if (!lease?.ok) {
    return {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      error: `${lease?.reason || 'shared_limiter_rejected'}:${lease?.scope || 'unknown'}`,
      retryAfterMs: Number(lease?.retryAfterMs || 0),
      admissionScope: lease?.scope || null,
      limiterBackpressure: true,
      providerAttempted: false,
    };
  }

  const leaseSignal = lease.signal || new AbortController().signal;
  const executionSignal = combinedSignal(leaseSignal, deadlineSignal, attemptSignal) || leaseSignal;
  let providerAttempted = false;
  let result: any = null;
  let executionError: unknown = null;
  try {
    const timedOutBeforeExecution = timeoutResult(deadlineSignal, attemptSignal, 'admission', false);
    if (timedOutBeforeExecution) {
      result = timedOutBeforeExecution;
    } else {
      providerAttempted = true;
      const executionStartedAt = Date.now();
      const execution = Promise.resolve().then(() => execute({
        signal: executionSignal,
        scopes: Array.isArray(lease.scopes) ? lease.scopes : [],
      }));
      const { settlement, settledExecution } = await waitForExecutionSettlement(
        execution,
        executionSignal,
        Math.max(1, Number(deps.terminationGraceMs || DEFAULT_TERMINATION_GRACE_MS)),
      );
      if (!settlement.settled) {
        console.error(
          `[llm/admission] provider termination unconfirmed; lease quarantined: ${identity.provider || 'unknown'}`,
        );
        releaseQuarantinedLeaseWhenSettled(
          settledExecution,
          lease,
          Number(deps.releaseTimeoutMs || DEFAULT_RELEASE_TIMEOUT_MS),
        );
        return {
          ok: false,
          provider: 'failed',
          durationMs: Date.now() - executionStartedAt,
          error: 'provider_termination_unconfirmed',
          retryAfterMs: Number(deps.retryAfterMs || 1_000),
          admissionScope: `provider:${identity.provider || 'unknown'}`,
          limiterBackpressure: true,
          providerAttempted: true,
          providerTerminationUnconfirmed: true,
          limiterLeaseQuarantined: true,
        };
      }
      if (!settlement.fulfilled) throw settlement.error;
      result = settlement.value;
      providerAttempted = result?.providerAttempted !== false;
      const leaseLost = leaseSignal.aborted
        || (typeof lease.isValid === 'function' && !lease.isValid());
      const timedOut = timeoutResult(
        deadlineSignal,
        attemptSignal,
        'provider_attempt',
        providerAttempted,
        Number(result?.durationMs || 0),
      );
      if (timedOut) {
        result = timedOut;
      } else if (leaseLost) {
        result = {
          ok: false,
          provider: 'failed',
          durationMs: Number(result?.durationMs || 0),
          error: 'shared_limiter_lease_lost',
          admissionScope: lease?.scope || null,
          retryAfterMs: Number(deps.retryAfterMs || 1_000),
          limiterBackpressure: true,
          providerAttempted,
        };
      }
    }
  } catch (error) {
    const leaseLost = leaseSignal.aborted
      || (typeof lease.isValid === 'function' && !lease.isValid());
    const timedOut = timeoutResult(deadlineSignal, attemptSignal, 'provider_attempt', providerAttempted);
    if (timedOut) {
      result = timedOut;
    } else if (leaseLost) {
      result = {
        ok: false,
        provider: 'failed',
        durationMs: 0,
        error: 'shared_limiter_lease_lost',
        admissionScope: lease?.scope || null,
        retryAfterMs: Number(deps.retryAfterMs || 1_000),
        limiterBackpressure: true,
        providerAttempted,
      };
    } else {
      executionError = error;
    }
  }

  const release = await releaseLeaseBounded(
    lease,
    Number(deps.releaseTimeoutMs || DEFAULT_RELEASE_TIMEOUT_MS),
  );
  if (!release.ok) {
    if (result?.ok === true && !executionError) {
      console.warn(`[llm/admission] shared limiter release uncertain: ${release.error}`);
      return {
        ...result,
        limiterReleaseWarning: true,
        limiterReleaseUncertain: true,
        releaseError: release.error,
        providerAttempted,
      };
    }
    return {
      ok: false,
      provider: 'failed',
      durationMs: Number(result?.durationMs || 0),
      error: release.error,
      retryAfterMs: Number(deps.retryAfterMs || 1_000),
      admissionScope: null,
      limiterBackpressure: true,
      providerAttempted,
    };
  }
  if (executionError) throw executionError;
  return result;
}

module.exports = { runWithProviderAdmission };
