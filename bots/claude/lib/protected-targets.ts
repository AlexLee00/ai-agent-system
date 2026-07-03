// @ts-nocheck
'use strict';

const PROTECTED_TARGET_FRAGMENTS = [
  'bots/investment/markets/',
  'bots/investment/launchd/ai.luna',
  'bots/investment/scripts/runtime-luna-live',
  'bots/investment/scripts/runtime-luna-approved-signal-executor',
  'bots/investment/scripts/crypto-holding-monitor',
  'bots/investment/shared/binance',
  'bots/investment/shared/kis',
  'bots/hub/secrets',
  'secrets-store.json',
  '/.git/',
];

function isProtectedTargetPath(relativePath = '') {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`;
  return PROTECTED_TARGET_FRAGMENTS.some((fragment) => normalized.includes(fragment) || withSlash.includes(fragment));
}

module.exports = {
  PROTECTED_TARGET_FRAGMENTS,
  isProtectedTargetPath,
};
