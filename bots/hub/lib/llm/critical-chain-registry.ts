'use strict';

// Critical Chain Registry — luna/exit_decision 같은 치명적 경로 판별

const { selectRuntimeProfile, PROFILES } = require('../runtime-profiles');

function isCriticalChain(team, agent) {
  const profile = selectRuntimeProfile(team, agent);
  return profile && profile.critical === true;
}

function getTimeoutForChain(team, agent) {
  const profile = selectRuntimeProfile(team, agent);
  return (profile && profile.timeout_ms) || 30_000;
}

function listCriticalChains() {
  const result = [];
  for (const [team, agents] of Object.entries(PROFILES || {})) {
    for (const [agent, profile] of Object.entries(agents || {})) {
      if (profile && profile.critical === true) {
        result.push({ team, agent, timeout_ms: profile.timeout_ms || 30_000 });
      }
    }
  }
  return result;
}

module.exports = { isCriticalChain, getTimeoutForChain, listCriticalChains };
