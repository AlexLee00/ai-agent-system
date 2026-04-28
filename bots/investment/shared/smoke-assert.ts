// @ts-nocheck

export function assertSmokePass(summary = {}, errorPrefix = '[smoke]') {
  if (summary?.pass === true) return;
  const passed = Number(summary?.passed || 0);
  const total = Number(summary?.total || 0);
  throw new Error(`${errorPrefix} failed (${passed}/${total})`);
}

export default {
  assertSmokePass,
};
