#!/usr/bin/env tsx
'use strict';

const {
  validateAlarmEnvelope,
} = require('../../../packages/core/lib/alarm-producer-contract.ts');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => unknown, pattern: RegExp, message: string): void {
  try {
    fn();
  } catch (error: any) {
    assert(pattern.test(String(error?.message || error)), `${message}: ${error?.message || error}`);
    return;
  }
  throw new Error(message);
}

function main(): void {
  const valid = validateAlarmEnvelope({
    team: 'luna',
    bot_name: 'contract-smoke',
    severity: 'error',
    title: 'Provider cooldown',
    message: 'LLM provider cooldown detected',
    alarm_type: 'error',
    visibility: 'internal',
    actionability: 'auto_repair',
    event_type: 'llm_provider_cooldown',
    incident_key: 'luna:contract-smoke:llm_provider_cooldown:abc123',
  });

  assert(valid.alarm_type === 'error', 'expected alarm_type to survive validation');
  assert(valid.visibility === 'internal', 'expected visibility to survive validation');
  assert(valid.event_type === 'llm_provider_cooldown', 'expected event_type to survive validation');
  assert(valid.incident_key.includes('llm_provider_cooldown'), 'expected incident_key to survive validation');

  assertThrows(
    () => validateAlarmEnvelope({
      team: 'luna',
      bot_name: 'contract-smoke',
      severity: 'error',
      title: 'Missing alarm type',
      message: 'missing alarm type',
      visibility: 'internal',
      event_type: 'missing_alarm_type',
      incident_key: 'luna:contract-smoke:missing_alarm_type',
    }),
    /alarm_type is required/,
    'expected missing alarm_type to fail',
  );

  assertThrows(
    () => validateAlarmEnvelope({
      team: 'luna',
      bot_name: 'contract-smoke',
      severity: 'error',
      title: 'Missing incident key',
      message: 'missing incident key',
      alarm_type: 'error',
      visibility: 'internal',
      event_type: 'missing_incident_key',
    }),
    /incident_key is required/,
    'expected missing incident_key to fail',
  );

  console.log(JSON.stringify({ ok: true, contract: 'explicit_alarm_producer_envelope' }));
}

main();
