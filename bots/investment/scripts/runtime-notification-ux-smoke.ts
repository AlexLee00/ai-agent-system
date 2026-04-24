#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  enrichAutonomousActionAlertPayload,
  inferAutonomousActionEventTypeFromMessage,
  normalizeAutonomousActionEventType,
  resolveAutonomousActionAlertEventType,
} from '../shared/autonomous-action-event.ts';

function runEventTypeNormalizationSmoke() {
  assert.equal(
    normalizeAutonomousActionEventType('autonomous_action_retrying', null),
    'autonomous_action_retrying',
  );
  assert.equal(
    inferAutonomousActionEventTypeFromMessage('action status: autonomous_action_failed'),
    'autonomous_action_failed',
  );

  const enrichedByPayload = enrichAutonomousActionAlertPayload({
    autonomousActionStatus: 'autonomous_action_queued',
    provider: 'KIS',
  }, 'sample');
  assert.equal(enrichedByPayload?.event_type, 'autonomous_action_queued');
  assert.equal(resolveAutonomousActionAlertEventType(enrichedByPayload, 'health_check'), 'autonomous_action_queued');

  const enrichedByMessage = enrichAutonomousActionAlertPayload({
    provider: 'Binance',
  }, '⚠️ action status: autonomous_action_blocked_by_safety');
  assert.equal(enrichedByMessage?.event_type, 'autonomous_action_blocked_by_safety');
  assert.equal(resolveAutonomousActionAlertEventType(enrichedByMessage, 'health_check'), 'autonomous_action_blocked_by_safety');
  assert.equal(resolveAutonomousActionAlertEventType({ event_type: 'health_check' }, 'health_check'), 'health_check');
}

function runUserFacingPhraseGuardSmoke() {
  const files = [
    '/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-check.ts',
    '/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.ts',
    '/Users/alexlee/projects/ai-agent-system/bots/investment/shared/report.ts',
  ];
  const riskKeywordRegex = /(손절|청산|킬스위치|kill[\s-]?switch|stop[_\s-]?loss|strategy[-_\s]?exit|partial[-_\s]?adjust)/ig;
  const bannedDirectiveRegex = /(실행\s*해\s*주세요|실행해\s*주세?요|실행해주세요|해\s*주십시오|please\s+run)/i;
  const violations = [];

  for (const file of files) {
    const text = String(fs.readFileSync(file, 'utf8') || '');
    const matches = [...text.matchAll(riskKeywordRegex)];
    for (const match of matches) {
      const index = Number(match.index || 0);
      const windowText = text.slice(Math.max(0, index - 140), Math.min(text.length, index + 220));
      if (!bannedDirectiveRegex.test(windowText)) continue;
      violations.push({
        file,
        keyword: match[0],
        excerpt: windowText.replace(/\s+/g, ' ').slice(0, 180),
      });
      if (violations.length >= 8) break;
    }
  }

  assert.equal(violations.length, 0, `금지 문구 감지: ${JSON.stringify(violations, null, 2)}`);
}

export function runNotificationUxSmoke() {
  runEventTypeNormalizationSmoke();
  runUserFacingPhraseGuardSmoke();
  return {
    ok: true,
    eventTypeNormalization: true,
    phraseGuard: true,
  };
}

async function main() {
  const result = runNotificationUxSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime notification ux smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime notification ux smoke 실패:',
  });
}
