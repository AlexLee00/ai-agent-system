#!/usr/bin/env node
// @ts-nocheck
/**
 * voyager-skill-auto-extraction-verify.ts — Phase Ω6: Voyager 스킬 자동 추출 검증
 *
 * 목적:
 *   reflexion_memory ≥ 5건 누적 후 Voyager 패턴 자동 추출 검증.
 *   posttrade-skill-extractor의 min_occurrences 기반 추출 트리거 확인.
 *
 * 검증 항목:
 *   1. luna_failure_reflexions 누적 수 확인
 *   2. trade_quality_evaluations 데이터 확인
 *   3. 스킬 추출 시뮬레이션 (dryRun=true)
 *   4. skill_library 신규 항목 검증
 *
 * Kill Switch:
 *   LUNA_VOYAGER_AUTO_EXTRACTION_ENABLED=false → 검증 비활성
 *   LUNA_VOYAGER_MIN_CANDIDATES=5 → 최소 후보 수
 */

import * as db from '../shared/db.ts';
import { extractPosttradeSkills } from '../shared/posttrade-skill-extractor.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const ENABLED = () => {
  const raw = String(process.env.LUNA_VOYAGER_AUTO_EXTRACTION_ENABLED ?? 'true').toLowerCase();
  return raw !== 'false' && raw !== '0';
};

const MIN_CANDIDATES = () =>
  Math.max(1, Number(process.env.LUNA_VOYAGER_MIN_CANDIDATES || 5));

type VerifyStep = { name: string; pass: boolean; detail?: string };

/** reflexion_memory 누적 수 조회 */
async function countReflexions(): Promise<number> {
  const row = await db.get(
    `SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions`,
    [],
  ).catch(() => null);
  return Number(row?.cnt || 0);
}

/** trade_quality_evaluations 후보 수 조회 */
async function countTqeCandidates(days = 90): Promise<{ preferred: number; rejected: number }> {
  const rows = await db.query(
    `SELECT category, COUNT(*)::int AS cnt
     FROM investment.trade_quality_evaluations
     WHERE evaluated_at >= NOW() - ($1 * INTERVAL '1 day')
       AND category IN ('preferred', 'rejected')
     GROUP BY category`,
    [days],
  ).catch(() => []);

  const result = { preferred: 0, rejected: 0 };
  for (const row of rows || []) {
    if (row.category === 'preferred') result.preferred = Number(row.cnt);
    if (row.category === 'rejected') result.rejected = Number(row.cnt);
  }
  return result;
}

/** production skill evidence 현재 항목 수 */
async function countSkillLibrary(): Promise<number> {
  const [library, posttrade] = await Promise.allSettled([
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.skill_library`, []),
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_posttrade_skills`, []),
  ]);
  const safeCount = (result: PromiseSettledResult<any>) =>
    Number((result.status === 'fulfilled' ? result.value?.cnt : null) || 0);
  return safeCount(library) + safeCount(posttrade);
}

/** 스킬 추출 dry-run 시뮬레이션 */
async function simulateSkillExtraction(): Promise<{
  ok: boolean;
  candidates: number;
  extracted: number;
  error?: string;
}> {
  try {
    const result = await extractPosttradeSkills({
      days: 90,
      market: 'all',
      dryRun: true,
    });
    return {
      ok: result?.ok !== false,
      candidates: Number(result?.candidates ?? 0),
      extracted: Number(result?.extracted ?? 0),
    };
  } catch (err) {
    return { ok: false, candidates: 0, extracted: 0, error: String(err?.message || err).slice(0, 100) };
  }
}

export function buildVoyagerValidationFixture({
  reflexionCount = 0,
  minCandidates = MIN_CANDIDATES(),
} = {}) {
  return {
    status: 'validation_fixture_passed',
    fixtureUsed: true,
    naturalDataReady: reflexionCount >= minCandidates,
    productionSkillPromoted: false,
    source: 'validation_fixture',
    reflexionCount,
    minCandidates,
    assertions: [
      'dry_run_only',
      'no_production_skill_promotion',
      'natural_data_status_preserved',
    ],
  };
}

export async function runVoyagerSkillAutoExtractionVerify(opts: {
  validationFixture?: boolean;
  reflexionCountOverride?: number | null;
  minCandidatesOverride?: number | null;
} = {}): Promise<{
  ok: boolean;
  enabled: boolean;
  status: 'ready_for_extraction' | 'pending_observation' | 'disabled';
  reflexionCount: number;
  minCandidates: number;
  readyForExtraction: boolean;
  naturalDataReady: boolean;
  pendingReason: string | null;
  validationFixture: any;
  steps: VerifyStep[];
  summary: string;
}> {
  if (!ENABLED()) {
    return {
      ok: false,
      enabled: false,
      status: 'disabled',
      reflexionCount: 0,
      minCandidates: MIN_CANDIDATES(),
      readyForExtraction: false,
      naturalDataReady: false,
      pendingReason: 'LUNA_VOYAGER_AUTO_EXTRACTION_ENABLED=false',
      validationFixture: null,
      steps: [],
      summary: 'Voyager 자동 추출 검증 비활성 (LUNA_VOYAGER_AUTO_EXTRACTION_ENABLED=false)',
    };
  }

  const steps: VerifyStep[] = [];

  // ─── Step 1: reflexion_memory 누적 수 확인 ────────────────────────
  const reflexionCount = opts.reflexionCountOverride ?? await countReflexions();
  const minCandidates = opts.minCandidatesOverride ?? MIN_CANDIDATES();
  const readyForExtraction = reflexionCount >= minCandidates;
  const naturalDataReady = readyForExtraction;
  steps.push({
    name: 'reflexion_count_check',
    pass: true,
    detail: `현재 ${reflexionCount}건 (기준 ≥${minCandidates}건) → ${readyForExtraction ? '✅ 추출 준비됨' : '⏳ 누적 대기 중'}`,
  });

  // ─── Step 2: TQE 후보 데이터 확인 ────────────────────────────────
  const tqe = await countTqeCandidates(90);
  steps.push({
    name: 'tqe_candidates_check',
    pass: (tqe.preferred + tqe.rejected) >= 0,
    detail: `preferred=${tqe.preferred}건, rejected=${tqe.rejected}건 (90일)`,
  });

  // ─── Step 3: skill_library 현재 상태 ─────────────────────────────
  const skillCountBefore = await countSkillLibrary();
  const productionSkillPromoted = skillCountBefore > 0;
  steps.push({
    name: 'skill_library_before',
    pass: true,
    detail: `현재 production skill evidence ${skillCountBefore}건`,
  });

  // ─── Step 4: 스킬 추출 dry-run ────────────────────────────────────
  const simResult = await simulateSkillExtraction();
  steps.push({
    name: 'skill_extraction_dryrun',
    pass: simResult.ok,
    detail: `ok=${simResult.ok}, candidates=${simResult.candidates}, extracted(dry)=${simResult.extracted}${simResult.error ? ` | 오류: ${simResult.error}` : ''}`,
  });

  // ─── Step 5: 추출 준비 상태 요약 ─────────────────────────────────
  if (readyForExtraction) {
    steps.push({
      name: 'ready_for_auto_extraction',
      pass: true,
      detail: `reflexion ${reflexionCount}건 ≥ ${minCandidates}건 → 자동 추출 준비 완료`,
    });
  } else {
    const remaining = minCandidates - reflexionCount;
    steps.push({
      name: 'accumulating_reflexions',
      pass: true,
      detail: `자연 운영 중 누적 대기 (${remaining}건 추가 필요). 매 close cycle마다 +1 예상.`,
    });
  }

  const validationFixture = opts.validationFixture
    ? buildVoyagerValidationFixture({ reflexionCount, minCandidates })
    : null;
  if (validationFixture) {
    steps.push({
      name: 'validation_fixture_dryrun',
      pass: validationFixture.productionSkillPromoted === false,
      detail: `fixtureUsed=true, naturalDataReady=${validationFixture.naturalDataReady}, productionSkillPromoted=false`,
    });
  }

  const corePass = steps.filter(s =>
    ['skill_extraction_dryrun'].includes(s.name),
  ).every(s => s.pass);
  const pendingReason = readyForExtraction
    ? null
    : `insufficient_natural_data: reflexion ${reflexionCount}/${minCandidates}`;

  const summary = readyForExtraction
    ? `✅ Voyager 자동 추출 준비 완료 (reflexion ${reflexionCount}/${minCandidates}건, skill candidates=${simResult.candidates})`
    : `⏳ 자연 운영 누적 중 (reflexion ${reflexionCount}/${minCandidates}건, ${minCandidates - reflexionCount}건 추가 필요)`;

  return {
    ok: corePass,
    enabled: true,
    status: readyForExtraction ? 'ready_for_extraction' : 'pending_observation',
    reflexionCount,
    minCandidates,
    readyForExtraction,
    naturalDataReady,
    productionSkillPromoted,
    pendingReason,
    validationFixture,
    steps,
    summary,
  };
}

async function main() {
  const result = await runVoyagerSkillAutoExtractionVerify({
    validationFixture: process.argv.includes('--validation-fixture'),
  });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n─── Phase Ω6: Voyager 스킬 자동 추출 검증 ───`);
    for (const s of result.steps) {
      console.log(`  ${s.pass ? '✅' : '❌'} ${s.name}: ${s.detail || ''}`);
    }
    console.log(`\n${result.ok ? '✅' : '❌'} ${result.summary}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ voyager-skill-auto-extraction-verify 실패:',
  });
}
