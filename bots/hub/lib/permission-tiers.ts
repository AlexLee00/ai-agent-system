'use strict';

// Permission Tiers — 4단계 권한 시스템
// 기존 tool-registry.ts의 L0-L3 + sideEffect를 공식 Tier로 매핑
//
// Tier 1 ALLOW    — read_only/none + L0/L1 → 자동 실행
// Tier 2 MODIFY   — write + L1/L2 → 검증 후 진행
// Tier 3 ESCALATE — external_mutation + L2/L3 → 마스터 알림 필요
// Tier 4 BLOCK    — PROTECTED launchd / LIVE 매매 → 자동 차단

import path from 'node:path';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const sender = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));

// ─── 상수 ────────────────────────────────────────────────────────────────────

export type TierName = 'ALLOW' | 'MODIFY' | 'ESCALATE' | 'BLOCK';

export interface TierDefinition {
  tier: 1 | 2 | 3 | 4;
  name: TierName;
  description: string;
}

export const TIERS: Record<TierName, TierDefinition> = {
  ALLOW:    { tier: 1, name: 'ALLOW',    description: '안전 도구 — 자동 실행' },
  MODIFY:   { tier: 2, name: 'MODIFY',   description: '조정 가능 도구 — 검증 후 진행' },
  ESCALATE: { tier: 3, name: 'ESCALATE', description: 'secrets/DB 파괴적 작업 — 마스터 승인 필요' },
  BLOCK:    { tier: 4, name: 'BLOCK',    description: 'PROTECTED launchd / LIVE 매매 — 자동 차단' },
};

// ─── BLOCK 패턴 (절대 차단) ───────────────────────────────────────────────────

const BLOCK_PATTERNS = [
  // PROTECTED launchd 서비스 중단
  /ai\.(ska|luna|investment|claude|elixir|hub)\./,
  // LIVE 매매 직접 호출
  /luna\.live\./,
  /investment\.live\./,
  /binance\.(market_order|place_order)/i,
  /kis\.(place_order|market_order)/i,
  // 메모리/DB wipe
  /db\.drop/i,
  /db\.truncate/i,
  /memory\.wipe/i,
  /secrets\.delete/i,
  /secrets\.wipe/i,
];

// ─── ESCALATE 패턴 ────────────────────────────────────────────────────────────

const ESCALATE_PATTERNS = [
  /secrets-store/i,
  /launchd\.(restart|unload|stop)/i,
  /db\.(migrate|alter|create_table)/i,
  /system\.(reboot|shutdown)/i,
  /repo\.command\.run/i,
];

// ─── Tier 결정 로직 ───────────────────────────────────────────────────────────

export function resolveTier(opts: {
  toolName: string;
  sideEffect?: string;  // none | read_only | write | external_mutation
  requiredTopicLevel?: string;  // L0 | L1 | L2 | L3
  executeEnabled?: boolean;
}): TierDefinition {
  const { toolName, sideEffect, requiredTopicLevel, executeEnabled } = opts;
  const tool = toolName || '';

  // BLOCK: 패턴 매치 또는 executeEnabled=false + external_mutation
  const isBlockPattern = BLOCK_PATTERNS.some((r) => r.test(tool));
  const isDisabledMutation = executeEnabled === false && sideEffect === 'external_mutation';
  if (isBlockPattern || isDisabledMutation) {
    return TIERS.BLOCK;
  }

  // ESCALATE: 패턴 매치 또는 external_mutation + L3
  const isEscalatePattern = ESCALATE_PATTERNS.some((r) => r.test(tool));
  const isHighRiskMutation = sideEffect === 'external_mutation' || requiredTopicLevel === 'L3';
  if (isEscalatePattern || isHighRiskMutation) {
    return TIERS.ESCALATE;
  }

  // MODIFY: write 또는 L2
  if (sideEffect === 'write' || requiredTopicLevel === 'L2') {
    return TIERS.MODIFY;
  }

  // ALLOW: 나머지 (read_only, none, L0, L1)
  return TIERS.ALLOW;
}

// ─── 권한 검사 + 감사 로그 ────────────────────────────────────────────────────

export interface PermissionCheckResult {
  ok: boolean;
  tier: TierDefinition;
  decision: 'allowed' | 'blocked' | 'escalated';
  reason?: string;
}

export async function checkPermission(opts: {
  toolName: string;
  sideEffect?: string;
  requiredTopicLevel?: string;
  executeEnabled?: boolean;
  agent?: string;
  callerTeam?: string;
  traceId?: string;
  auditEnabled?: boolean;  // 기본 true
}): Promise<PermissionCheckResult> {
  const tier = resolveTier(opts);
  const auditEnabled = opts.auditEnabled !== false;

  let decision: PermissionCheckResult['decision'];
  let reason: string | undefined;
  let ok: boolean;

  if (tier.tier === 4) {
    decision = 'blocked';
    reason = `Tier 4 BLOCK: ${opts.toolName} 호출 차단`;
    ok = false;
  } else if (tier.tier === 3) {
    decision = 'escalated';
    reason = `Tier 3 ESCALATE: 마스터 승인 필요 — ${opts.toolName}`;
    ok = false;
    // 마스터에게 알림 (비동기)
    _notifyEscalation(opts.toolName, opts.agent, opts.callerTeam, opts.traceId).catch(() => {});
  } else {
    decision = 'allowed';
    ok = true;
  }

  if (auditEnabled) {
    _logAudit({
      toolName: opts.toolName,
      agent: opts.agent,
      callerTeam: opts.callerTeam,
      tier: tier.tier,
      tierName: tier.name,
      decision,
      sideEffect: opts.sideEffect,
      riskLevel: tier.tier >= 3 ? 'high' : tier.tier === 2 ? 'medium' : 'low',
      reason,
      traceId: opts.traceId,
    }).catch(() => {});
  }

  return { ok, tier, decision, reason };
}

// ─── 감사 로그 기록 ───────────────────────────────────────────────────────────

async function _logAudit(opts: {
  toolName: string;
  agent?: string;
  callerTeam?: string;
  tier: number;
  tierName: string;
  decision: string;
  sideEffect?: string;
  riskLevel?: string;
  reason?: string;
  traceId?: string;
}): Promise<void> {
  try {
    await pgPool.query('public', `
      INSERT INTO hub.permission_audit_log
        (tool_name, agent, caller_team, tier, tier_name, decision,
         side_effect, risk_level, reason, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      opts.toolName,
      opts.agent || null,
      opts.callerTeam || null,
      opts.tier,
      opts.tierName,
      opts.decision,
      opts.sideEffect || null,
      opts.riskLevel || null,
      opts.reason || null,
      opts.traceId || null,
    ]);
  } catch {
    // 무시
  }
}

// ─── 마스터 에스컬레이션 알림 ─────────────────────────────────────────────────

async function _notifyEscalation(
  toolName: string,
  agent?: string,
  callerTeam?: string,
  traceId?: string,
): Promise<void> {
  const msg = [
    `⚠️ [Permission Tier 3] 마스터 승인 필요`,
    `도구: ${toolName}`,
    agent ? `에이전트: ${agent}` : null,
    callerTeam ? `팀: ${callerTeam}` : null,
    traceId ? `traceId: ${traceId}` : null,
  ].filter(Boolean).join('\n');

  await sender.send('general', msg).catch(() => {});
}

// ─── 통계 조회 ────────────────────────────────────────────────────────────────

export async function getPermissionStats(hours = 24): Promise<Record<string, unknown>> {
  try {
    const rows = await pgPool.query('public', `
      SELECT
        tier,
        tier_name,
        decision,
        COUNT(*) AS total
      FROM hub.permission_audit_log
      WHERE created_at > NOW() - ($1 || ' hours')::INTERVAL
      GROUP BY tier, tier_name, decision
      ORDER BY tier, decision
    `, [String(hours)]);

    return {
      checkedAt: new Date().toISOString(),
      hours,
      rows,
    };
  } catch (e: any) {
    return { error: e?.message };
  }
}

module.exports = {
  TIERS,
  resolveTier,
  checkPermission,
  getPermissionStats,
};
