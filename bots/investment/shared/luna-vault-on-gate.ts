// @ts-nocheck
/**
 * C2 L2 ON 전환 게이트 — luna_vault_shadow_eval 집계 + 게이트 판정 + ON 후보 기록
 *
 * read-only: luna_vault_shadow_eval (및 shadow/trade/curriculum 테이블)
 * write: investment.luna_vault_shadow_on_candidates (후보 기록만)
 *
 * 게이트 조건 (4개 모두 충족 시 PASS):
 *   1. sample_n >= VAULT_ON_GATE_MIN_SAMPLE (기본 30)
 *   2. vault_hit_rate >= VAULT_ON_GATE_MIN_HIT (기본 0.6)
 *   3. vault_hit_rate >= base_hit_rate (비열등)
 *   4. eval_days >= VAULT_ON_GATE_MIN_DAYS (기본 14)
 *
 * family = pattern_key.split(':')[1]
 * direction = vault_shadow_type → positive(boost/enable) | negative(penalize/disable)
 */

import * as db from './db.ts';

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function envNumber(key: string, fallback: number, min: number, max: number): number {
  return boundedNumber(process.env[key], fallback, min, max);
}

export interface OnGateConfig {
  minHit: number;    // VAULT_ON_GATE_MIN_HIT (θ, default 0.6)
  minSample: number; // VAULT_ON_GATE_MIN_SAMPLE (N, default 30)
  minDays: number;   // VAULT_ON_GATE_MIN_DAYS (T, default 14)
}

export function resolveOnGateConfig(overrides: Partial<OnGateConfig> = {}): OnGateConfig {
  return {
    minHit: overrides.minHit ?? envNumber('VAULT_ON_GATE_MIN_HIT', 0.6, 0, 1),
    minSample: overrides.minSample ?? envNumber('VAULT_ON_GATE_MIN_SAMPLE', 30, 1, 10000),
    minDays: overrides.minDays ?? envNumber('VAULT_ON_GATE_MIN_DAYS', 14, 0, 365),
  };
}

export interface EvalGroup {
  market: string;
  family: string;
  direction: 'positive' | 'negative';
  totalEvals: number;
  sampleN: number;        // base_correct/vault_correct가 모두 산출된 채점 표본
  vaultHits: number;      // vault_correct = true
  baseHits: number;       // base_correct = true
  firstEval: Date | null;
  lastEval: Date | null;
}

export interface GateResult extends EvalGroup {
  vaultHitRate: number | null;
  baseHitRate: number | null;
  lift: number | null;
  evalDays: number;
  gateStatus: 'pass' | 'block';
  gateReason: string | null;
}

async function ensureOnCandidatesTable(): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS investment.luna_vault_shadow_on_candidates (
      id              BIGSERIAL PRIMARY KEY,
      scope_market    TEXT NOT NULL,
      scope_family    TEXT NOT NULL,
      scope_direction TEXT NOT NULL,
      vault_hit_rate  DOUBLE PRECISION,
      base_hit_rate   DOUBLE PRECISION,
      lift            DOUBLE PRECISION,
      sample_n        INTEGER NOT NULL DEFAULT 0,
      eval_days       INTEGER NOT NULL DEFAULT 0,
      gate_status     TEXT NOT NULL CHECK (gate_status IN ('pass', 'block')),
      gate_reason     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (scope_market, scope_family, scope_direction)
    )
  `);
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_on_candidates_scope
     ON investment.luna_vault_shadow_on_candidates (scope_market, scope_family, scope_direction)`,
  ).catch(() => null);
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_on_candidates_status
     ON investment.luna_vault_shadow_on_candidates (gate_status)`,
  ).catch(() => null);
}

async function aggregateEvalGroups(): Promise<EvalGroup[]> {
  const rows = await db.query(`
    WITH classified AS (
      SELECT
        market,
        split_part(pattern_key, ':', 2) AS family,
        CASE
          WHEN vault_shadow_type IN ('boost', 'enable')      THEN 'positive'
          WHEN vault_shadow_type IN ('penalize', 'disable')  THEN 'negative'
          ELSE NULL
        END AS direction,
        post_trade_count,
        vault_correct,
        base_correct,
        evaluated_at
      FROM investment.luna_vault_shadow_eval
      WHERE vault_shadow_type IS NOT NULL
    )
    SELECT
      market,
      family,
      direction,
      COUNT(*)::int                                                 AS total_evals,
      COUNT(*) FILTER (
        WHERE post_trade_count > 0 AND base_correct IS NOT NULL AND vault_correct IS NOT NULL
      )::int AS sample_n,
      COUNT(*) FILTER (
        WHERE post_trade_count > 0 AND base_correct IS NOT NULL AND vault_correct = true
      )::int AS vault_hits,
      COUNT(*) FILTER (
        WHERE post_trade_count > 0 AND vault_correct IS NOT NULL AND base_correct = true
      )::int AS base_hits,
      MIN(evaluated_at)                                             AS first_eval,
      MAX(evaluated_at)                                             AS last_eval
    FROM classified
    WHERE direction IS NOT NULL
      AND family IS NOT NULL
      AND family <> ''
    GROUP BY market, family, direction
    ORDER BY market, family, direction
  `);

  return rows.map((row: any) => ({
    market: row.market,
    family: row.family,
    direction: row.direction as 'positive' | 'negative',
    totalEvals: Number(row.total_evals),
    sampleN: Number(row.sample_n),
    vaultHits: Number(row.vault_hits),
    baseHits: Number(row.base_hits),
    firstEval: row.first_eval ? new Date(row.first_eval) : null,
    lastEval: row.last_eval ? new Date(row.last_eval) : null,
  }));
}

export function applyGate(group: EvalGroup, config: OnGateConfig): GateResult {
  const vaultHitRate = group.sampleN > 0
    ? group.vaultHits / group.sampleN
    : null;
  const baseHitRate = group.sampleN > 0
    ? group.baseHits / group.sampleN
    : null;
  const lift = vaultHitRate !== null && baseHitRate !== null
    ? vaultHitRate - baseHitRate
    : null;
  const evalDays = group.firstEval && group.lastEval
    ? Math.max(0, Math.floor((group.lastEval.getTime() - group.firstEval.getTime()) / 86_400_000))
    : 0;

  let gateReason: string | null = null;
  if (group.sampleN < config.minSample) {
    gateReason = `insufficient_sample: ${group.sampleN}<${config.minSample}`;
  } else if (vaultHitRate === null || vaultHitRate < config.minHit) {
    const actual = vaultHitRate === null ? 'null' : vaultHitRate.toFixed(3);
    gateReason = `hit_below_threshold: ${actual}<${config.minHit}`;
  } else if (baseHitRate === null || vaultHitRate < baseHitRate) {
    const base = baseHitRate === null ? 'null' : baseHitRate.toFixed(3);
    gateReason = `not_better_than_base: vault=${vaultHitRate.toFixed(3)} base=${base}`;
  } else if (evalDays < config.minDays) {
    gateReason = `window_too_short: ${evalDays}<${config.minDays}`;
  }

  return {
    ...group,
    vaultHitRate,
    baseHitRate,
    lift,
    evalDays,
    gateStatus: gateReason === null ? 'pass' : 'block',
    gateReason,
  };
}

async function upsertCandidate(result: GateResult): Promise<void> {
  await db.run(`
    INSERT INTO investment.luna_vault_shadow_on_candidates
      (scope_market, scope_family, scope_direction,
       vault_hit_rate, base_hit_rate, lift,
       sample_n, eval_days, gate_status, gate_reason, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    ON CONFLICT (scope_market, scope_family, scope_direction) DO UPDATE SET
      vault_hit_rate = EXCLUDED.vault_hit_rate,
      base_hit_rate  = EXCLUDED.base_hit_rate,
      lift           = EXCLUDED.lift,
      sample_n       = EXCLUDED.sample_n,
      eval_days      = EXCLUDED.eval_days,
      gate_status    = EXCLUDED.gate_status,
      gate_reason    = EXCLUDED.gate_reason,
      created_at     = NOW()
  `, [
    result.market,
    result.family,
    result.direction,
    result.vaultHitRate,
    result.baseHitRate,
    result.lift,
    result.sampleN,
    result.evalDays,
    result.gateStatus,
    result.gateReason,
  ]);
}

export interface ComputeOnGateOptions {
  config?: Partial<OnGateConfig>;
  write?: boolean;
}

export async function computeOnGate({ config = {}, write = false }: ComputeOnGateOptions = {}) {
  const resolvedConfig = resolveOnGateConfig(config);
  if (write) await ensureOnCandidatesTable();

  const groups = await aggregateEvalGroups();
  const results: GateResult[] = groups.map((group) => applyGate(group, resolvedConfig));

  if (write) {
    for (const result of results) {
      await upsertCandidate(result);
    }
  }

  const passed = results.filter((r) => r.gateStatus === 'pass');
  const blocked = results.filter((r) => r.gateStatus === 'block');

  return {
    ok: true,
    write,
    config: resolvedConfig,
    groups: groups.length,
    passed: passed.length,
    blocked: blocked.length,
    results,
    safety: {
      readOnlyTables: [
        'investment.luna_vault_shadow_eval',
        'investment.luna_vault_shadow_adjustments',
        'investment.trade_journal',
        'investment.agent_curriculum_state',
      ],
      writeTableOnly: write ? 'investment.luna_vault_shadow_on_candidates' : null,
      liveTradeImpact: false,
      curriculumImpact: false,
    },
  };
}

export async function buildOnGateReport({ limit = 500 } = {}) {
  const rows = await db.query(`
    SELECT *
    FROM investment.luna_vault_shadow_on_candidates
    ORDER BY gate_status DESC, scope_market, scope_family, scope_direction
    LIMIT $1
  `, [Math.min(Math.max(1, limit), 5000)]).catch(() => []);

  const passed = rows.filter((r: any) => r.gate_status === 'pass');
  const blocked = rows.filter((r: any) => r.gate_status === 'block');

  const blockReasonSummary: Record<string, number> = {};
  for (const row of blocked) {
    const reason = String(row.gate_reason ?? 'none');
    if (reason !== 'none') {
      const code = reason.split(':')[0];
      blockReasonSummary[code] = (blockReasonSummary[code] ?? 0) + 1;
    }
  }

  return {
    ok: true,
    totalRecords: rows.length,
    passed: passed.length,
    blocked: blocked.length,
    blockReasonSummary,
    passedCandidates: passed.map((r: any) => ({
      market: r.scope_market,
      family: r.scope_family,
      direction: r.scope_direction,
      vaultHitRate: r.vault_hit_rate,
      baseHitRate: r.base_hit_rate,
      lift: r.lift,
      sampleN: r.sample_n,
      evalDays: r.eval_days,
      computedAt: r.created_at,
    })),
    blockedGroups: blocked.map((r: any) => ({
      market: r.scope_market,
      family: r.scope_family,
      direction: r.scope_direction,
      sampleN: r.sample_n,
      vaultHitRate: r.vault_hit_rate,
      gateReason: r.gate_reason,
    })),
    generatedAt: new Date().toISOString(),
  };
}

export default { computeOnGate, buildOnGateReport, resolveOnGateConfig, applyGate };
