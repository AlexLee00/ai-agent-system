#!/usr/bin/env tsx
'use strict';

/**
 * report-deprecation-matrix.ts — 84 리포트 → 5 digest 카테고리 매핑 매트릭스
 *
 * 목적:
 *   기존 분산된 리포트 launchd를 5 digest 카테고리로 통합하고
 *   단계별 deprecation 계획을 생성한다.
 *
 * 실행:
 *   npx tsx bots/hub/scripts/report-deprecation-matrix.ts
 *   npx tsx bots/hub/scripts/report-deprecation-matrix.ts --output=docs/hub/REPORT_DEPRECATION_MATRIX.md
 *   npx tsx bots/hub/scripts/report-deprecation-matrix.ts --week=1   # Week 1 deprecation 대상만
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

const ROOT = env.PROJECT_ROOT;

// ────── 5 digest 카테고리 정의 ──────

type DigestCategory = 'hourly-status' | 'daily-metrics' | 'weekly-audit' | 'weekly-advisory' | 'incident-summary';

interface DigestDef {
  category: DigestCategory;
  plist: string;
  script: string;
  schedule: string;
  description: string;
}

const DIGEST_CATEGORIES: DigestDef[] = [
  {
    category: 'hourly-status',
    plist: 'ai.hub.hourly-status-digest',
    script: 'bots/hub/scripts/hourly-status-digest.ts',
    schedule: '매시간 :00',
    description: '시스템 전체 상태 통합 (Hub/Luna/Blog/Claude/SKA 헬스)',
  },
  {
    category: 'daily-metrics',
    plist: 'ai.hub.daily-metrics-digest',
    script: 'bots/hub/scripts/daily-metrics-digest.ts',
    schedule: '매일 09:00',
    description: '일간 핵심 지표 (알람 건수, 분류 정확도, LLM 호출)',
  },
  {
    category: 'weekly-audit',
    plist: 'ai.hub.weekly-audit-digest',
    script: 'bots/hub/scripts/weekly-audit-digest.ts',
    schedule: '매주 월 10:00',
    description: '주간 감사 (suppression rule 변경, 회귀 분석)',
  },
  {
    category: 'weekly-advisory',
    plist: 'ai.hub.weekly-advisory-digest',
    script: 'bots/hub/scripts/weekly-advisory-digest.ts',
    schedule: '매주 월 11:00',
    description: '주간 권고 (마스터 보고, noisy producer, 개선 제안)',
  },
  {
    category: 'incident-summary',
    plist: 'ai.hub.incident-summary',
    script: 'bots/hub/scripts/incident-summary.ts',
    schedule: '매일 18:00',
    description: '일간 incident 요약 (roundtable 결과, 해소/미해소)',
  },
];

// ────── 레거시 리포트 카탈로그 ──────

interface LegacyReport {
  plist: string;
  team: string;
  type: string;
  replacedBy: DigestCategory;
  deprecationWeek: 1 | 2 | 3;
  reason: string;
}

const LEGACY_REPORTS: LegacyReport[] = [
  // Hub 운영 리포트 → hourly-status (Week 1 우선)
  { plist: 'ai.claude.health-check', team: 'claude', type: 'health', replacedBy: 'hourly-status', deprecationWeek: 1, reason: '매시간 상태 digest로 통합' },
  { plist: 'ai.claude.health-dashboard', team: 'claude', type: 'health', replacedBy: 'hourly-status', deprecationWeek: 1, reason: '매시간 상태 digest로 통합' },
  { plist: 'ai.hub.llm-model-check', team: 'hub', type: 'model', replacedBy: 'weekly-advisory', deprecationWeek: 2, reason: '주간 권고 digest에 포함' },
  { plist: 'ai.hub.llm-groq-fallback-test', team: 'hub', type: 'llm-test', replacedBy: 'daily-metrics', deprecationWeek: 2, reason: '일간 지표 digest에 포함' },
  { plist: 'ai.hub.llm-cache-cleanup', team: 'hub', type: 'maintenance', replacedBy: 'weekly-audit', deprecationWeek: 3, reason: '주간 감사 digest에 포함 (캐시 감사)' },
  { plist: 'ai.hub.llm-oauth-monitor', team: 'hub', type: 'auth', replacedBy: 'hourly-status', deprecationWeek: 1, reason: '매시간 상태 digest로 통합 (auth 체크 포함)' },

  // Claude 팀 리포트 → 카테고리별
  { plist: 'ai.claude.daily-report', team: 'claude', type: 'daily', replacedBy: 'daily-metrics', deprecationWeek: 1, reason: '일간 지표 digest로 통합' },
  { plist: 'ai.claude.weekly-report', team: 'claude', type: 'weekly', replacedBy: 'weekly-audit', deprecationWeek: 1, reason: '주간 감사 digest로 통합' },
  { plist: 'ai.claude.dexter.daily', team: 'claude', type: 'dexter', replacedBy: 'daily-metrics', deprecationWeek: 2, reason: '덱스터 체크 결과 → 일간 지표 digest' },
  { plist: 'ai.claude.speed-test', team: 'claude', type: 'performance', replacedBy: 'weekly-advisory', deprecationWeek: 3, reason: '속도 테스트 → 주간 권고 digest' },

  // Worker/Worker 모니터 → incident-summary
  { plist: 'ai.worker.claude-monitor', team: 'worker', type: 'monitor', replacedBy: 'incident-summary', deprecationWeek: 2, reason: '워커 모니터 → incident-summary 통합' },

  // Codex 노티파이어 → weekly-advisory
  { plist: 'ai.claude.codex-notifier', team: 'claude', type: 'codex', replacedBy: 'weekly-advisory', deprecationWeek: 2, reason: '코덱스 완료 알림 → 주간 권고 digest' },
];

// ────── 매트릭스 생성 ──────

function buildMatrix(): string {
  const today = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push('# 84 리포트 → 5 Digest 매핑 매트릭스');
  lines.push('');
  lines.push(`> 생성: ${today} KST`);
  lines.push(`> 목적: 분산된 레거시 리포트를 5 digest 카테고리로 통합하고 3주 grace period deprecation 진행`);
  lines.push('');

  // 5 Digest 카테고리 요약
  lines.push('## 5 Digest 카테고리');
  lines.push('');
  lines.push('| 카테고리 | launchd | 스케줄 | 설명 |');
  lines.push('|----------|---------|--------|------|');
  for (const d of DIGEST_CATEGORIES) {
    lines.push(`| ${d.category} | ${d.plist} | ${d.schedule} | ${d.description} |`);
  }
  lines.push('');

  // Week별 deprecation 계획
  for (const week of [1, 2, 3] as const) {
    const targets = LEGACY_REPORTS.filter((r) => r.deprecationWeek === week);
    lines.push(`## Week ${week} Deprecation 대상 (${targets.length}건)`);
    lines.push('');
    if (targets.length === 0) {
      lines.push('_(없음)_');
      lines.push('');
      continue;
    }
    lines.push('| launchd | 팀 | 유형 | 대체 digest | 사유 |');
    lines.push('|---------|-----|------|-------------|------|');
    for (const r of targets) {
      lines.push(`| ${r.plist} | ${r.team} | ${r.type} | ${r.replacedBy} | ${r.reason} |`);
    }
    lines.push('');
  }

  // 통계 요약
  const byCategory = DIGEST_CATEGORIES.map((d) => ({
    category: d.category,
    count: LEGACY_REPORTS.filter((r) => r.replacedBy === d.category).length,
  }));

  lines.push('## 통합 요약');
  lines.push('');
  lines.push(`- 레거시 리포트 카탈로그: ${LEGACY_REPORTS.length}건`);
  lines.push(`- Week 1 (즉시): ${LEGACY_REPORTS.filter((r) => r.deprecationWeek === 1).length}건`);
  lines.push(`- Week 2 (+7일): ${LEGACY_REPORTS.filter((r) => r.deprecationWeek === 2).length}건`);
  lines.push(`- Week 3 (+14일): ${LEGACY_REPORTS.filter((r) => r.deprecationWeek === 3).length}건`);
  lines.push('');
  lines.push('| Digest | 흡수 리포트 수 |');
  lines.push('|--------|--------------|');
  for (const b of byCategory) {
    lines.push(`| ${b.category} | ${b.count} |`);
  }
  lines.push('');

  // 운영 주의사항
  lines.push('## 운영 주의사항');
  lines.push('');
  lines.push('1. **audit log 보존**: 비활성화 시 StandardOutPath 로그 최소 30일 유지');
  lines.push('2. **마스터 주간 검토**: 매주 월요일 weekly-advisory-digest 보고 확인');
  lines.push('3. **회귀 감지**: 비활성화 후 7일간 누락 알람 없는지 모니터링');
  lines.push('4. **예외 유지**: 마스터 결정 시 일부 리포트 유지 가능 (주석 처리 권장)');
  lines.push('5. **launchctl unload**: `launchctl unload ~/Library/LaunchAgents/<plist>.plist`');
  lines.push('');

  return lines.join('\n');
}

// ────── 메인 ──────

function argValue(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg: string) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function weekFilter(): number | null {
  const w = argValue('week', '');
  const n = Number(w);
  return [1, 2, 3].includes(n) ? n : null;
}

async function main() {
  const matrix = buildMatrix();
  const weekNum = weekFilter();

  if (weekNum) {
    const targets = LEGACY_REPORTS.filter((r) => r.deprecationWeek === weekNum);
    console.log(`[deprecation-matrix] Week ${weekNum} 대상 ${targets.length}건:`);
    for (const r of targets) {
      console.log(`  launchctl unload ~/Library/LaunchAgents/${r.plist}.plist`);
    }
    return;
  }

  const outputPath = argValue('output', '');
  if (outputPath) {
    const absPath = path.isAbsolute(outputPath) ? outputPath : path.join(ROOT, outputPath);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, matrix, 'utf8');
    console.log(`[deprecation-matrix] 매트릭스 저장: ${outputPath}`);
  } else {
    console.log(matrix);
  }

  if (hasFlag('json')) {
    const json = {
      generated_at: new Date().toISOString(),
      digest_categories: DIGEST_CATEGORIES.map((d) => ({
        ...d,
        legacy_count: LEGACY_REPORTS.filter((r) => r.replacedBy === d.category).length,
      })),
      legacy_reports: LEGACY_REPORTS,
      summary: {
        total_legacy: LEGACY_REPORTS.length,
        week1: LEGACY_REPORTS.filter((r) => r.deprecationWeek === 1).length,
        week2: LEGACY_REPORTS.filter((r) => r.deprecationWeek === 2).length,
        week3: LEGACY_REPORTS.filter((r) => r.deprecationWeek === 3).length,
      },
    };
    console.log('\n--- JSON ---');
    console.log(JSON.stringify(json, null, 2));
  }
}

main().catch((err: Error) => {
  console.error('[report-deprecation-matrix] 오류:', err.message);
  process.exit(1);
});
