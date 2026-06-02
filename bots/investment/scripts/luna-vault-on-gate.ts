#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-vault-on-gate.ts — S1.3-3 C2 L2 ON 전환 게이트
 *
 * luna_vault_shadow_eval을 (market, family, direction)별로 집계하고,
 * 게이트 조건을 판정해 ON 후보를 investment.luna_vault_on_candidates에 기록한다.
 *
 * 게이트 조건 (4개 모두 충족 시 PASS):
 *   1. scored_sample >= VAULT_ON_GATE_MIN_SAMPLE (기본 30)
 *   2. vault_hit_rate >= VAULT_ON_GATE_MIN_HIT (기본 0.6)
 *   3. vault_hit_rate >= base_hit_rate (비열등)
 *   4. duration_days >= VAULT_ON_GATE_MIN_DAYS (기본 14)
 *
 * family = pattern_key.split(':')[1]
 * direction = vault_shadow_type → positive(boost/enable) | negative(penalize/disable)
 *
 * ★현재 expected: 전부 BLOCK(insufficient_sample) — hit_rate 전부 null(후속 거래 0)
 *   메커니즘 구축 단계. 데이터가 채워지면 자동 작동.
 *
 * 실행:
 *   node bots/investment/scripts/luna-vault-on-gate.ts            # 계산 + write
 *   node bots/investment/scripts/luna-vault-on-gate.ts --dry-run  # DB write 없음
 *   node bots/investment/scripts/luna-vault-on-gate.ts --report   # 기존 후보 리포트만
 *   node bots/investment/scripts/luna-vault-on-gate.ts --json     # JSON 출력
 *
 * 환경변수(게이트 임계 조정):
 *   VAULT_ON_GATE_MIN_HIT    (기본 0.6)
 *   VAULT_ON_GATE_MIN_SAMPLE (기본 30)
 *   VAULT_ON_GATE_MIN_DAYS   (기본 14)
 */

import * as db from '../shared/db.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const REPORT_ONLY = process.argv.includes('--report') || process.argv.includes('--report-only');
const JSON_OUTPUT = process.argv.includes('--json');

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

const CONFIG = {
  minHit: boundedNumber(process.env.VAULT_ON_GATE_MIN_HIT, 0.6, 0, 1),
  minSample: boundedNumber(process.env.VAULT_ON_GATE_MIN_SAMPLE, 30, 1, 10000),
  minDays: boundedNumber(process.env.VAULT_ON_GATE_MIN_DAYS, 14, 0, 365),
};

// ─── DDL ────────────────────────────────────────────────────────────────────

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

// ─── 집계 ───────────────────────────────────────────────────────────────────

async function aggregateEvalGroups() {
  return db.query(`
    WITH classified AS (
      SELECT
        market,
        split_part(pattern_key, ':', 2) AS family,
        CASE
          WHEN vault_shadow_type IN ('boost', 'enable')     THEN 'positive'
          WHEN vault_shadow_type IN ('penalize', 'disable') THEN 'negative'
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
      COUNT(*)::int                                              AS total_evals,
      COUNT(*) FILTER (WHERE post_trade_count > 0)::int          AS scored_sample,
      COUNT(*) FILTER (WHERE vault_correct IS NOT NULL)::int     AS vault_scored,
      COUNT(*) FILTER (WHERE vault_correct = true)::int          AS vault_hits,
      COUNT(*) FILTER (WHERE base_correct IS NOT NULL)::int      AS base_scored,
      COUNT(*) FILTER (WHERE base_correct = true)::int           AS base_hits,
      MIN(evaluated_at)                                          AS first_eval,
      MAX(evaluated_at)                                          AS last_eval
    FROM classified
    WHERE direction IS NOT NULL
      AND family IS NOT NULL
      AND family <> ''
    GROUP BY market, family, direction
    ORDER BY market, family, direction
  `);
}

// ─── 게이트 판정 ─────────────────────────────────────────────────────────────

function applyGate(row: any) {
  const vaultScored = Number(row.vault_scored);
  const vaultHits = Number(row.vault_hits);
  const baseScored = Number(row.base_scored);
  const baseHits = Number(row.base_hits);
  const scoredSample = Number(row.scored_sample);
  const totalEvals = Number(row.total_evals);

  const vaultHitRate = vaultScored > 0 ? vaultHits / vaultScored : null;
  const baseHitRate = baseScored > 0 ? baseHits / baseScored : null;
  const lift = vaultHitRate !== null && baseHitRate !== null
    ? vaultHitRate - baseHitRate
    : null;

  const firstEval = row.first_eval ? new Date(row.first_eval) : null;
  const lastEval = row.last_eval ? new Date(row.last_eval) : null;
  const durationDays = firstEval && lastEval
    ? (lastEval.getTime() - firstEval.getTime()) / 86_400_000
    : null;

  const blockReasons: string[] = [];

  if (scoredSample < CONFIG.minSample) {
    blockReasons.push(`insufficient_sample(${scoredSample}<${CONFIG.minSample})`);
  }

  if (vaultHitRate === null) {
    blockReasons.push('no_vault_score');
  } else if (vaultHitRate < CONFIG.minHit) {
    blockReasons.push(`vault_hit_rate_below_threshold(${vaultHitRate.toFixed(3)}<${CONFIG.minHit})`);
  }

  if (vaultHitRate !== null && baseHitRate !== null && vaultHitRate < baseHitRate) {
    blockReasons.push(`inferior_to_base(vault=${vaultHitRate.toFixed(3)}<base=${baseHitRate.toFixed(3)})`);
  }

  const actualDays = durationDays !== null ? durationDays.toFixed(1) : 'N/A';
  if (durationDays === null || durationDays < CONFIG.minDays) {
    blockReasons.push(`insufficient_duration(${actualDays}<${CONFIG.minDays}d)`);
  }

  return {
    market: row.market,
    family: row.family,
    direction: row.direction,
    vaultHitRate,
    baseHitRate,
    lift,
    vaultScored,
    baseScored,
    scoredSample,
    totalEvals,
    durationDays,
    gateStatus: blockReasons.length === 0 ? 'PASS' : 'BLOCK',
    blockReasons,
  };
}

// ─── 후보 upsert ─────────────────────────────────────────────────────────────

async function upsertCandidate(r: ReturnType<typeof applyGate>): Promise<void> {
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
    r.market,
    r.family,
    r.direction,
    r.vaultHitRate,
    r.baseHitRate,
    r.lift,
    r.vaultScored,
    r.baseScored,
    r.scoredSample,
    r.totalEvals,
    r.durationDays,
    r.gateStatus,
    r.blockReasons.length > 0 ? r.blockReasons : null,
  ]);
}

// ─── 리포트 ──────────────────────────────────────────────────────────────────

async function buildReport() {
  const rows = await db.query(`
    SELECT * FROM investment.luna_vault_on_candidates
    ORDER BY gate_status ASC, market, family, direction
    LIMIT 500
  `).catch(() => []);

  const passed = rows.filter((r: any) => r.gate_status === 'PASS');
  const blocked = rows.filter((r: any) => r.gate_status === 'BLOCK');

  const reasonCounts: Record<string, number> = {};
  for (const row of blocked) {
    for (const reason of (row.block_reasons ?? [])) {
      const code = reason.split('(')[0];
      reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
    }
  }

  return { rows, passed, blocked, reasonCounts };
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

async function main() {
  if (!REPORT_ONLY) {
    if (DRY_RUN) {
      console.log('[vault-on-gate] DRY-RUN — DB write 없음');
    } else {
      await ensureOnCandidatesTable();
    }

    const groups = await aggregateEvalGroups();
    console.log(`[vault-on-gate] 집계 그룹: ${groups.length}건 (market×family×direction)`);

    const results = groups.map(applyGate);
    const passed = results.filter((r) => r.gateStatus === 'PASS');
    const blocked = results.filter((r) => r.gateStatus === 'BLOCK');

    let written = 0;
    let errored = 0;
    if (!DRY_RUN) {
      for (const result of results) {
        try {
          await upsertCandidate(result);
          written++;
        } catch (e: any) {
          console.error(`  [ERROR] upsert ${result.market}/${result.family}/${result.direction}:`, e?.message ?? e);
          errored++;
        }
      }
    }

    if (JSON_OUTPUT) {
      console.log(JSON.stringify({
        ok: true,
        dryRun: DRY_RUN,
        config: CONFIG,
        groups: groups.length,
        passed: passed.length,
        blocked: blocked.length,
        written,
        errored,
        results,
        safety: {
          readOnlyTables: [
            'investment.luna_vault_shadow_eval',
            'investment.luna_vault_shadow_adjustments',
            'investment.trade_journal',
            'investment.agent_curriculum_state',
          ],
          writeTableOnly: DRY_RUN ? null : 'investment.luna_vault_on_candidates',
          liveTradeImpact: false,
          curriculumImpact: false,
        },
        generatedAt: new Date().toISOString(),
      }, null, 2));
      return;
    }

    console.log('\n─── L2 게이트 결과 ──────────────────────────────────────');
    console.log(`그룹 수: ${groups.length} | PASS: ${passed.length} | BLOCK: ${blocked.length}`);
    console.log(`기록: ${written}건 upserted | 에러: ${errored}건 | DRY-RUN: ${DRY_RUN}`);
    console.log(`게이트 설정: minHit=${CONFIG.minHit} minSample=${CONFIG.minSample} minDays=${CONFIG.minDays}`);

    for (const r of results) {
      const vaultStr = r.vaultHitRate !== null ? (r.vaultHitRate * 100).toFixed(1) + '%' : 'N/A';
      const baseStr = r.baseHitRate !== null ? (r.baseHitRate * 100).toFixed(1) + '%' : 'N/A';
      const liftStr = r.lift !== null ? (r.lift >= 0 ? '+' : '') + (r.lift * 100).toFixed(1) + '%' : 'N/A';
      const durStr = r.durationDays !== null ? r.durationDays.toFixed(1) + 'd' : 'N/A';
      const status = r.gateStatus === 'PASS' ? '✓ PASS' : '✗ BLOCK';
      console.log(
        `  ${status} | ${r.market}/${r.family}/${r.direction}` +
        ` | sample=${r.scoredSample} vault=${vaultStr} base=${baseStr} lift=${liftStr} dur=${durStr}` +
        (r.blockReasons.length > 0 ? ` → [${r.blockReasons.join(', ')}]` : ''),
      );
    }
    console.log('────────────────────────────────────────────────────────');
  } else {
    // --report 모드: 기존 후보 테이블 리포트만
    const { rows, passed, blocked, reasonCounts } = await buildReport();

    if (JSON_OUTPUT) {
      console.log(JSON.stringify({
        ok: true,
        mode: 'report_only',
        total: rows.length,
        passed: passed.length,
        blocked: blocked.length,
        reasonCounts,
        rows,
        generatedAt: new Date().toISOString(),
      }, null, 2));
      return;
    }

    console.log('\n─── L2 ON 후보 현황 (luna_vault_on_candidates) ──────────');
    console.log(`전체: ${rows.length}건 | PASS: ${passed.length} | BLOCK: ${blocked.length}`);
    if (Object.keys(reasonCounts).length > 0) {
      console.log('BLOCK 사유:', Object.entries(reasonCounts).map(([k, v]) => `${k}=${v}`).join(', '));
    }
    for (const r of rows) {
      const vaultStr = r.vault_hit_rate !== null ? (Number(r.vault_hit_rate) * 100).toFixed(1) + '%' : 'N/A';
      const status = r.gate_status === 'PASS' ? '✓ PASS' : '✗ BLOCK';
      console.log(
        `  ${status} | ${r.market}/${r.family}/${r.direction}` +
        ` | sample=${r.scored_sample} vault=${vaultStr}` +
        (r.block_reasons?.length > 0 ? ` → [${r.block_reasons.join(', ')}]` : ''),
      );
    }
    console.log('────────────────────────────────────────────────────────');
  }
}

main().catch((e) => {
  console.error('[vault-on-gate] 치명적 오류:', e?.message ?? e);
  process.exit(1);
});
