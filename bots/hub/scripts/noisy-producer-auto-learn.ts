#!/usr/bin/env tsx
'use strict';

/**
 * noisy-producer-auto-learn.ts — Noisy Producer 자동 학습 루프
 *
 * 매주 월요일 09:00 실행 (launchd ai.hub.noisy-producer-auto-learn)
 *
 * 플로우:
 *   1. 지난 7일 noisy producer 조회 (fingerprint별 발생 횟수)
 *   2. 100건+/24h 자동 suppression 후보 생성
 *   3. suppression 제안 분류 (auto / needs_approval / needs_human)
 *   4. meeting 토픽 발송 (Top 10 + 제안 첨부)
 *   5. HUB_NOISY_AUTO_SUPPRESS=true 시 자동 적용 (default: false, 마스터 승인 필요)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const TIMEOUT_MS = 12_000;
const LEARNING_WINDOW_DAYS = 7;
const NOISY_THRESHOLD_PER_DAY = Math.max(
  10,
  Number(process.env.HUB_NOISY_THRESHOLD_PER_DAY || 100) || 100,
);
const AUTO_SUPPRESS = ['1', 'true', 'yes', 'y', 'on'].includes(
  String(process.env.HUB_NOISY_AUTO_SUPPRESS || '').trim().toLowerCase(),
);

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DRY_RUN = hasFlag('dry-run') || ['1', 'true', 'yes', 'y', 'on'].includes(
  String(process.env.HUB_NOISY_AUTO_LEARN_DRY_RUN || '').trim().toLowerCase(),
);
const JSON_OUTPUT = hasFlag('json');
const FIXTURE_MODE = hasFlag('fixture') || ['1', 'true', 'yes', 'y', 'on'].includes(
  String(process.env.HUB_NOISY_AUTO_LEARN_FIXTURE || '').trim().toLowerCase(),
);

function isEnabled(): boolean {
  const raw = String(process.env.HUB_NOISY_AUTO_LEARN_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

// ────── Hub API 호출 ──────

interface NoisyProducerRow {
  team: string;
  producer: string;
  alarm_type: string;
  cluster_key: string | null;
  total: number;
  escalated: number;
  per_day_avg: number;
}

async function fetchNoisyProducers(): Promise<NoisyProducerRow[]> {
  if (FIXTURE_MODE) {
    return [
      {
        team: 'luna',
        producer: 'runtime-autopilot',
        alarm_type: 'report',
        cluster_key: 'luna|report|runtime-autopilot',
        total: 910,
        escalated: 0,
        per_day_avg: 130,
      },
      {
        team: 'hub',
        producer: 'oauth-monitor',
        alarm_type: 'error',
        cluster_key: 'hub|error|oauth-monitor',
        total: 735,
        escalated: 2,
        per_day_avg: 105,
      },
    ];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const minutes = LEARNING_WINDOW_DAYS * 24 * 60;
    const url = `${HUB_BASE}/hub/alarm/noisy-producers?minutes=${minutes}&limit=50`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.warn(`[noisy-auto-learn] noisy-producers API HTTP ${resp.status} — 빈 목록 반환`);
      return [];
    }
    const data = await resp.json().catch(() => ({ rows: [] }));
    const rows: NoisyProducerRow[] = (data?.rows || data?.producers || []).map((r: Record<string, unknown>) => ({
      team: String(r.team || 'unknown'),
      producer: String(r.producer || r.from_bot || 'unknown'),
      alarm_type: String(r.alarm_type || 'unknown'),
      cluster_key: r.cluster_key ? String(r.cluster_key) : null,
      total: Number(r.total || r.count || 0),
      escalated: Number(r.escalated || 0),
      per_day_avg: Number(r.per_day_avg || (Number(r.total || 0) / LEARNING_WINDOW_DAYS) || 0),
    }));
    return rows;
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[noisy-auto-learn] noisy-producers 조회 실패: ${msg}`);
    return [];
  }
}

// ────── 제안 분류 ──────

type ProposalAction = 'auto_suppress' | 'needs_approval' | 'needs_human';

interface SuppressionProposal {
  team: string;
  producer: string;
  alarm_type: string;
  cluster_key: string | null;
  total: number;
  escalated: number;
  per_day_avg: number;
  action: ProposalAction;
  rationale: string;
  dry_run_rule: Record<string, unknown>;
}

function classifyProposal(row: NoisyProducerRow): SuppressionProposal | null {
  if (row.per_day_avg < NOISY_THRESHOLD_PER_DAY) return null;

  let action: ProposalAction;
  let rationale: string;

  if (row.escalated > 0) {
    // 에스컬레이션된 알람이 있으면 human 검토 필요
    action = 'needs_human';
    rationale = `에스컬레이션 ${row.escalated}건 포함 — 자동 suppress 위험. 마스터 직접 검토 필요.`;
  } else if (row.alarm_type === 'report') {
    // 리포트 유형은 자동 적용 가능 (낮은 위험)
    action = AUTO_SUPPRESS ? 'auto_suppress' : 'needs_approval';
    rationale = `report 유형 비에스컬레이션 — digest 라우팅으로 자동 suppress 가능.`;
  } else if (row.per_day_avg >= NOISY_THRESHOLD_PER_DAY * 3) {
    // 임계치 3배 이상이면 강제 심사
    action = 'needs_approval';
    rationale = `일 평균 ${row.per_day_avg.toFixed(0)}건 (임계치 ${NOISY_THRESHOLD_PER_DAY}의 3배) — 마스터 승인 후 적용.`;
  } else {
    action = 'needs_approval';
    rationale = `일 평균 ${row.per_day_avg.toFixed(0)}건 — suppress 제안 (마스터 승인 필요).`;
  }

  return {
    team: row.team,
    producer: row.producer,
    alarm_type: row.alarm_type,
    cluster_key: row.cluster_key,
    total: row.total,
    escalated: row.escalated,
    per_day_avg: row.per_day_avg,
    action,
    rationale,
    dry_run_rule: {
      team: row.team,
      fromBot: row.producer,
      visibility: action === 'auto_suppress' ? 'digest' : null,
      incidentKeyPrefix: row.cluster_key ? row.cluster_key.split('|').slice(0, 2).join('|') : null,
    },
  };
}

// ────── 자동 적용 (HUB_NOISY_AUTO_SUPPRESS=true 시) ──────

async function applyAutoSuppress(proposals: SuppressionProposal[]): Promise<{
  applied: number;
  skipped: number;
}> {
  const autoTargets = proposals.filter((p) => p.action === 'auto_suppress');
  if (autoTargets.length === 0) return { applied: 0, skipped: proposals.length };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let applied = 0;
  let skipped = 0;

  try {
    const resp = await fetch(`${HUB_BASE}/hub/alarm/suppression/apply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ proposals: autoTargets.map((p) => p.dry_run_rule) }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      applied = Number(data?.applied_count || autoTargets.length);
      skipped = proposals.length - applied;
      console.log(`[noisy-auto-learn] 자동 적용: ${applied}건`);
    } else {
      skipped = proposals.length;
      console.warn(`[noisy-auto-learn] suppression/apply HTTP ${resp.status} — 자동 적용 실패`);
    }
  } catch (err: unknown) {
    clearTimeout(timer);
    skipped = proposals.length;
    console.warn('[noisy-auto-learn] suppression/apply 오류 — 자동 적용 스킵');
  }

  return { applied, skipped };
}

// ────── meeting 토픽 메시지 빌드 ──────

function buildMeetingMessage(
  proposals: SuppressionProposal[],
  autoApplyResult: { applied: number; skipped: number } | null,
): string {
  const today = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);
  const autoCount = proposals.filter((p) => p.action === 'auto_suppress').length;
  const approvalCount = proposals.filter((p) => p.action === 'needs_approval').length;
  const humanCount = proposals.filter((p) => p.action === 'needs_human').length;

  const lines: string[] = [
    `📊 [Weekly Noisy Producer Review] ${today}`,
    `기간: 지난 ${LEARNING_WINDOW_DAYS}일 | 임계치: 일 ${NOISY_THRESHOLD_PER_DAY}건+`,
    `제안: ${proposals.length}건 (자동=${autoCount} / 승인필요=${approvalCount} / 수동=${humanCount})`,
  ];

  if (autoApplyResult && autoApplyResult.applied > 0) {
    lines.push(`✅ 자동 적용 완료: ${autoApplyResult.applied}건`);
  }

  if (proposals.length === 0) {
    lines.push('');
    lines.push('✅ 이번 주 noisy producer 없음 — 알람 품질 양호');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('🔝 Top Noisy Producers:');

  const top10 = proposals.slice(0, 10);
  for (const p of top10) {
    const actionIcon = p.action === 'auto_suppress' ? '✅' : p.action === 'needs_approval' ? '🟡' : '🔴';
    lines.push(`${actionIcon} ${p.team}/${p.producer}: 일평균 ${p.per_day_avg.toFixed(0)}건 → ${p.action}`);
    if (p.rationale) lines.push(`   └ ${p.rationale}`);
  }

  if (approvalCount > 0 || humanCount > 0) {
    lines.push('');
    lines.push('💡 마스터 검토 요청:');
    lines.push(`  - 승인 필요: ${approvalCount}건 (/hub/alarm/suppression/apply 승인)`);
    if (humanCount > 0) {
      lines.push(`  - 직접 검토: ${humanCount}건 (에스컬레이션 포함)`);
    }
  }

  return lines.join('\n');
}

// ────── 메인 ──────

async function main() {
  console.log('[noisy-auto-learn] Noisy Producer 자동 학습 시작');

  if (!isEnabled()) {
    console.log('[noisy-auto-learn] HUB_NOISY_AUTO_LEARN_ENABLED 비활성화 — 종료');
    process.exit(0);
  }

  // 1. noisy producer 조회
  const rows = await fetchNoisyProducers();
  console.log(`[noisy-auto-learn] 조회 완료: ${rows.length}건`);

  // 2. 제안 분류
  const proposals = rows
    .map(classifyProposal)
    .filter((p): p is SuppressionProposal => p !== null);
  console.log(`[noisy-auto-learn] 제안 생성: ${proposals.length}건`);

  // 3. 자동 적용 (HUB_NOISY_AUTO_SUPPRESS=true 시)
  let autoApplyResult: { applied: number; skipped: number } | null = null;
  if (DRY_RUN) {
    console.log('[noisy-auto-learn] dry-run — suppression 적용과 Telegram 발송 스킵');
  } else if (AUTO_SUPPRESS && proposals.length > 0) {
    console.log('[noisy-auto-learn] 자동 suppress 적용 중...');
    autoApplyResult = await applyAutoSuppress(proposals);
  } else if (AUTO_SUPPRESS) {
    console.log('[noisy-auto-learn] 자동 suppress 대상 없음');
  } else {
    console.log('[noisy-auto-learn] HUB_NOISY_AUTO_SUPPRESS=false — 마스터 승인 대기 모드');
  }

  // 4. meeting 토픽 발송
  const message = buildMeetingMessage(proposals, autoApplyResult);
  const today = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);

  const resultPayload = {
    ok: true,
    dry_run: DRY_RUN,
    fixture: FIXTURE_MODE,
    window_days: LEARNING_WINDOW_DAYS,
    threshold_per_day: NOISY_THRESHOLD_PER_DAY,
    total_noisy: rows.length,
    proposal_count: proposals.length,
    auto_suppress_enabled: AUTO_SUPPRESS,
    auto_applied: autoApplyResult?.applied || 0,
    by_action: {
      auto_suppress: proposals.filter((p) => p.action === 'auto_suppress').length,
      needs_approval: proposals.filter((p) => p.action === 'needs_approval').length,
      needs_human: proposals.filter((p) => p.action === 'needs_human').length,
    },
    proposals,
    message,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(resultPayload, null, 2));
  }

  if (DRY_RUN) {
    console.log(`[noisy-auto-learn] dry-run 완료: 제안 ${proposals.length}건`);
    return;
  }

  const sent = await postAlarm({
    team: 'hub',
    fromBot: 'noisy-producer-auto-learn',
    alertLevel: proposals.length > 0 ? 2 : 1,
    alarmType: 'report',
    visibility: proposals.length > 0 ? 'notify' : 'digest',
    title: `[Weekly Noisy Review] ${proposals.length}건 제안 (승인필요=${proposals.filter((p) => p.action === 'needs_approval').length})`,
    message,
    eventType: 'noisy_producer_weekly_review',
    incidentKey: `hub:noisy_producer_review:${today}`,
    payload: {
      event_type: 'noisy_producer_weekly_review',
      window_days: LEARNING_WINDOW_DAYS,
      threshold_per_day: NOISY_THRESHOLD_PER_DAY,
      total_noisy: resultPayload.total_noisy,
      proposal_count: resultPayload.proposal_count,
      auto_suppress_enabled: resultPayload.auto_suppress_enabled,
      auto_applied: resultPayload.auto_applied,
      by_action: resultPayload.by_action,
    },
  });

  if (!sent?.ok) {
    console.error('[noisy-auto-learn] meeting 발송 실패:', sent?.error);
    process.exit(1);
  }

  console.log(`[noisy-auto-learn] 완료: 제안 ${proposals.length}건, 자동적용 ${autoApplyResult?.applied || 0}건`);
}

main().catch((err: Error) => {
  console.error('[noisy-auto-learn] 치명적 오류:', err.message);
  process.exit(1);
});
