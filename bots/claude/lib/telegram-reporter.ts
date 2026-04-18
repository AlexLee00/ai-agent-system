// @ts-nocheck
'use strict';

/**
 * lib/telegram-reporter.ts — 클로드팀 Telegram 5채널 리포터 (루나/다윈 패턴)
 *
 * 5채널:
 *   urgent  — 즉시 알림 (원칙 위반, Dexter 에러, Verify Loop 실패, Codex 실패) [Kill Switch 없음]
 *   hourly  — 시간별 요약 (진행 중 작업 상태)
 *   daily   — 일일 리포트 (06:30 KST)
 *   weekly  — 주간 리뷰 (일요일 19:00 KST)
 *   meta    — 메타 알림 (NLP 학습, Kill Switch 변경)
 *
 * Kill Switch: CLAUDE_TELEGRAM_ENHANCED=true (기본 false)
 *   - urgent 채널은 Kill Switch 없이 항상 활성 (원칙 위반은 즉시 알림)
 *   - 나머지 4채널은 Kill Switch ON 시만 발송
 */

const path    = require('path');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const kst     = require('../../../packages/core/lib/kst');
const pgPool  = require('../../../packages/core/lib/pg-pool');

// ─── Kill Switch ──────────────────────────────────────────────────────

function isEnhancedEnabled() {
  return process.env.CLAUDE_TELEGRAM_ENHANCED === 'true';
}

// ─── 발송 유틸리티 ────────────────────────────────────────────────────

async function sendUrgent(msg) {
  try {
    await postAlarm({ message: msg, team: 'claude', alertLevel: 4, fromBot: 'claude-reporter' });
  } catch (e) {
    console.warn('[telegram-reporter] urgent 발송 실패:', e.message);
  }
}

async function sendGeneral(msg) {
  if (!isEnhancedEnabled()) {
    console.log('[telegram-reporter] CLAUDE_TELEGRAM_ENHANCED OFF — 일반 알림 스킵');
    return;
  }
  try {
    await postAlarm({ message: msg, team: 'claude', alertLevel: 2, fromBot: 'claude-reporter' });
  } catch (e) {
    console.warn('[telegram-reporter] 일반 발송 실패:', e.message);
  }
}

// ─── Urgent 채널 (항상 활성) ──────────────────────────────────────────

/**
 * Dexter 에러 즉시 알림
 */
async function onDexterCritical(checks) {
  const failedChecks = (Array.isArray(checks) ? checks : [])
    .filter(c => c.status === 'error' || c.status === 'critical');

  if (failedChecks.length === 0) return;

  const lines = [
    '🚨 덱스터 CRITICAL 감지',
    '',
    `감지 시각: ${kst.now().toLocaleString('ko-KR')}`,
    `에러 체크: ${failedChecks.length}건`,
    '',
  ];

  failedChecks.slice(0, 8).forEach(c => {
    lines.push(`  ❌ ${c.check || c.name}: ${c.message || c.detail || '상세 없음'}`);
  });

  await sendUrgent(lines.join('\n'));
}

/**
 * Doctor Verify Loop 실패 알림
 */
async function onVerifyLoopFailed(taskType, attempts, detail) {
  const msg = [
    '🚨 독터 Verify Loop 최종 실패',
    '',
    `작업: ${taskType}`,
    `시도: ${attempts}회`,
    `상세: ${detail || '알 수 없음'}`,
    `시각: ${kst.now().toLocaleString('ko-KR')}`,
    '',
    '수동 개입 필요',
  ].join('\n');

  await sendUrgent(msg);
}

/**
 * 원칙 위반 알림 (보안/규칙 위반)
 */
async function onPrincipleViolation(violationType, detail) {
  const msg = [
    '🚨 원칙 위반 감지',
    '',
    `유형: ${violationType}`,
    `상세: ${detail || '알 수 없음'}`,
    `시각: ${kst.now().toLocaleString('ko-KR')}`,
    '',
    '즉시 확인 필요',
  ].join('\n');

  await sendUrgent(msg);
}

/**
 * 코덱스 실패 알림
 */
async function onCodexFailed(codexName, phase, errorDetail) {
  const msg = [
    '🚨 코덱스 실패',
    '',
    `코덱스: ${codexName}`,
    `Phase: ${phase || '알 수 없음'}`,
    `오류: ${errorDetail || '상세 없음'}`,
    `시각: ${kst.now().toLocaleString('ko-KR')}`,
  ].join('\n');

  await sendUrgent(msg);
}

// ─── Hourly 채널 ──────────────────────────────────────────────────────

/**
 * 시간별 시스템 상태 요약
 */
async function onHourlySummary(stats) {
  if (!isEnhancedEnabled()) return;

  const lines = [
    '⏰ 클로드팀 시간 요약',
    '',
    `시각: ${kst.now().toLocaleString('ko-KR')}`,
  ];

  if (stats.dexter_status) {
    lines.push(`덱스터: ${stats.dexter_status}`);
  }
  if (stats.active_codex) {
    lines.push(`코덱스: ${stats.active_codex}`);
  }
  if (stats.recent_recoveries !== undefined) {
    lines.push(`최근 복구: ${stats.recent_recoveries}건`);
  }
  if (stats.test_status) {
    lines.push(`테스트: ${stats.test_status.tests}개, ${stats.test_status.failures} failures`);
  }

  await sendGeneral(lines.join('\n'));
}

// ─── Daily 채널 ───────────────────────────────────────────────────────

/**
 * 일일 리포트 포맷
 */
function formatDailyReport(stats) {
  const now = kst.now().toLocaleString('ko-KR');
  const lines = [
    '📊 클로드팀 일일 리포트',
    `${now}`,
    '',
  ];

  // 덱스터 상태
  if (stats.dexter) {
    const d = stats.dexter;
    lines.push('🔍 덱스터:');
    lines.push(`  체크 실행: ${d.checks_run || 0}회`);
    lines.push(`  에러 감지: ${d.errors_found || 0}건`);
    lines.push(`  자동 복구: ${d.auto_fixed || 0}건`);
  }

  // 품질 체크
  if (stats.quality) {
    const q = stats.quality;
    lines.push('');
    lines.push('✅ 품질 체크:');
    lines.push(`  코드 리뷰: ${q.review_pass ? '✅ 통과' : '⚠️ 이슈'}`);
    lines.push(`  보안 스캔: ${q.guardian_pass ? '✅ 통과' : '⚠️ 이슈'}`);
    lines.push(`  빌드: ${q.build_pass ? '✅ 통과' : '⚠️ 실패'}`);
  }

  // 코덱스 진행
  if (stats.codex) {
    const c = stats.codex;
    lines.push('');
    lines.push('📋 코덱스:');
    lines.push(`  활성 프로세스: ${c.active_count || 0}개`);
    lines.push(`  완료 Phase: ${c.phases_completed || 0}개`);
  }

  // 테스트 상태
  if (stats.tests) {
    const t = stats.tests;
    lines.push('');
    lines.push('🧪 테스트:');
    lines.push(`  총 ${t.total || 0}개, ${t.failures || 0} failures`);
    if (t.regression) lines.push('  ⚠️ 리그레션 감지!');
  }

  // 복구 이력
  if (stats.recoveries && stats.recoveries.length > 0) {
    lines.push('');
    lines.push('🔧 복구 이력:');
    stats.recoveries.slice(0, 5).forEach(r => {
      lines.push(`  ${r.success ? '✅' : '❌'} ${r.action} (${r.attempts}회 시도)`);
    });
  }

  return lines.join('\n');
}

/**
 * 일일 리포트 발송 (06:30 KST)
 */
async function onDailyReport(stats = {}) {
  const msg = formatDailyReport(stats);
  await sendGeneral(msg);
}

// ─── Weekly 채널 ──────────────────────────────────────────────────────

/**
 * 주간 리뷰 포맷
 */
function formatWeeklyReport(stats) {
  const now = kst.now().toLocaleString('ko-KR');
  const lines = [
    '📅 클로드팀 주간 리뷰',
    `${now}`,
    '',
  ];

  // 주간 요약
  if (stats.week_summary) {
    const w = stats.week_summary;
    lines.push('📊 주간 요약:');
    lines.push(`  총 복구: ${w.total_recoveries || 0}건`);
    lines.push(`  성공률: ${w.success_rate || 0}%`);
    lines.push(`  코드 리뷰: ${w.reviews_done || 0}회`);
    lines.push(`  보안 스캔: ${w.security_scans || 0}회`);
    lines.push(`  빌드: ${w.builds_done || 0}회`);
  }

  // 에이전트 성능
  if (stats.agents) {
    lines.push('');
    lines.push('🤖 에이전트 성능:');
    for (const [agent, data] of Object.entries(stats.agents)) {
      lines.push(`  ${agent}: ${data.status || '정상'}`);
    }
  }

  // NLP 학습 현황
  if (stats.nlp) {
    const n = stats.nlp;
    lines.push('');
    lines.push('🧠 NLP 학습:');
    lines.push(`  학습된 패턴: ${n.learned_patterns || 0}개`);
    lines.push(`  미인식 인텐트: ${n.unrecognized || 0}건`);
  }

  // 다음 주 계획
  if (stats.next_week_notes) {
    lines.push('');
    lines.push('📋 다음 주:');
    lines.push(stats.next_week_notes);
  }

  return lines.join('\n');
}

/**
 * 주간 리뷰 발송 (일요일 19:00 KST)
 */
async function onWeeklyReview(stats = {}) {
  const msg = formatWeeklyReport(stats);
  await sendGeneral(msg);
}

// ─── Meta 채널 ────────────────────────────────────────────────────────

/**
 * Kill Switch 변경 알림
 */
async function onKillSwitchChanged(switchName, enabled, reason) {
  const icon = enabled ? '✅ ON' : '⛔ OFF';
  const msg = [
    `⚙️ Kill Switch 변경`,
    '',
    `스위치: ${switchName}`,
    `상태: ${icon}`,
    reason ? `이유: ${reason}` : '',
    `시각: ${kst.now().toLocaleString('ko-KR')}`,
  ].filter(Boolean).join('\n');

  await sendGeneral(msg);
}

/**
 * NLP 자동 학습 알림
 */
async function onNlpLearned(pattern, intent, confidence) {
  const msg = [
    '🧠 NLP 패턴 자동 학습',
    '',
    `패턴: "${pattern}"`,
    `→ 인텐트: ${intent}`,
    `신뢰도: ${confidence || 0}`,
    `시각: ${kst.now().toLocaleString('ko-KR')}`,
  ].join('\n');

  await sendGeneral(msg);
}

/**
 * Commander 신규 핸들러 등록 알림
 */
async function onHandlerRegistered(handlerName, description) {
  const msg = [
    '⚙️ Commander 핸들러 등록',
    '',
    `핸들러: ${handlerName}`,
    description ? `설명: ${description}` : '',
    `시각: ${kst.now().toLocaleString('ko-KR')}`,
  ].filter(Boolean).join('\n');

  await sendGeneral(msg);
}

// ─── Daily/Weekly 통계 수집 ───────────────────────────────────────────

/**
 * 오늘의 복구 이력 DB 조회
 */
async function fetchTodayRecoveries() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT action, success, attempts
      FROM claude_doctor_recovery_log
      WHERE inserted_at >= NOW() - INTERVAL '24 hours'
      ORDER BY inserted_at DESC
      LIMIT 20
    `);
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * 일일 리포트용 통계 수집 + 발송
 */
async function runDailyReport() {
  const recoveries = await fetchTodayRecoveries();
  const successCount = recoveries.filter(r => r.success).length;
  const failCount    = recoveries.length - successCount;

  await onDailyReport({
    dexter: {
      checks_run: 24,
      errors_found: failCount,
      auto_fixed: successCount,
    },
    recoveries: recoveries.slice(0, 5),
  });
}

/**
 * 주간 리포트용 통계 수집 + 발송
 */
async function runWeeklyReport() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_count,
        AVG(attempts) AS avg_attempts
      FROM claude_doctor_recovery_log
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
    `);

    const row = rows?.[0] || {};
    const total   = Number(row.total || 0);
    const success = Number(row.success_count || 0);
    const rate    = total > 0 ? Math.round((success / total) * 100) : 0;

    await onWeeklyReview({
      week_summary: {
        total_recoveries: total,
        success_rate: rate,
      },
    });
  } catch (e) {
    console.warn('[telegram-reporter] 주간 통계 수집 실패:', e.message);
    await onWeeklyReview({});
  }
}

module.exports = {
  // Urgent (항상 활성)
  onDexterCritical,
  onVerifyLoopFailed,
  onPrincipleViolation,
  onCodexFailed,

  // Hourly
  onHourlySummary,

  // Daily
  onDailyReport,
  runDailyReport,
  formatDailyReport,

  // Weekly
  onWeeklyReview,
  runWeeklyReport,
  formatWeeklyReport,

  // Meta
  onKillSwitchChanged,
  onNlpLearned,
  onHandlerRegistered,

  // 내부
  sendUrgent,
  sendGeneral,
  isEnhancedEnabled,
};
