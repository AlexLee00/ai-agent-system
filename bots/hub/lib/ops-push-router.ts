#!/usr/bin/env node
// @ts-nocheck

function textParts(event = {}) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  return [
    event.event_type,
    event.type,
    event.kind,
    event.tag,
    event.team,
    event.from,
    event.to,
    event.title,
    event.message,
    event.text,
    event.reason,
    payload.event_type,
    payload.title,
    payload.message,
    payload.reason,
    payload.symbol,
    payload.decision,
    payload.status,
    payload.verdict,
  ].filter(Boolean).join(' ').toLowerCase();
}

function eventTeam(event = {}) {
  return String(event.team || event.from || event.to || event.payload?.team || '').toLowerCase();
}

function notificationText(event = {}) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const title = String(event.title || payload.title || event.event_type || event.kind || 'OPS critical event').slice(0, 90);
  const body = String(event.message || event.text || payload.message || payload.reason || event.reason || 'Immediate operator attention required.').slice(0, 180);
  return { title, body };
}

export function classifyOpsPushEvent(event = {}) {
  const haystack = textParts(event);
  const team = eventTeam(event);
  const { title, body } = notificationText(event);
  const tag = String(event.event_type || event.kind || event.tag || event.type || 'ops-event').slice(0, 64);

  const bridgeTerminal = haystack.includes('bridge')
    && /(verified|failed|rejected|검증|실패|거절)/.test(haystack);
  if (bridgeTerminal) {
    return { level: 'critical', shouldPush: true, reason: 'bridge_terminal', title, body, tag };
  }

  const protectedDown = /(protected|launchd|service)/.test(haystack)
    && /(down|dead|failed|stopped|unloaded|종료|중단|실패)/.test(haystack);
  if (protectedDown) {
    return { level: 'critical', shouldPush: true, reason: 'protected_down', title, body, tag };
  }

  const allCircuitDead = /circuit/.test(haystack)
    && /(all dead|dead_all|provider_all_dead|전멸|전체.*실패)/.test(haystack);
  if (allCircuitDead) {
    return { level: 'critical', shouldPush: true, reason: 'circuit_all_dead', title, body, tag };
  }

  const lunaCritical = /(luna|investment|crypto|binance)/.test(`${team} ${haystack}`)
    && /(liquidat|liquidation|청산|loss limit|loss_limit|손실 한도|kill.?switch|guard)/.test(haystack);
  if (lunaCritical) {
    return { level: 'critical', shouldPush: true, reason: 'luna_guard_critical', title, body, tag };
  }

  const skaRevenueIncident = /(ska|reservation|booking)/.test(`${team} ${haystack}`)
    && /(revenue|payment|reservation|매출|결제|예약)/.test(haystack)
    && /(incident|failed|error|critical|장애|실패|오류)/.test(haystack);
  if (skaRevenueIncident) {
    return { level: 'critical', shouldPush: true, reason: 'ska_revenue_incident', title, body, tag };
  }

  if (/(publish|routing|digest|health|report|memory|transition)/.test(haystack)) {
    return { level: 'normal', shouldPush: false, reason: 'non_critical_ops_signal', title, body, tag };
  }

  return { level: 'info', shouldPush: false, reason: 'not_pushworthy', title, body, tag };
}

export function shouldSendOpsPush(event = {}) {
  return classifyOpsPushEvent(event).shouldPush === true;
}

export default {
  classifyOpsPushEvent,
  shouldSendOpsPush,
};
