#!/usr/bin/env node
// @ts-nocheck
/**
 * 매주 일요일 06:10 KST — 가드 자율 조정 주간 실행
 * launchd: ai.luna.guard-self-tuning-weekly-sun-0600.plist
 */

import { runWeeklySelfTuningAnalysis } from '../shared/guard-self-tuning.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initHubConfig } = require('../../../packages/core/lib/llm-keys.js');

const WRITE_ENABLED = process.env.LUNA_GUARD_SELF_TUNING_WRITE_ENABLED === 'true';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run') || !WRITE_ENABLED,
    json: argv.includes('--json'),
  };
}

async function sendTelegramNotification(message) {
  try {
    const hubUrl = process.env.HUB_URL || 'http://localhost:7788';
    const hubToken = process.env.HUB_AUTH_TOKEN;
    if (!hubToken) return;
    await fetch(`${hubUrl}/hub/notifications/telegram`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ message, source: 'guard-self-tuning-weekly' }),
    }).catch(() => null);
  } catch {}
}

async function main() {
  const options = parseArgs();
  if (maybeSkipForMemory('luna.guard-self-tuning', { json: options.json })) return;
  const date = new Date().toISOString().split('T')[0];
  const prefix = options.dryRun ? '[GuardSelfTuning][DRY-RUN]' : '[GuardSelfTuning]';
  console.log(`${prefix} ${date} 주간 자율 조정 분석 시작`);
  if (options.dryRun && !process.argv.includes('--dry-run')) {
    console.log(`${prefix} LUNA_GUARD_SELF_TUNING_WRITE_ENABLED=false — DB 기록/텔레그램 생략`);
  }

  try {
    await initHubConfig().catch(() => null);
  } catch {}

  const result = await runWeeklySelfTuningAnalysis(30, { dryRun: options.dryRun, write: !options.dryRun });

  console.log(`${prefix} 분석 완료: ${result.analyzedGuards}개 가드, ${result.needsActionCount}개 조정 필요`);

  const actionItems = result.results.filter(
    (r) => r.recommendation === 'relax' || r.recommendation === 'tighten',
  );

  let tgMsg = `🔧 *루나 가드 자율 조정 분석* (${date})\n`;
  tgMsg += `분석: ${result.analyzedGuards}개 | 조정 필요: ${result.needsActionCount}개\n`;
  if (actionItems.length > 0) {
    tgMsg += '\n조정 권장:\n';
    for (const item of actionItems.slice(0, 5)) {
      const arrow = item.recommendation === 'relax' ? '↓ 완화' : '↑ 강화';
      tgMsg += `  • \`${item.guardName}\` → ${arrow}\n`;
    }
    tgMsg += '\n마스터 승인 후 적용 (Shadow 1주 검증 완료 시)';
  } else {
    tgMsg += '\n✅ 모든 가드 임계값 적절 — 유지';
  }
  if (!options.dryRun) {
    await sendTelegramNotification(tgMsg);
  }
  if (options.json) {
    console.log(JSON.stringify({ ...result, telegramSent: !options.dryRun, writeEnabled: WRITE_ENABLED }, null, 2));
  }
}

main().catch((err) => {
  console.error('[GuardSelfTuning] 오류:', err?.message);
  process.exit(1);
});
