'use strict';

const { execSync } = require('child_process');

const {
  normalizeOpenClawMainIngressSessions,
} = require('../openclaw-config');

function reconcileMainIngressSessions({ restartGateway = true } = {}) {
  const result = normalizeOpenClawMainIngressSessions();
  if (!result.ok) return result;

  let gatewayRestarted = false;
  let restartError = null;

  if (result.changed && restartGateway) {
    try {
      execSync(`launchctl kickstart -k gui/${process.getuid()}/ai.openclaw.gateway`, {
        timeout: 15000,
        encoding: 'utf8',
      });
      gatewayRestarted = true;
    } catch (error) {
      restartError = error.message;
      console.warn(`[steward/openclaw] gateway restart 실패: ${error.message}`);
    }
  }

  return {
    ...result,
    gatewayRestarted,
    restartError,
  };
}

module.exports = {
  reconcileMainIngressSessions,
};
