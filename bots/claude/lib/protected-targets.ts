'use strict';

const PROTECTED_TARGET_FRAGMENTS = [
  'bots/investment/markets/',
  'bots/investment/launchd/',
  'bots/investment/launchd/ai.luna',
  'bots/investment/scripts/runtime-luna-live',
  'bots/investment/scripts/runtime-luna-approved-signal-executor',
  'bots/investment/scripts/crypto-holding-monitor',
  'bots/investment/shared/binance',
  'bots/investment/shared/kis',
  'bots/hub/secrets',
  'bots/claude/src/guardian',
  'bots/claude/lib/checks/security',
  'launchd/',
  '/secrets/',
  '.env',
  'auth/',
  'oauth',
  'credential',
  'secrets-store.json',
  '/.git/',
];

const PROTECTED_TARGET_CATEGORIES = [
  {
    category: 'money_movement',
    fragments: [
      'bots/investment/markets/',
      'bots/investment/scripts/runtime-luna-live',
      'bots/investment/scripts/runtime-luna-approved-signal-executor',
      'bots/investment/scripts/crypto-holding-monitor',
      'bots/investment/shared/binance',
      'bots/investment/shared/kis',
    ],
  },
  {
    category: 'launchd',
    fragments: ['launchd/', '.plist'],
  },
  {
    category: 'secrets_auth',
    fragments: ['bots/hub/secrets', '/secrets/', 'secrets-store.json', '.env', 'auth/', 'oauth', 'credential'],
  },
  {
    category: 'security_guardian',
    fragments: ['bots/claude/src/guardian', 'bots/claude/lib/checks/security'],
  },
];

function normalizeTargetPath(relativePath = '') {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isProtectedTargetPath(relativePath = '') {
  const normalized = normalizeTargetPath(relativePath);
  const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`;
  return PROTECTED_TARGET_FRAGMENTS.some((fragment) => normalized.includes(fragment) || withSlash.includes(fragment));
}

function protectedTargetMatches(paths = []) {
  const list = Array.isArray(paths) ? paths : [paths];
  const matches = [];
  for (const rawPath of list) {
    const file = normalizeTargetPath(rawPath);
    if (!file) continue;
    for (const group of PROTECTED_TARGET_CATEGORIES) {
      const hit = group.fragments.find((fragment) => {
        const normalizedFragment = normalizeTargetPath(fragment);
        return file.includes(normalizedFragment)
          || `${file}/`.includes(normalizedFragment.endsWith('/') ? normalizedFragment : `${normalizedFragment}/`);
      });
      if (hit) {
        matches.push({ file, category: group.category, fragment: hit });
        break;
      }
    }
  }
  return matches;
}

module.exports = {
  PROTECTED_TARGET_FRAGMENTS,
  PROTECTED_TARGET_CATEGORIES,
  normalizeTargetPath,
  isProtectedTargetPath,
  protectedTargetMatches,
};
