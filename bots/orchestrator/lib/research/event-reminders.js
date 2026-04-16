'use strict';
/**
 * bots/orchestrator/lib/research/event-reminders.js
 * 팀 제이 주요 이벤트 알람 스케줄러
 * launchd로 매일 09:00 KST 실행
 */

const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');

// 이벤트 정의
const EVENTS = [
  // 다윈팀 모니터링 (04-07 ~ 04-13)
  { start: '2026-04-07', end: '2026-04-13', team: 'darwin', daily: true,
    message: '🔬 다윈팀 자율 연구 모니터링 D{day}/7\n06:00 스캔 결과 확인 + 메트릭 체크\nGREEN(수집80+/적합10~30%/저장95+) → Sprint 4' },

  // 다윈팀 Sprint 4 시작
  { start: '2026-04-14', end: '2026-04-14', team: 'darwin',
    message: '🔬 다윈팀 Sprint 4 시작일!\n모니터링 1주 판정 후 확대/조정/축소 결정\n크로스 도메인 인사이트 + 리포트 자동화' },

  // 블로팀 Phase B (04-07 ~ 04-11)
  { start: '2026-04-07', end: '2026-04-11', team: 'blog', daily: true,
    message: '📝 블로팀 Phase B 피드백 루프 D{day}/5\n경쟁 결과 확인 + 작가 성과 분석\n고용 조합 = 전략 선택!' },

  // 첫 경쟁 결과 (월수금)
  { start: '2026-04-07', end: '2026-04-07', team: 'general',
    message: '🏆 첫 경쟁 결과 확인일! (월요일)\nPhase 3 경쟁 활성화 후 첫 번째 결과\nDB에서 competition_results 조회' },
  { start: '2026-04-09', end: '2026-04-09', team: 'general',
    message: '🏆 경쟁 결과 확인 (수요일)\n2번째 경쟁 라운드 결과' },
  { start: '2026-04-11', end: '2026-04-11', team: 'general',
    message: '🏆 경쟁 결과 확인 (금요일)\n3번째 경쟁 라운드 결과 + 1주 종합' },

  // 알람 통일 운영 확인
  { start: '2026-04-07', end: '2026-04-07', team: 'claude',
    message: '📢 알람 통일 운영 확인\npostAlarm 단일 API 전환 후 첫 주\n전 팀 알람 정상 수신 확인' },

  // CC P0 운영 확인
  { start: '2026-04-08', end: '2026-04-08', team: 'claude',
    message: '⚡ CC P0 운영 확인\n연속 실패 제한 + Strict Write\nllm-fallback _providerFailures 동작 확인' },

  // Gemma 4 운영 상태 점검
  { start: '2026-04-14', end: '2026-04-14', team: 'general',
    message: '🔍 Gemma 4 운영 점검\n허브 runtime/select가 local gemma4:latest(e2b)를 반환하는지 확인\nblog/orchestrator/ska 파일럿 응답 성공 여부 재확인' },
];

function _getKSTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function _formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function run() {
  const today = _formatDate(_getKSTDate());
  console.log(`[event-reminders] ${today} 이벤트 체크`);

  let sent = 0;
  for (const evt of EVENTS) {
    if (today < evt.start || today > evt.end) continue;

    let message = evt.message;

    // 일일 이벤트: D{day} 치환
    if (evt.daily) {
      const startDate = new Date(evt.start);
      const todayDate = new Date(today);
      const day = Math.floor((todayDate - startDate) / 86400000) + 1;
      message = message.replace('{day}', day);
    }

    try {
      const result = await postAlarm({
        message: `⏰ 리마인더\n${message}`,
        team: evt.team,
        alertLevel: 1,
        fromBot: 'event-reminders',
      });
      if (result.ok) sent++;
      console.log(`[event-reminders] ${evt.team}: ${result.ok ? '✅' : '❌'}`);
    } catch (err) {
      console.warn(`[event-reminders] 전송 실패: ${err.message}`);
    }
  }

  console.log(`[event-reminders] 완료: ${sent}건 발송`);
  return { today, sent, total: EVENTS.length };
}

module.exports = { run, EVENTS };

if (require.main === module) {
  run().then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
