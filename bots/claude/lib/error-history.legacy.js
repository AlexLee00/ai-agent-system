'use strict';

/**
 * lib/error-history.js — 덱스터 오류 이력 관리
 *
 * 기능:
 *   - saveErrorItems(results): 체크 결과에서 error/warn 항목을 DB에 저장
 *   - getPatterns(days, minCount): 반복 오류 패턴 조회
 *   - getNewErrors(sinceHours): 최근 첫 등장 오류 조회
 *   - cleanup(keepDays): 오래된 이력 삭제
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'claude';

// 패턴 분석에서 제외할 레이블 (개발 중 자연스러운 상태 — false positive 방지)
const PATTERN_SKIP_LABELS = ['git 상태', 'Git 변경사항', 'Git 생성 산출물'];
const PATTERN_SKIP_REGEXES = [
  /^mainbot_queue(?:\s|$)/,
  /^문법: (secrets|db|crypto|domestic|overseas|llm-client)\.js$/,
  /^bots\/reservation\/lib\/(?:secrets|db)\.js$/,
  /^bots\/investment\/markets\/(?:crypto|domestic|overseas)\.js$/,
  /^bots\/investment\/shared\/(?:secrets|llm-client)\.js$/,
];

// 저장 제외 체크명 — 이 체크 결과는 메타 데이터이므로 피드백 루프 방지를 위해 DB 저장 안 함
const SKIP_CHECK_NAMES = ['오류 패턴 분석'];

function shouldSkipHistory(checkName, label) {
  const normalized = String(label || '').trim();
  if (SKIP_CHECK_NAMES.includes(checkName)) return true;
  if (PATTERN_SKIP_LABELS.includes(normalized)) return true;
  return PATTERN_SKIP_REGEXES.some((re) => re.test(normalized));
}

/**
 * 체크 결과에서 error/warn 항목을 모두 저장 (upsert — 같은 패턴은 카운트만 증가)
 */
async function saveErrorItems(results) {
  try {
    for (const r of results) {
      for (const item of (r.items || [])) {
        if (item.status === 'error' || item.status === 'warn') {
          if (shouldSkipHistory(r.name, item.label)) continue;
          await pgPool.run(SCHEMA, `
            INSERT INTO dexter_error_log (check_name, label, status, detail, occurrence_count, first_seen, detected_at)
            VALUES ($1, $2, $3, $4, 1, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
            ON CONFLICT (check_name, label) DO UPDATE SET
              status           = EXCLUDED.status,
              detail           = EXCLUDED.detail,
              occurrence_count = dexter_error_log.occurrence_count + 1,
              detected_at      = EXCLUDED.detected_at
          `, [r.name, item.label.trim(), item.status, item.detail || '']);
        }
      }
    }
  } catch { /* DB 없으면 무시 */ }
}

/**
 * 반복 오류 패턴 조회 (최근 N일 내 M회 이상 반복)
 */
async function getPatterns(days = 7, minCount = 3) {
  try {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const rows = await pgPool.query(SCHEMA, `
      SELECT
        check_name,
        label,
        occurrence_count             AS cnt,
        detected_at                  AS last_seen,
        CASE status WHEN 'error' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END AS severity
      FROM dexter_error_log
      WHERE detected_at > $1
        AND status IN ('error', 'warn')
        AND occurrence_count >= $2
      ORDER BY severity DESC, occurrence_count DESC
      LIMIT 20
    `, [cutoff, minCount]);
    return rows.filter((row) => !shouldSkipHistory(row.check_name, row.label));
  } catch { return []; }
}

/**
 * 현재 ok인 항목의 과거 오류 이력 삭제 (오류 해결 시 패턴 누적 방지)
 */
async function markResolved(results) {
  let total = 0;
  try {
    for (const r of results) {
      for (const item of (r.items || [])) {
        if (item.status === 'ok') {
          const { rowCount } = await pgPool.run(SCHEMA,
            `DELETE FROM dexter_error_log WHERE check_name = $1 AND label = $2`,
            [r.name, item.label.trim()]
          );
          total += rowCount || 0;
        }
      }
    }
  } catch { /* DB 없으면 무시 */ }
  return total;
}

/**
 * 해결된 이슈 이력 삭제
 */
async function clearPatterns(label = null, checkName = null) {
  try {
    if (label && checkName) {
      const { rowCount } = await pgPool.run(SCHEMA,
        `DELETE FROM dexter_error_log WHERE check_name=$1 AND label=$2`,
        [checkName, label]
      );
      return rowCount || 0;
    } else if (label) {
      const { rowCount } = await pgPool.run(SCHEMA,
        `DELETE FROM dexter_error_log WHERE label LIKE $1`,
        [`%${label}%`]
      );
      return rowCount || 0;
    } else if (checkName) {
      const { rowCount } = await pgPool.run(SCHEMA,
        `DELETE FROM dexter_error_log WHERE check_name=$1`,
        [checkName]
      );
      return rowCount || 0;
    } else {
      const { rowCount } = await pgPool.run(SCHEMA, `DELETE FROM dexter_error_log`);
      return rowCount || 0;
    }
  } catch { return 0; }
}

/**
 * 최근 첫 등장 오류 조회
 */
async function getNewErrors(recentHours = 8, prevDays = 7) {
  try {
    const recentCutoff = new Date(Date.now() - recentHours * 3600 * 1000).toISOString();
    const prevCutoff   = new Date(Date.now() - prevDays   * 86400 * 1000).toISOString();

    const rows = await pgPool.query(SCHEMA, `
      SELECT check_name, label, status,
             MIN(detail)      AS detail,
             MIN(detected_at) AS detected_at
      FROM dexter_error_log
      WHERE detected_at > $1
        AND status IN ('error', 'warn')
        AND (check_name || '|' || label) NOT IN (
          SELECT check_name || '|' || label
          FROM dexter_error_log
          WHERE detected_at <= $1
            AND detected_at > $2
        )
      GROUP BY check_name, label, status
      ORDER BY detected_at ASC
      LIMIT 10
    `, [recentCutoff, prevCutoff]);
    return rows.filter((row) => !shouldSkipHistory(row.check_name, row.label));
  } catch { return []; }
}

/**
 * 오래된 이력 삭제
 */
async function cleanup(keepDays = 30) {
  try {
    const cutoff = new Date(Date.now() - keepDays * 86400 * 1000).toISOString();
    const { rowCount } = await pgPool.run(SCHEMA,
      `DELETE FROM dexter_error_log WHERE detected_at < $1`,
      [cutoff]
    );
    return rowCount || 0;
  } catch { return 0; }
}

module.exports = { saveErrorItems, markResolved, getPatterns, getNewErrors, cleanup, clearPatterns };
