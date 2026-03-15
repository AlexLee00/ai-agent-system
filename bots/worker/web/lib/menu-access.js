'use client';

function normalizeMenuKey(key = '') {
  return String(key || '').replace(/^\//, '').split('/')[0];
}

function isMenuEnabled(user, key) {
  const normalized = normalizeMenuKey(key);
  if (user?.role === 'master') return true;
  if (!Array.isArray(user?.enabled_menus) || user.enabled_menus.length === 0) return true;
  return user.enabled_menus.includes(normalized);
}

function hasPolicy(user, key) {
  const normalized = normalizeMenuKey(key);
  const policy = user?.menu_policy?.[normalized];
  return Boolean(policy && Array.isArray(policy.operations) && policy.operations.length > 0);
}

export function canAccessMenu(user, key) {
  if (!user) return false;
  return isMenuEnabled(user, key) && hasPolicy(user, key);
}

export function getMenuPolicy(user, key) {
  if (!user) return null;
  const normalized = normalizeMenuKey(key);
  return user?.menu_policy?.[normalized] || null;
}

export function canPerformMenuOperation(user, key, operation) {
  const policy = getMenuPolicy(user, key);
  return Boolean(policy && Array.isArray(policy.operations) && policy.operations.includes(operation));
}

export function listVisibleMenus(user, items = []) {
  return items.filter((item) => canAccessMenu(user, item.href || item.key));
}
