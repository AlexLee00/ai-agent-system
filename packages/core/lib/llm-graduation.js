'use strict';

/**
 * packages/core/lib/llm-graduation.js — LLM 졸업 엔진
 *
 * "같은 유형의 입력에 대해 LLM이 매번 동일한 판단을 내리면,
 *  그 판단을 규칙으로 추출하여 LLM 호출을 제거한다."
 *
 * 흐름:
 *   1. shadow_log에서 반복 패턴 감지 (같은 context + 동일 decision 90%+)
 *   2. 규칙 후보 추출 (input 패턴 → decision 매핑)
 *   3. 2주 병렬 검증 (규칙 결과 vs LLM 결과 비교)
 *   4. 마스터 승인 후 적용 (자동 적용 금지!)
 *   5. 졸업 후에도 주 1회 LLM 샘플 검증 (환경 변화 시 자동 복귀)
 *
 * DB: PostgreSQL (claude 스키마 graduation_candidates 테이블)
 *     shadow_log는 reservation 스키마
 */

const pgPool = require('./pg-pool');

const SCHEMA        = 'claude';
const SHADOW_SCHEMA = 'reservation';

// ── 테이블 초기화 ─────────────────────────────────────────────────────
let _tableReady = false;

async function _ensureTable() {
  if (_tableReady) return;
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS graduation_candidates (
      id                  SERIAL PRIMARY KEY,
      team                TEXT NOT NULL,
      context             TEXT NOT NULL,
      pattern             JSONB NOT NULL,
      predicted_decision  TEXT NOT NULL,
      sample_count        INTEGER NOT NULL,
      match_rate          REAL NOT NULL,
      status              TEXT NOT NULL DEFAULT 'candidate',
      verified_at         TIMESTAMPTZ,
      approved_by         TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team, context, predicted_decision)
    )
  `);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_grad_team_ctx ON graduation_candidates(team, context, status)
  `);
  _tableReady = true;
}

// ── 졸업 후보 탐색 ────────────────────────────────────────────────────

/**
 * shadow_log 분석 → 졸업 후보 탐색
 * 동일 team+context에서 특정 decision이 minMatchRate 이상 반복되면 후보 등록
 *
 * @param {string} team
 * @param {number} minSamples   최소 샘플 수 (기본 20)
 * @param {number} minMatchRate LLM 일치율 최소값 (기본 0.90)
 * @returns {Promise<Array>}    등록/업데이트된 후보 목록
 */
async function findGraduationCandidates(team, minSamples = 20, minMatchRate = 0.90) {
  await _ensureTable();

  // shadow_log에서 team별 context+decision 분포 집계
  const rows = await pgPool.query(SHADOW_SCHEMA, `
    SELECT
      team,
      context,
      llm_result->>'decision'                         AS decision,
      COUNT(*)                                         AS total,
      SUM(CASE WHEN match = true  THEN 1 ELSE 0 END)  AS matched
    FROM shadow_log
    WHERE team = $1
      AND llm_result IS NOT NULL
      AND match IS NOT NULL
    GROUP BY team, context, llm_result->>'decision'
    HAVING COUNT(*) >= $2
    ORDER BY total DESC
  `, [team, minSamples]);

  const candidates = [];
  for (const row of rows) {
    const total     = Number(row.total);
    const matched   = Number(row.matched);
    const matchRate = total > 0 ? matched / total : 0;

    if (matchRate < minMatchRate) continue;

    // graduation_candidates에 등록 or 업데이트
    await pgPool.run(SCHEMA, `
      INSERT INTO graduation_candidates
        (team, context, pattern, predicted_decision, sample_count, match_rate, status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'candidate', NOW())
      ON CONFLICT (team, context, predicted_decision) DO UPDATE SET
        sample_count = EXCLUDED.sample_count,
        match_rate   = EXCLUDED.match_rate,
        updated_at   = NOW()
      WHERE graduation_candidates.status = 'candidate'
    `, [
      row.team,
      row.context,
      JSON.stringify({ context: row.context }),
      row.decision,
      total,
      matchRate,
    ]);

    candidates.push({
      team:      row.team,
      context:   row.context,
      decision:  row.decision,
      total,
      matchRate: (matchRate * 100).toFixed(1) + '%',
    });
  }

  return candidates;
}

// ── 검증 시작 ─────────────────────────────────────────────────────────

/**
 * 졸업 후보 검증 시작 (2주 병렬 검증)
 * @param {number} candidateId
 */
async function startVerification(candidateId) {
  await _ensureTable();
  const row = await pgPool.get(SCHEMA,
    `SELECT * FROM graduation_candidates WHERE id = $1`, [candidateId]
  );
  if (!row) throw new Error(`후보 없음: id=${candidateId}`);
  if (row.status !== 'candidate') throw new Error(`검증 불가 상태: ${row.status}`);

  await pgPool.run(SCHEMA, `
    UPDATE graduation_candidates
    SET status = 'verifying', verified_at = NOW(), updated_at = NOW()
    WHERE id = $1
  `, [candidateId]);

  return { id: candidateId, team: row.team, context: row.context, decision: row.predicted_decision };
}

// ── 졸업 승인 ─────────────────────────────────────────────────────────

/**
 * 졸업 승인 (마스터만 가능!)
 * @param {number} candidateId
 * @param {string} approvedBy  반드시 'master' 이어야 함
 */
async function approveGraduation(candidateId, approvedBy = 'master') {
  await _ensureTable();
  if (approvedBy !== 'master') {
    throw new Error('졸업 승인은 마스터만 가능합니다 (approvedBy: "master" 필수)');
  }

  const row = await pgPool.get(SCHEMA,
    `SELECT * FROM graduation_candidates WHERE id = $1`, [candidateId]
  );
  if (!row) throw new Error(`후보 없음: id=${candidateId}`);
  if (!['verifying', 'candidate'].includes(row.status)) {
    throw new Error(`승인 불가 상태: ${row.status}`);
  }

  await pgPool.run(SCHEMA, `
    UPDATE graduation_candidates
    SET status = 'graduated', approved_by = $1, updated_at = NOW()
    WHERE id = $2
  `, [approvedBy, candidateId]);

  return { id: candidateId, graduated: true, approvedBy };
}

// ── 졸업 규칙 적용 여부 ───────────────────────────────────────────────

/**
 * 특정 team+context에 대해 졸업된 규칙이 있는지 확인
 * graduated 상태면 LLM 호출 생략 가능
 *
 * @param {string} team
 * @param {string} context
 * @returns {Promise<{graduated: boolean, decision?: string}|null>}
 */
async function isGraduated(team, context) {
  try {
    await _ensureTable();
    const row = await pgPool.get(SCHEMA, `
      SELECT predicted_decision, match_rate
      FROM graduation_candidates
      WHERE team = $1 AND context = $2 AND status = 'graduated'
      ORDER BY match_rate DESC
      LIMIT 1
    `, [team, context]);

    if (!row) return null;
    return { graduated: true, decision: row.predicted_decision, matchRate: row.match_rate };
  } catch { return null; }
}

// ── 주 1회 샘플 검증 ──────────────────────────────────────────────────

/**
 * 졸업된 규칙에 대해 최근 shadow_log와 비교하여 여전히 유효한지 확인
 * 불일치율 20%+ → 자동 복귀 (graduated → reverted)
 *
 * @param {string} team
 * @returns {Promise<Array>} 복귀된 항목 목록
 */
async function weeklyValidation(team) {
  await _ensureTable();
  const graduated = await pgPool.query(SCHEMA, `
    SELECT * FROM graduation_candidates
    WHERE team = $1 AND status = 'graduated'
  `, [team]);

  const reverted = [];
  const cutoff   = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

  for (const grad of graduated) {
    // 최근 7일 shadow_log에서 해당 context의 LLM 판단과 비교
    const rows = await pgPool.query(SHADOW_SCHEMA, `
      SELECT match
      FROM shadow_log
      WHERE team = $1 AND context = $2
        AND llm_result IS NOT NULL
        AND match IS NOT NULL
        AND created_at > $3
    `, [team, grad.context, cutoff]);

    if (rows.length < 5) continue;  // 샘플 부족 → 스킵

    const mismatched  = rows.filter(r => r.match === false).length;
    const mismatchRate = mismatched / rows.length;

    if (mismatchRate >= 0.20) {
      // 불일치 20%+ → 자동 복귀
      await pgPool.run(SCHEMA, `
        UPDATE graduation_candidates
        SET status = 'reverted', updated_at = NOW()
        WHERE id = $1
      `, [grad.id]);

      reverted.push({
        id:            grad.id,
        team:          grad.team,
        context:       grad.context,
        decision:      grad.predicted_decision,
        mismatchRate:  (mismatchRate * 100).toFixed(1) + '%',
        reason:        `최근 7일 불일치율 ${(mismatchRate * 100).toFixed(1)}% ≥ 20% — 자동 복귀`,
      });
    }
  }

  return reverted;
}

// ── 리포트 ────────────────────────────────────────────────────────────

/**
 * 팀별 LLM 졸업 현황 리포트
 * @param {string} team
 * @returns {Promise<string>}  텍스트 리포트
 */
async function buildGraduationReport(team) {
  await _ensureTable();

  const rows = await pgPool.query(SCHEMA, `
    SELECT status, COUNT(*) AS cnt,
           AVG(match_rate) AS avg_rate
    FROM graduation_candidates
    WHERE team = $1
    GROUP BY status
  `, [team]);

  const byStatus = Object.fromEntries(rows.map(r => [r.status, { cnt: Number(r.cnt), rate: r.avg_rate }]));

  const candidates = await pgPool.query(SCHEMA, `
    SELECT id, context, predicted_decision, sample_count, match_rate, status, updated_at
    FROM graduation_candidates
    WHERE team = $1
    ORDER BY status, match_rate DESC
  `, [team]);

  const lines = [
    `📊 LLM 졸업 현황 (${team}팀)`,
    '════════════════════════',
    `후보:      ${byStatus.candidate?.cnt ?? 0}건`,
    `검증 중:   ${byStatus.verifying?.cnt ?? 0}건`,
    `졸업 완료: ${byStatus.graduated?.cnt ?? 0}건`,
    `복귀됨:    ${byStatus.reverted?.cnt ?? 0}건`,
    '',
  ];

  if (candidates.length > 0) {
    lines.push('상세:');
    for (const c of candidates) {
      const rateStr  = (c.match_rate * 100).toFixed(1) + '%';
      const statusIcon = {
        candidate: '🔍', verifying: '🔄', graduated: '✅', reverted: '↩️',
      }[c.status] ?? '?';
      lines.push(`  ${statusIcon} [${c.context}] ${c.predicted_decision} — ${rateStr} (n=${c.sample_count}) [${c.status}]`);
    }
    lines.push('');
  }

  // 예상 절감 비용 (Sonnet: ~$0.015 / 1K output tokens, 평균 200 tokens → $0.003/호출)
  const graduatedCnt   = byStatus.graduated?.cnt ?? 0;
  const dailySavings   = graduatedCnt * 24 * 0.003;  // 덱스터 1시간 주기 기준
  const monthlySavings = dailySavings * 30;
  if (graduatedCnt > 0) {
    lines.push(`예상 월 절감: $${monthlySavings.toFixed(2)} (Sonnet 기준)`);
  }

  return lines.join('\n');
}

// ── 전체 목록 조회 ────────────────────────────────────────────────────

async function listCandidates(team, status = null) {
  await _ensureTable();
  const params = status ? [team, status] : [team];
  const where  = status
    ? 'WHERE team = $1 AND status = $2'
    : 'WHERE team = $1';
  return pgPool.query(SCHEMA, `
    SELECT id, team, context, predicted_decision, sample_count, match_rate, status, updated_at
    FROM graduation_candidates
    ${where}
    ORDER BY match_rate DESC, sample_count DESC
  `, params);
}

module.exports = {
  findGraduationCandidates,
  startVerification,
  approveGraduation,
  isGraduated,
  weeklyValidation,
  buildGraduationReport,
  listCandidates,
};
