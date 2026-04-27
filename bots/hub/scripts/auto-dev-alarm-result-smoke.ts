#!/usr/bin/env tsx
'use strict';

const {
  _testOnly_extractAlarmIncidentContext,
  _testOnly_formatAlarmRepairResultMessage,
} = require('../../claude/lib/auto-dev-pipeline.ts');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_luna_abc123.md';
  const content = [
    '---',
    'target_team: claude',
    'source_team: luna',
    'source_bot: luna',
    'incident_key: luna|llm_provider_cooldown|abc123',
    'alarm_event_type: llm_error',
    'risk_tier: high',
    'task_type: development_task',
    'write_scope:',
    '  - bots/investment',
    'test_scope:',
    '  - npm --prefix bots/investment run check',
    '---',
    '',
    '# Alarm Incident Auto-Repair: LLM provider cooldown',
    '',
    '## Incident',
    '- team: luna',
    '- event_type: llm_error',
  ].join('\n');
  const job = {
    relPath,
    analysis: {
      relPath,
      title: 'LLM provider cooldown',
      metadata: {},
    },
  };

  const context = _testOnly_extractAlarmIncidentContext(job, content);
  assert(context?.incidentKey === 'luna|llm_provider_cooldown|abc123', 'expected incident key extraction');
  assert(context?.team === 'luna', `expected source team luna, got ${context?.team}`);
  assert(context?.eventType === 'llm_error', `expected event type llm_error, got ${context?.eventType}`);

  const message = _testOnly_formatAlarmRepairResultMessage(
    context,
    'resolved',
    'auto_dev 구현 완료',
    ['bots/investment/team/luna.ts'],
  );
  assert(message.includes('오류 처리 결과'), 'expected result template title');
  assert(message.includes('luna|llm_provider_cooldown|abc123'), 'expected incident key in result message');
  assert(message.includes('bots/investment/team/luna.ts'), 'expected changed file list in result message');

  console.log('auto_dev_alarm_result_smoke_ok');
}

main();
