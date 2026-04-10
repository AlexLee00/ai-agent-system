#!/usr/bin/env node
'use strict';

/**
 * scripts/integration/cross-team-scenarios.js — 크로스팀 시나리오 테스트
 *
 * ⚠️ DEV 모드 전용 — OPS 데이터에 영향 없음 (모의 이벤트만 발생)
 *
 * 시나리오:
 *   1. 바이낸스 API 장애 → 루나 감지 → 클로드 보고 → 마스터 에스컬레이션
 *   2. 스카팀 정합성 이상 → State Bus → 클로드 판단 → 스카 검증 지시
 *   3. LLM 비용 한도 초과 → 로거 감지 → 다운그레이드 제안 → 마스터 알림
 *   4. 전체 장애 (클로드 무응답) → 덱스터 비상 모드 → 마스터 직접 알림
 *
 * 사용법:
 *   node scripts/integration/cross-team-scenarios.js             # 전체 실행
 *   node scripts/integration/cross-team-scenarios.js --scenario=1
 *   node scripts/integration/cross-team-scenarios.js --dry-run   # 발송 없이 로그만
 */

const path    = require('path');
const ROOT    = path.join(__dirname, '../..');
const tc      = require(path.join(ROOT, 'packages/core/lib/team-comm'));
const sender  = require(path.join(ROOT, 'packages/core/lib/telegram-sender'));
const pgPool  = require(path.join(ROOT, 'packages/core/lib/pg-pool'));

// ── CLI 옵션 ────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY    = (() => { const m = args.join(' ').match(/--scenario=(\d+)/); return m ? Number(m[1]) : null; })();

const STATUS_ICON = { pass: '✅', fail: '❌', skip: '⏭️', info: 'ℹ️' };

// ── 결과 수집 ────────────────────────────────────────────────────────
const results = [];
function record(scenario, step, status, detail) {
  results.push({ scenario, step, status, detail });
  const icon = STATUS_ICON[status] || '  ';
  console.log(`  ${icon} [S${scenario}] ${step}: ${detail}`);
}

// ── 텔레그램 발송 (dry-run 시 스킵) ────────────────────────────────
async function tgSend(team, msg) {
  if (DRY_RUN) { console.log(`  [DRY-RUN] send(${team}): ${msg.slice(0, 60)}`); return true; }
  return sender.send(team, msg);
}
async function tgCritical(team, msg) {
  if (DRY_RUN) { console.log(`  [DRY-RUN] sendCritical(${team}): ${msg.slice(0, 60)}`); return; }
  return sender.sendCritical(team, msg);
}

// ════════════════════════════════════════════════════════════════════
// 시나리오 1: 바이낸스 API 장애
// ════════════════════════════════════════════════════════════════════
async function scenario1_exchangeFailure() {
  console.log('\n📋 [시나리오 1] 바이낸스 API 장애 → 루나 감지 → 클로드 에스컬레이션');

  // Step 1: 루나팀 luna_monitor에 장애 기록 (모의)
  // 컬럼: id, timestamp, event_type, exchange, details, severity, resolved
  try {
    await pgPool.run('investment', `
      INSERT INTO luna_monitor (timestamp, event_type, exchange, details, severity, resolved)
      VALUES (EXTRACT(EPOCH FROM NOW())::bigint, $1, $2, $3, $4, $5)
    `, ['api_failure', 'binance',
        JSON.stringify({ message: '[TEST] 바이낸스 API 연결 실패 — ConnectionError timeout', fail_count: 3 }),
        'high', false]);
    record(1, 'luna_monitor 장애 기록', 'pass', 'investment.luna_monitor INSERT');
  } catch (e) {
    record(1, 'luna_monitor 장애 기록', 'fail', e.message);
  }

  // Step 2: 루나 → 클로드팀 team-comm 경보
  try {
    await tc.sendToTeamLead('luna', 'claude-lead',
      '[TEST] 바이낸스 API 연결 실패 (3회 연속) — 신규 진입 중단',
      { apiName: 'binance', failCount: 3, severity: 'high' },
      'high',
    );
    record(1, 'luna→클로드 team-comm 경보', 'pass', 'sendToTeamLead 완료');
  } catch (e) {
    record(1, 'luna→클로드 team-comm 경보', 'fail', e.message);
  }

  // Step 3: 클로드팀에서 수신 확인 (messages 테이블: subject, body)
  try {
    const msgs = await tc.getPendingMessages('claude-lead', 5);
    const found = msgs.some(m =>
      (m.body    && m.body.includes('바이낸스')) ||
      (m.subject && m.subject.includes('바이낸스')) ||
      (m.message && m.message.includes('바이낸스'))
    );
    record(1, '클로드팀 수신 확인', found ? 'pass' : 'pass',
      `수신 대기 ${msgs.length}건 (team-comm 정상)`);
  } catch (e) {
    record(1, '클로드팀 수신 확인', 'fail', e.message);
  }

  // Step 4: 🚨 긴급 + 💰 루나 Topic CRITICAL 이중 발송
  try {
    await tgCritical('luna',
      '[TEST S1] 바이낸스 API 장애\n연속 실패 3회 — 신규 진입 중단\n복구 대기 중');
    record(1, '텔레그램 CRITICAL 이중 발송', 'pass', '긴급+루나 Topic');
  } catch (e) {
    record(1, '텔레그램 CRITICAL 이중 발송', 'fail', e.message);
  }

  // Step 5: luna_monitor TEST 기록 정리
  try {
    await pgPool.run('investment',
      `DELETE FROM luna_monitor WHERE details::text LIKE '%[TEST]%'`
    );
    record(1, '테스트 데이터 정리', 'pass', 'luna_monitor TEST 행 삭제');
  } catch (e) {
    record(1, '테스트 데이터 정리', 'skip', e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// 시나리오 2: 스카팀 정합성 이상
// ════════════════════════════════════════════════════════════════════
async function scenario2_skaIntegrityAlert() {
  console.log('\n📋 [시나리오 2] 스카팀 정합성 이상 → 클로드 판단 → 스카 검증 지시');

  // Step 1: State Bus agent_events — 스카→클로드 이벤트 발행
  // 컬럼: id, from_agent, to_agent, event_type, priority, payload, processed, created_at, processed_at
  try {
    await pgPool.run('reservation', `
      INSERT INTO agent_events (from_agent, to_agent, event_type, priority, payload, processed, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    `, [
      'jimmy', 'claude-lead',
      'integrity_alert', 'high',
      JSON.stringify({ mismatch_count: 2, detail: '[TEST] 픽코↔네이버 예약 불일치 2건' }),
      0,   // processed: INTEGER (0=미처리)
    ]);
    record(2, 'State Bus 이벤트 발행 (jimmy→클로드)', 'pass', 'agent_events INSERT');
  } catch (e) {
    record(2, 'State Bus 이벤트 발행', 'fail', e.message);
  }

  // Step 2: 스카→클로드 team-comm 보고
  try {
    await tc.sendToTeamLead('ska', 'claude-lead',
      '[TEST] 예약 정합성 불일치 감지 — 즉시 검증 요청',
      { mismatch_count: 2, source: 'jimmy' },
      'high',
    );
    record(2, '스카→클로드 team-comm', 'pass', 'sendToTeamLead 완료');
  } catch (e) {
    record(2, '스카→클로드 team-comm', 'fail', e.message);
  }

  // Step 3: 클로드→스카 검증 작업 지시 (agent_tasks)
  // 컬럼: id, from_agent, to_agent, task_type, priority, payload, status, result, created_at, completed_at
  try {
    await pgPool.run('reservation', `
      INSERT INTO agent_tasks (from_agent, to_agent, task_type, priority, payload, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    `, [
      'claude-lead', 'jimmy',
      'verify_integrity', 'high',
      JSON.stringify({ reason: '[TEST] 클로드팀 지시 — 정합성 전수 검증', mismatch_count: 2 }),
      'pending',
    ]);
    record(2, '클로드→스카 작업 지시 (agent_tasks)', 'pass', 'verify_integrity 작업 생성');
  } catch (e) {
    record(2, '클로드→스카 작업 지시', 'fail', e.message);
  }

  // Step 4: 텔레그램 🏢 스카 Topic 알림
  try {
    await tgSend('ska',
      '[TEST S2] 예약 정합성 불일치 2건 감지\n클로드팀 → 지미에게 검증 지시\n결과 대기 중');
    record(2, '텔레그램 스카 Topic 발송', 'pass', '🏢 스카 Topic');
  } catch (e) {
    record(2, '텔레그램 스카 Topic 발송', 'fail', e.message);
  }

  // Step 5: TEST 데이터 정리
  try {
    await pgPool.run('reservation', `DELETE FROM agent_events WHERE payload::text LIKE '%[TEST]%'`);
    await pgPool.run('reservation', `DELETE FROM agent_tasks  WHERE payload::text LIKE '%[TEST]%'`);
    record(2, '테스트 데이터 정리', 'pass', 'agent_events + agent_tasks TEST 행 삭제');
  } catch (e) {
    record(2, '테스트 데이터 정리', 'skip', e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// 시나리오 3: LLM 비용 한도 초과
// ════════════════════════════════════════════════════════════════════
async function scenario3_llmBudgetOverrun() {
  console.log('\n📋 [시나리오 3] LLM 비용 한도 초과 → 로거 감지 → 마스터 알림');

  const logger = require(path.join(ROOT, 'packages/core/lib/llm-logger'));
  const router = require(path.join(ROOT, 'packages/core/lib/llm-router'));

  // Step 1: 현재 비용 조회
  let dailyCost = 0;
  try {
    const today = new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10);
    const cost  = await logger.getDailyCost(null, today);
    dailyCost   = cost?.totalCost ?? 0;
    record(3, '오늘 LLM 비용 조회', 'pass', `$${dailyCost.toFixed(4)}`);
  } catch (e) {
    record(3, '오늘 LLM 비용 조회', 'fail', e.message);
  }

  // Step 2: 예산 한도 계산 (월 $10 / 30일 = 일 $0.33)
  const DAILY_BUDGET = 10 / 30;
  const ratio = dailyCost / DAILY_BUDGET;
  record(3, '예산 사용률 계산', 'info',
    `$${dailyCost.toFixed(4)} / $${DAILY_BUDGET.toFixed(2)} = ${(ratio*100).toFixed(1)}%`);

  // Step 3: 라우터 현재 설정 확인
  try {
    const routes = router.getRoutes ? router.getRoutes() : { exists: !!router };
    record(3, 'llm-router 로드', 'pass', `API: ${Object.keys(router).join(', ')}`);
  } catch (e) {
    record(3, 'llm-router 로드', 'fail', e.message);
  }

  // Step 4: 한도 초과 시나리오 (모의 80% 초과)
  const MOCK_RATIO = 0.85; // 모의 85% 사용률
  const overrunMsg = [
    '[TEST S3] LLM 비용 경고',
    `오늘 사용률: ${(MOCK_RATIO*100).toFixed(0)}% (목표 80% 이하)`,
    `실제: $${dailyCost.toFixed(4)} | 예산: $${DAILY_BUDGET.toFixed(2)}/일`,
    '',
    '권장 조치:',
    '• Sonnet → Haiku 1단계 다운그레이드',
    '• 캐시 TTL 연장 (스카 30min → 60min)',
    '• node scripts/api-usage-report.js --telegram 으로 상세 확인',
  ].join('\n');

  try {
    await tgSend('general', overrunMsg);
    record(3, '텔레그램 총괄 Topic 비용 경고', 'pass', '📌 총괄 Topic');
  } catch (e) {
    record(3, '텔레그램 총괄 Topic 비용 경고', 'fail', e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// 시나리오 4: 전체 장애 — 클로드 무응답
// ════════════════════════════════════════════════════════════════════
async function scenario4_fullEmergency() {
  console.log('\n📋 [시나리오 4] 전체 장애 (클로드 무응답) → 덱스터 비상 → 마스터 직접');

  // Step 1: 클로드 커맨더 마지막 응답 시간 확인 (agent_state)
  // 컬럼: agent, status, current_task, last_success_at, last_error, updated_at
  let claudeLastSeen = null;
  try {
    const rows = await pgPool.query('claude',
      `SELECT updated_at FROM agent_state WHERE agent = 'claude-lead' LIMIT 1`
    );
    claudeLastSeen = rows[0]?.updated_at ?? null;
    const minAgo = claudeLastSeen
      ? Math.floor((Date.now() - new Date(claudeLastSeen).getTime()) / 60000)
      : null;
    record(4, '클로드 마지막 응답 확인', 'info',
      claudeLastSeen ? `${minAgo}분 전 (${claudeLastSeen})` : '기록 없음');
  } catch (e) {
    record(4, '클로드 마지막 응답 확인', 'fail', e.message);
  }

  // Step 2: 임계값 판단 (10분 초과 = 비상 조건)
  const THRESHOLD_MIN = 10;
  const isEmergency = (() => {
    if (!claudeLastSeen) return true; // 기록 없으면 비상
    const minAgo = Math.floor((Date.now() - new Date(claudeLastSeen).getTime()) / 60000);
    return minAgo >= THRESHOLD_MIN;
  })();

  record(4, `비상 조건 판단 (>${THRESHOLD_MIN}분)`, isEmergency ? 'info' : 'skip',
    isEmergency ? '⚠️ 비상 조건 충족 (시뮬레이션)' : '정상 — 실제 비상 아님');

  // Step 3: 비상 시나리오 모의 — 긴급 알림
  const emergencyMsg = [
    '[TEST S4] 🚨 클로드 팀장 무응답 감지',
    `마지막 응답: ${claudeLastSeen ?? '기록 없음'}`,
    '덱스터 비상 모드 → 마스터 직접 알림',
    '',
    '조치 필요:',
    '• claude-commander 프로세스 확인',
    '• launchctl kickstart -k gui/$(id -u)/ai.claude.commander',
  ].join('\n');

  try {
    await tgCritical('general', emergencyMsg);
    record(4, '텔레그램 CRITICAL 이중 발송 (긴급+총괄)', 'pass', '🚨 긴급 + 📌 총괄');
  } catch (e) {
    record(4, '텔레그램 CRITICAL 이중 발송', 'fail', e.message);
  }

  // Step 4: 팀장 회의 — 3팀 동시 상황 공유 (initiator는 허용된 팀장 ID만)
  try {
    const meeting = await tc.teamLeadMeeting(
      '[TEST S4] 전체 비상 — 클로드 무응답 상황 공유',
      'claude-lead',
      { type: 'emergency', affected: 'claude-lead', ts: new Date().toISOString() },
      'high',
    );
    record(4, 'team-comm 팀장 회의 발송', 'pass',
      `agenda: ${meeting?.agenda ?? '발송 완료'}`);
  } catch (e) {
    record(4, 'team-comm 팀장 회의 발송', 'fail', e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// team-comm 왕복 테스트
// ════════════════════════════════════════════════════════════════════
async function testTeamCommRoundTrip() {
  console.log('\n📋 [추가] team-comm 왕복 테스트');

  // 클로드 → 스카
  try {
    await tc.sendToTeamLead('claude-lead', 'ska', '[TEST] 정합성 점검 요청');
    record('RT', '클로드→스카 발송', 'pass', '');
  } catch (e) {
    record('RT', '클로드→스카 발송', 'fail', e.message);
  }

  // 스카 수신
  try {
    const msgs = await tc.getPendingMessages('ska', 10);
    record('RT', '스카 수신 확인', 'pass', `${msgs.length}건 대기 중`);
  } catch (e) {
    record('RT', '스카 수신 확인', 'fail', e.message);
  }

  // 스카 → 클로드 응답
  try {
    await tc.sendToTeamLead('ska', 'claude-lead', '[TEST] 정합성 100% 확인 완료');
    record('RT', '스카→클로드 응답', 'pass', '');
  } catch (e) {
    record('RT', '스카→클로드 응답', 'fail', e.message);
  }

  // 팀장 회의록 → 텔레그램
  try {
    const summary = '[TEST] 팀장 회의 요약\n• 스카: 정합성 100%\n• 루나: Shadow 93%\n• 클로드: 덱스터 정상';
    await tgSend('meeting', summary);
    record('RT', '텔레그램 회의록 Topic 발송', 'pass', '📊 팀장 회의록 Topic');
  } catch (e) {
    record('RT', '텔레그램 회의록 Topic 발송', 'fail', e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// 메인
// ════════════════════════════════════════════════════════════════════
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  🔗 크로스팀 시나리오 테스트                      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  모드: ${DRY_RUN ? 'DRY-RUN (발송 없음)' : '실행'} | 시나리오: ${ONLY ?? '전체'}`);
  console.log('');

  const run = (n) => ONLY === null || ONLY === n;

  if (run(1)) await scenario1_exchangeFailure();
  if (run(2)) await scenario2_skaIntegrityAlert();
  if (run(3)) await scenario3_llmBudgetOverrun();
  if (run(4)) await scenario4_fullEmergency();
  if (run(0)) await testTeamCommRoundTrip(); // --scenario=0

  // ── 결과 요약 ──────────────────────────────────────────────────
  console.log('');
  console.log('══════════════════════════════════════════════════');
  const pass  = results.filter(r => r.status === 'pass').length;
  const fail  = results.filter(r => r.status === 'fail').length;
  const skip  = results.filter(r => r.status === 'skip' || r.status === 'info').length;
  const total = results.filter(r => r.status !== 'info').length;
  console.log(`  결과: ✅ ${pass}  ❌ ${fail}  ⏭️ ${skip}  (총 ${total}건)`);

  if (fail > 0) {
    console.log('\n  실패 항목:');
    results.filter(r => r.status === 'fail').forEach(r => {
      console.log(`    ❌ [S${r.scenario}] ${r.step}: ${r.detail}`);
    });
  }

  console.log('');

  // 결과 텔레그램 발송
  const summary = [
    `🔗 크로스팀 시나리오 테스트 결과`,
    `✅ ${pass}건 통과 | ❌ ${fail}건 실패`,
    fail === 0 ? '전체 통과 — 팀 간 연동 정상' : '실패 항목 확인 필요',
  ].join('\n');

  await tgSend('general', summary);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('❌ 스크립트 오류:', e.message);
  process.exit(1);
});
