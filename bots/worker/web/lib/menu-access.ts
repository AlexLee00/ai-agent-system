// @ts-nocheck
'use client';

export function resolveMenuKey(key = '') {
  const path = String(key || '').replace(/^\//, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  if (segments[0] === 'work-journals') return 'journals';
  if (segments[0] === 'video') return 'video';
  if (segments[0] !== 'admin') return segments[0];

  if (segments[1] === 'intents') return 'intents';
  if (segments[1] === 'companies') return 'companies';
  if (segments[1] === 'users') return 'users';
  if (segments[1] === 'ocr-test') return 'ocrtest';
  if (segments[1] === 'monitoring') return 'monitoring';
  if (segments[1] === 'agent-office') return 'agentoffice';
  if (segments[1] === 'workforce') return 'employees';
  return 'admin';
}

function normalizeMenuKey(key = '') {
  return resolveMenuKey(key);
}

function isMenuEnabled(user, key) {
  const normalized = normalizeMenuKey(key);
  if (user?.role === 'master') return true;
  if (!Array.isArray(user?.enabled_menus) || user.enabled_menus.length === 0) return true;
  if (normalized === 'video' && user.enabled_menus.includes('projects')) return true;
  return user.enabled_menus.includes(normalized);
}

function hasPolicy(user, key) {
  const normalized = normalizeMenuKey(key);
  const policy = user?.menu_policy?.[normalized]
    || (normalized === 'video' ? user?.menu_policy?.projects : null);
  return Boolean(policy && Array.isArray(policy.operations) && policy.operations.length > 0);
}

export function canAccessMenu(user, key) {
  if (!user) return false;
  return isMenuEnabled(user, key) && hasPolicy(user, key);
}

export function getMenuPolicy(user, key) {
  if (!user) return null;
  const normalized = normalizeMenuKey(key);
  return user?.menu_policy?.[normalized]
    || (normalized === 'video' ? user?.menu_policy?.projects : null)
    || null;
}

export function canPerformMenuOperation(user, key, operation) {
  const policy = getMenuPolicy(user, key);
  return Boolean(policy && Array.isArray(policy.operations) && policy.operations.includes(operation));
}

export function listVisibleMenus(user, items = []) {
  return items.filter((item) => canAccessMenu(user, item.href || item.key));
}
