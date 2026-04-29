// @ts-nocheck

const DEFAULT_SUCCESS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_RETRY_MS = 15 * 1000;

export function createHephaestosRuntimeBootstrap({
  initHubSecrets,
  now = () => Date.now(),
  successTtlMs = DEFAULT_SUCCESS_TTL_MS,
  failureRetryMs = DEFAULT_FAILURE_RETRY_MS,
} = {}) {
  let inFlight = null;
  let lastOkAt = 0;
  let lastFailedAt = 0;
  let calls = 0;

  async function ensureHubSecrets({ force = false } = {}) {
    const currentTime = now();
    if (!force && lastOkAt > 0 && (currentTime - lastOkAt) < successTtlMs) {
      return true;
    }
    if (!force && lastFailedAt > 0 && (currentTime - lastFailedAt) < failureRetryMs) {
      return false;
    }
    if (inFlight) return inFlight;

    calls += 1;
    inFlight = Promise.resolve()
      .then(() => initHubSecrets())
      .then((ok) => {
        if (ok) {
          lastOkAt = now();
          lastFailedAt = 0;
          return true;
        }
        lastFailedAt = now();
        return false;
      })
      .catch(() => {
        lastFailedAt = now();
        return false;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function getState() {
    return {
      initialized: lastOkAt > 0,
      lastOkAt,
      lastFailedAt,
      inFlight: Boolean(inFlight),
      calls,
      successTtlMs,
      failureRetryMs,
    };
  }

  return {
    ensureHubSecrets,
    getState,
  };
}
