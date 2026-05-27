// @ts-nocheck
'use strict';

// Week 4 Day 25-26: Permission Tier Promotion 평가 스크립트
// 21일 Shadow 누적 + 위반 패턴 분석 + Promotion 적합성 평가
//
// 실행:
//   tsx bots/hub/scripts/permission-tier-promotion-evaluation.ts
//   tsx bots/hub/scripts/permission-tier-promotion-evaluation.ts --json

import path from 'node:path';
import fs from 'node:fs';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface PermissionPromotionResult {
  ok: boolean;
  ts: string;
  promotionEligible: boolean;
  shadowDays: number;
  stats: {
    total: number;
    allowed: number;
    blocked: number;
    escalated: number;
    blockRate: number;
    escalateRate: number;
    byTier: Record<string, number>;
    topTools: Array<{ tool: string; count: number; blocked: number }>;
  };
  checks: Array<{ name: string; passed: boolean; value: string }>;
  blockers: string[];
  nextStep: string;
}

async function queryWithFallback(pgPool: any, sql: string, params: any[] = []): Promise<any[]> {
  try {
    const rows = await pgPool.query('public', sql, params);
    return Array.isArray(rows) ? rows : (rows?.rows ?? []);
  } catch (_) {
    return [];
  }
}

export async function runPermissionTierPromotionEvaluation(): Promise<PermissionPromotionResult> {
  const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

  const twentyOneDaysAgo = new Date(Date.now() - 21 * 86400_000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [shadowDaysRows, totalRows, decisionRows, tierRows, toolRows] = await Promise.allSettled([
    queryWithFallback(pgPool, `
      SELECT ceil(extract(epoch from (now() - min(created_at))) / 86400) AS days
      FROM hub.permission_audit_log
    `),
    queryWithFallback(pgPool, `SELECT count(*) AS cnt FROM hub.permission_audit_log`),
    queryWithFallback(pgPool, `
      SELECT decision, count(*) AS cnt
      FROM hub.permission_audit_log
      WHERE created_at > $1
      GROUP BY decision
    `, [sevenDaysAgo]),
    queryWithFallback(pgPool, `
      SELECT tier, tier_name, count(*) AS cnt
      FROM hub.permission_audit_log
      WHERE created_at > $1
      GROUP BY tier, tier_name
      ORDER BY tier
    `, [sevenDaysAgo]),
    queryWithFallback(pgPool, `
      SELECT
        tool_name,
        count(*) AS total,
        count(*) FILTER (WHERE decision IN ('blocked', 'escalated')) AS problematic
      FROM hub.permission_audit_log
      WHERE created_at > $1
      GROUP BY tool_name
      ORDER BY total DESC
      LIMIT 10
    `, [sevenDaysAgo]),
  ]);

  const getFirst = (settled: PromiseSettledResult<any[]>, field: string, def: any = 0) =>
    (settled.status === 'fulfilled' ? settled.value : [])[0]?.[field] ?? def;

  const shadowDays = parseInt(String(getFirst(shadowDaysRows, 'days', 0)), 10);
  const total = parseInt(String(getFirst(totalRows, 'cnt', 0)), 10);

  let allowed = 0, blocked = 0, escalated = 0;
  if (decisionRows.status === 'fulfilled') {
    for (const r of decisionRows.value || []) {
      const cnt = parseInt(r.cnt || '0', 10);
      if (r.decision === 'allowed') allowed += cnt;
      if (r.decision === 'blocked') blocked += cnt;
      if (r.decision === 'escalated') escalated += cnt;
    }
  }
  const recent7dTotal = allowed + blocked + escalated || 1;
  const blockRate = blocked / recent7dTotal;
  const escalateRate = escalated / recent7dTotal;

  const byTier: Record<string, number> = {};
  if (tierRows.status === 'fulfilled') {
    for (const r of tierRows.value || []) {
      byTier[`Tier${r.tier}(${r.tier_name})`] = parseInt(r.cnt || '0', 10);
    }
  }

  const topTools: Array<{ tool: string; count: number; blocked: number }> = [];
  if (toolRows.status === 'fulfilled') {
    for (const r of toolRows.value || []) {
      topTools.push({ tool: r.tool_name, count: parseInt(r.total || '0', 10), blocked: parseInt(r.problematic || '0', 10) });
    }
  }

  const checks = [
    { name: 'Shadow 관찰 기간 (21일+)', passed: shadowDays >= 21, value: `${shadowDays}일` },
    { name: '총 감사 건수 (100건+)', passed: total >= 100, value: `${total}건` },
    { name: '차단율 10% 미만 (안정성)', passed: blockRate < 0.1, value: `${(blockRate * 100).toFixed(1)}%` },
    { name: 'Escalate율 5% 미만 (안정성)', passed: escalateRate < 0.05, value: `${(escalateRate * 100).toFixed(1)}%` },
  ];

  const blockers = checks.filter((c) => !c.passed).map((c) => c.name);
  const promotionEligible = blockers.length === 0;

  let nextStep: string;
  if (!promotionEligible) {
    nextStep = `❌ Promotion 불가 — 미충족: ${blockers.join(', ')}`;
  } else {
    nextStep = [
      '✅ Permission Tier Promotion 준비 완료! 마스터 Action:',
      '  launchctl setenv PERMISSION_TIER_ENFORCE active',
      '  launchctl kickstart -k gui/$(id -u)/ai.hub.resource-api',
    ].join('\n');
  }

  return {
    ok: true,
    ts: new Date().toISOString(),
    promotionEligible,
    shadowDays,
    stats: { total, allowed, blocked, escalated, blockRate, escalateRate, byTier, topTools },
    checks,
    blockers,
    nextStep,
  };
}

async function main() {
  console.log('[permission-tier-promotion-evaluation] Permission Tier Promotion 평가 시작...');
  const result = await runPermissionTierPromotionEvaluation();

  const lines = [
    `Shadow 기간: ${result.shadowDays}일`,
    `총 감사: ${result.stats.total}건`,
    `허용: ${result.stats.allowed} / 차단: ${result.stats.blocked} / 에스컬레이션: ${result.stats.escalated}`,
    `차단율: ${(result.stats.blockRate * 100).toFixed(1)}%`,
    `Escalate율: ${(result.stats.escalateRate * 100).toFixed(1)}%`,
    `Tier 분포: ${JSON.stringify(result.stats.byTier)}`,
    '',
    '체크 목록:',
    ...result.checks.map((c) => `  ${c.passed ? '✅' : '❌'} ${c.name}: ${c.value}`),
    '',
    result.nextStep,
  ];
  console.log(lines.join('\n'));

  const outPath = '/tmp/permission-tier-promotion.md';
  fs.writeFileSync(outPath, `# Permission Tier Promotion 평가\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`, 'utf8');

  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[permission-tier-promotion-evaluation] 오류:', err?.message || err);
    process.exit(1);
  });
}
