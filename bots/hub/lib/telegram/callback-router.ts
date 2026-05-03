function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function resolveHubCallbackTarget(callbackData) {
  const normalized = normalizeText(callbackData);
  if (!normalized) return null;
  if (normalized.startsWith('hub_control:')) {
    return { route: '/hub/control/callback', mode: 'hub_control' };
  }
  if (normalized.startsWith('darwin_')) {
    return { route: '/hub/darwin/callback', mode: 'darwin_compat' };
  }
  if (normalized.startsWith('luna_live_fire:')) {
    return { route: '/hub/luna/live-fire/callback', mode: 'luna_live_fire' };
  }
  return null;
}

module.exports = {
  resolveHubCallbackTarget,
};
