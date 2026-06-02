// @ts-nocheck
/**
 * C2 L2 ON 전환 게이트 — luna_vault_shadow_eval 집계 + 게이트 판정 + ON 후보 기록
 *
 * read-only: luna_vault_shadow_eval (및 shadow/trade/curriculum 테이블)
 * write: investment.luna_vault_on_candidates (후보 기록만)
 *
 * 게이트 조건 (4개 모두 충족 시 PASS):
 *   1. scored_sample >= VAULT_ON_GATE_MIN_SAMPLE (기본 30)
 *   2. vault_hit_rate >= VAULT_ON_GATE_MIN_HIT (기본 0.6)
 *   3. vault_hit_rate >= base_hit_rate (비열등)
 *   4. duration_days >= VAULT_ON_GATE_MIN_DAYS (기본 14)
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
  scoredSample: number;   // post_trade_count > 0 인 행 수
  vaultScored: number;    // vault_correct IS NOT NULL
  vaultHits: number;      // vault_correct = true
  baseScored: number;     // base_correct IS NOT NULL
  baseHits: number;       // base_correct = true
  firstEval: Date | null;
  lastEval: Date | null;
}

export interface GateResult extends EvalGroup {
  vaultHitRate: number | null;
  baseHitRate: number | null;
  lift: number | null;
  durationDays: number | null;
  gateStatus: 'PASS' | 'BLOCK';
  blockReasons: string[];
}

async function ensureOnCandidatesTable(): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS investment.luna_vault_on_candidates (
      id             BIGSERIAL PRIMARY KEY,
      market         TEXT NOT NULL,
      family         TEXT NOT NULL,
      direction      TEXT NOT NULL,
      vault_hit_rate DOUBLE PRECISION,
      base_hit_rate  DOUBLE PRECISION,
      lift           DOUBLE PRECISION,
      vault_scored   INTEGER NOT NULL DEFAULT 0,
      base_scored    INTEGER NOT NULL DEFAULT 0,
      scored_sample  INTEGER NOT NULL DEFAULT 0,
      total_evals    INTEGER NOT NULL DEFAULT 0,
      duration_days  DOUBLE PRECISION,
      gate_status    TEXT NOT NULL,
      block_reasons  TEXT[],
      computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (market, family, direction)
    )
  `);
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_luna_vault_on_candidates_status
     ON investment.luna_vault_on_candidates (gate_status, computed_at DESC)`,
  ).catch(() => null);
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_luna_vault_on_candidates_market
     ON investment.luna_vault_on_candidates (market, family, direction)`,
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
      COUNT(*) FILTER (WHERE post_trade_count > 0)::int             AS scored_sample,
      COUNT(*) FILTER (WHERE vault_correct IS NOT NULL)::int        AS vault_scored,
      COUNT(*) FILTER (WHERE vault_correct = true)::int             AS vault_hits,
      COUNT(*) FILTER (WHERE base_correct IS NOT NULL)::int         AS base_scored,
      COUNT(*) FILTER (WHERE base_correct = true)::int              AS base_hits,
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
    scoredSample: Number(row.scored_sample),
    vaultScored: Number(row.vault_scored),
    vaultHits: Number(row.vault_hits),
    baseScored: Number(row.base_scored),
    baseHits: Number(row.base_hits),
    firstEval: row.first_eval ? new Date(row.first_eval) : null,
    lastEval: row.last_eval ? new Date(row.last_eval) : null,
  }));
}

export function applyGate(group: EvalGroup, config: OnGateConfig): GateResult {
  const vaultHitRate = group.vaultScored > 0
    ? group.vaultHits / group.vaultScored
    : null;
  const baseHitRate = group.baseScored > 0
    ? group.baseHits / group.baseScored
    : null;
  const lift = vaultHitRate !== null && baseHitRate !== null
    ? vaultHitRate - baseHitRate
    : null;
  const durationDays = group.firstEval && group.lastEval
    ? (group.lastEval.getTime() - group.firstEval.getTime()) / 86_400_000
    : null;

  const blockReasons: string[] = [];

  // 조건 1: 채점 표본 수
  if (group.scoredSample < config.minSample) {
    blockReasons.push(`insufficient_sample(${group.scoredSample}<${config.minSample})`);
  }

  // 조건 2: vault 적중률 임계 초과
  if (vaultHitRate === null) {
    blockReasons.push('no_vault_score');
  } else if (vaultHitRate < config.minHit) {
    blockReasons.push(`vault_hit_rate_below_threshold(${vaultHitRate.toFixed(3)}<${config.minHit})`);
  }

  // 조건 3: vault >= base (비열등)
  if (vaultHitRate !== null && baseHitRate !== null && vaultHitRate < baseHitRate) {
    blockReasons.push(`inferior_to_base(vault=${vaultHitRate.toFixed(3)}<base=${baseHitRate.toFixed(3)})`);
  }

  // 조건 4: 안정 기간
  if (durationDays === null || durationDays < config.minDays) {
    const actualDays = durationDays !== null ? durationDays.toFixed(1) : 'N/A';
    blockReasons.push(`insufficient_duration(${actualDays}<${config.minDays}d)`);
  }

  return {
    ...group,
    vaultHitRate,
    baseHitRate,
    lift,
    durationDays,
    gateStatus: blockReasons.length === 0 ? 'PASS' : 'BLOCK',
    blockReasons,
  };
}

async function upsertCandidate(result: GateResult): Promise<void> {
  await db.run(`
    INSERT INTO investment.luna_vault_on_candidates
      (market, family, direction,
       vault_hit_rate, base_hit_rate, lift,
       vault_scored, base_scored, scored_sample, total_evals,
       duration_days, gate_status, block_reasons, computed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
    ON CONFLICT (market, family, direction) DO UPDATE SET
      vault_hit_rate = EXCLUDED.vault_hit_rate,
      base_hit_rate  = EXCLUDED.base_hit_rate,
      lift           = EXCLUDED.lift,
      vault_scored   = EXCLUDED.vault_scored,
      base_scored    = EXCLUDED.base_scored,
      scored_sample  = EXCLUDED.scored_sample,
      total_evals    = EXCLUDED.total_evals,
      duration_days  = EXCLUDED.duration_days,
      gate_status    = EXCLUDED.gate_status,
      block_reasons  = EXCLUDED.block_reasons,
      computed_at    = NOW()
  `, [
    result.market,
    result.family,
    result.direction,
    result.vaultHitRate,
    result.baseHitRate,
    result.lift,
    result.vaultScored,
    result.baseScored,
    result.scoredSample,
    result.totalEvals,
    result.durationDays,
    result.gateStatus,
    result.blockReasons.length > 0 ? result.blockReasons : null,
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

  const passed = results.filter((r) => r.gateStatus === 'PASS');
  const blocked = results.filter((r) => r.gateStatus === 'BLOCK');

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
      writeTableOnly: write ? 'investment.luna_vault_on_candidates' : null,
      liveTradeImpact: false,
      curriculumImpact: false,
    },
  };
}

export async function buildOnGateReport({ limit = 500 } = {}) {
  const rows = await db.query(`
    SELECT *
    FROM investment.luna_vault_on_candidates
    ORDER BY gate_status ASC, market, family, direction
    LIMIT $1
  `, [Math.min(Math.max(1, limit), 5000)]).catch(() => []);

  const passed = rows.filter((r: any) => r.gate_status === 'PASS');
  const blocked = rows.filter((r: any) => r.gate_status === 'BLOCK');

  const blockReasonSummary: Record<string, number> = {};
  for (const row of blocked) {
    for (const reason of (row.block_reasons ?? [])) {
      const code = reason.split('(')[0];
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
      market: r.market,
      family: r.family,
      direction: r.direction,
      vaultHitRate: r.vault_hit_rate,
      baseHitRate: r.base_hit_rate,
      lift: r.lift,
      scoredSample: r.scored_sample,
      durationDays: r.duration_days,
      computedAt: r.computed_at,
    })),
    blockedGroups: blocked.map((r: any) => ({
      market: r.market,
      family: r.family,
      direction: r.direction,
      scoredSample: r.scored_sample,
      vaultHitRate: r.vault_hit_rate,
      blockReasons: r.block_reasons,
    })),
    generatedAt: new Date().toISOString(),
  };
}

export default { computeOnGate, buildOnGateReport, resolveOnGateConfig, applyGate };
