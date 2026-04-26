// @ts-nocheck
'use strict';

function reconcileMainIngressSessions() {
  return {
    ok: true,
    retired: true,
    changed: false,
    gatewayRestarted: false,
    restartError: null,
    reason: 'retired ingress compatibility stub; Hub-native Telegram/control ingress is authoritative',
  };
}

module.exports = {
  reconcileMainIngressSessions,
};
