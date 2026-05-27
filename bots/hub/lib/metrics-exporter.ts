'use strict';

// Metrics Exporter — Prometheus 형식 /metrics 엔드포인트
// LLM Auto-Router + Permission Tier + Agent 성공률 메트릭 제공

import path from 'node:path';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

// ─── 인메모리 카운터 (DB 조회 없이 즉시 집계) ─────────────────────────────────

interface Counters {
  // LLM 호출
  llm_calls_total: Record<string, number>;       // {model}_{provider}
  llm_calls_success: Record<string, number>;
  llm_calls_failed: Record<string, number>;
  llm_cost_usd_total: Record<string, number>;    // {team}
  llm_latency_ms_sum: Record<string, number>;
  llm_latency_ms_count: Record<string, number>;

  // Auto-Router
  auto_router_decisions: Record<string, number>; // {complexity}_{model}_{mode}

  // Permission Tier
  permission_tier_total: Record<string, number>; // tier_{n}_{decision}

  // 메트릭 마지막 갱신
  last_db_sync_at: number;
}

const counters: Counters = {
  llm_calls_total: {},
  llm_calls_success: {},
  llm_calls_failed: {},
  llm_cost_usd_total: {},
  llm_latency_ms_sum: {},
  llm_latency_ms_count: {},
  auto_router_decisions: {},
  permission_tier_total: {},
  last_db_sync_at: 0,
};

// ─── 카운터 업데이트 API ──────────────────────────────────────────────────────

export function recordLlmCall(opts: {
  model: string;
  provider: string;
  team: string;
  success: boolean;
  latencyMs: number;
  costUsd: number;
}): void {
  const key = `${opts.model}_${opts.provider}`;
  counters.llm_calls_total[key] = (counters.llm_calls_total[key] || 0) + 1;

  if (opts.success) {
    counters.llm_calls_success[key] = (counters.llm_calls_success[key] || 0) + 1;
  } else {
    counters.llm_calls_failed[key] = (counters.llm_calls_failed[key] || 0) + 1;
  }

  counters.llm_cost_usd_total[opts.team] = (counters.llm_cost_usd_total[opts.team] || 0) + opts.costUsd;
  counters.llm_latency_ms_sum[key] = (counters.llm_latency_ms_sum[key] || 0) + opts.latencyMs;
  counters.llm_latency_ms_count[key] = (counters.llm_latency_ms_count[key] || 0) + 1;
}

export function recordAutoRouterDecision(opts: {
  complexity: string;
  model: string;
  mode: string;
}): void {
  const key = `${opts.complexity}_${opts.model}_${opts.mode}`;
  counters.auto_router_decisions[key] = (counters.auto_router_decisions[key] || 0) + 1;
}

export function recordPermissionTier(tier: number, decision: string): void {
  const key = `tier_${tier}_${decision}`;
  counters.permission_tier_total[key] = (counters.permission_tier_total[key] || 0) + 1;
}

// ─── DB에서 주기적으로 스냅샷 갱신 ──────────────────────────────────────────────

const DB_SYNC_INTERVAL_MS = 5 * 60 * 1000;  // 5분

interface DbSnapshot {
  autoRouter?: Array<Record<string, unknown>>;
  permissions?: Array<Record<string, unknown>>;
  budget?: Record<string, unknown>;
}

let dbSnapshot: DbSnapshot = {};

async function syncFromDb(): Promise<void> {
  const now = Date.now();
  if (now - counters.last_db_sync_at < DB_SYNC_INTERVAL_MS) return;
  counters.last_db_sync_at = now;

  try {
    const [autoRouterRows, permRows] = await Promise.allSettled([
      pgPool.query('public', `
        SELECT task_complexity, auto_model, mode, COUNT(*) AS cnt,
               AVG(latency_ms)::INT AS avg_ms,
               SUM(cost_usd)::NUMERIC(10,6) AS total_usd
        FROM hub.llm_auto_routing_log
        WHERE created_at > NOW() - INTERVAL '1 hour'
        GROUP BY task_complexity, auto_model, mode
      `),
      pgPool.query('public', `
        SELECT tier, tier_name, decision, COUNT(*) AS cnt
        FROM hub.permission_audit_log
        WHERE created_at > NOW() - INTERVAL '1 hour'
        GROUP BY tier, tier_name, decision
      `),
    ]);

    dbSnapshot = {
      autoRouter: autoRouterRows.status === 'fulfilled' ? autoRouterRows.value : [],
      permissions: permRows.status === 'fulfilled' ? permRows.value : [],
    };
  } catch {
    // DB 오류 시 기존 스냅샷 유지
  }
}

// ─── Prometheus 형식 렌더링 ───────────────────────────────────────────────────

function renderMetric(name: string, labels: Record<string, string>, value: number): string {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(',');
  return `${name}{${labelStr}} ${value}`;
}

export async function renderPrometheusMetrics(): Promise<string> {
  await syncFromDb().catch(() => {});

  const lines: string[] = [
    '# HELP hub_info Hub 기본 정보',
    '# TYPE hub_info gauge',
    `hub_info{version="1.0"} 1`,
    '',
    '# HELP hub_llm_calls_total LLM 호출 총 횟수',
    '# TYPE hub_llm_calls_total counter',
  ];

  for (const [key, val] of Object.entries(counters.llm_calls_total)) {
    const [model, ...providerParts] = key.split('_');
    const provider = providerParts.join('_');
    lines.push(renderMetric('hub_llm_calls_total', { model, provider }, val));
  }

  lines.push('', '# HELP hub_llm_calls_success LLM 성공 호출', '# TYPE hub_llm_calls_success counter');
  for (const [key, val] of Object.entries(counters.llm_calls_success)) {
    const [model, ...providerParts] = key.split('_');
    lines.push(renderMetric('hub_llm_calls_success', { model, provider: providerParts.join('_') }, val));
  }

  lines.push('', '# HELP hub_llm_cost_usd_total 팀별 LLM 비용 합계 (USD)', '# TYPE hub_llm_cost_usd_total counter');
  for (const [team, val] of Object.entries(counters.llm_cost_usd_total)) {
    lines.push(renderMetric('hub_llm_cost_usd_total', { team }, Math.round(val * 1_000_000) / 1_000_000));
  }

  lines.push('', '# HELP hub_llm_latency_ms_avg 모델별 평균 레이턴시 (ms)', '# TYPE hub_llm_latency_ms_avg gauge');
  for (const [key, sum] of Object.entries(counters.llm_latency_ms_sum)) {
    const count = counters.llm_latency_ms_count[key] || 1;
    const [model, ...providerParts] = key.split('_');
    lines.push(renderMetric('hub_llm_latency_ms_avg', { model, provider: providerParts.join('_') }, Math.round(sum / count)));
  }

  lines.push('', '# HELP hub_auto_router_decisions Auto-Router 결정 횟수', '# TYPE hub_auto_router_decisions counter');
  for (const [key, val] of Object.entries(counters.auto_router_decisions)) {
    const [complexity, model, mode] = key.split('_');
    lines.push(renderMetric('hub_auto_router_decisions', { complexity, model, mode }, val));
  }

  // DB 스냅샷 기반 Auto-Router 메트릭 (1시간)
  if (dbSnapshot.autoRouter?.length) {
    lines.push('', '# HELP hub_auto_router_1h Auto-Router 1시간 통계 (DB)', '# TYPE hub_auto_router_1h gauge');
    for (const row of dbSnapshot.autoRouter) {
      lines.push(renderMetric('hub_auto_router_1h_calls', {
        complexity: String(row['task_complexity'] || ''),
        model: String(row['auto_model'] || ''),
        mode: String(row['mode'] || ''),
      }, Number(row['cnt'] || 0)));
    }
  }

  lines.push('', '# HELP hub_permission_tier_total Permission Tier 결정 총 횟수', '# TYPE hub_permission_tier_total counter');
  for (const [key, val] of Object.entries(counters.permission_tier_total)) {
    const [, tier, decision] = key.split('_');
    lines.push(renderMetric('hub_permission_tier_total', { tier, decision }, val));
  }

  // DB 스냅샷 기반 Permission 통계 (1시간)
  if (dbSnapshot.permissions?.length) {
    lines.push('', '# HELP hub_permission_1h Permission Tier 1시간 통계 (DB)', '# TYPE hub_permission_1h gauge');
    for (const row of dbSnapshot.permissions) {
      lines.push(renderMetric('hub_permission_1h', {
        tier: String(row['tier'] || ''),
        tier_name: String(row['tier_name'] || ''),
        decision: String(row['decision'] || ''),
      }, Number(row['cnt'] || 0)));
    }
  }

  lines.push('', `# last_db_sync_at ${new Date(counters.last_db_sync_at).toISOString()}`, '');

  return lines.join('\n');
}

module.exports = {
  recordLlmCall,
  recordAutoRouterDecision,
  recordPermissionTier,
  renderPrometheusMetrics,
};
