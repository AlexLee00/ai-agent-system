'use strict';

/**
 * packages/core/lib/team-comm.js — 팀장 간 소통 인터페이스
 *
 * State Bus(agent_events 테이블)를 통해 팀장끼리 메시지를 교환한다.
 * sessions_send 미구현 대체 구현 — State Bus 기반 비동기 메시지 큐.
 *
 * 팀장 ID:
 *   'ska'         — 스카팀 (스터디카페 예약·매출)
 *   'claude-lead' — 클로드팀 (시스템 개선·유지보수)
 *   'luna'        — 루나팀 (자동매매)
 *
 * 이벤트 타입:
 *   'team_message'  — 팀장 간 일반 메시지
 *   'team_meeting'  — 전체 팀장 회의 (브로드캐스트)
 *   'team_request'  — 타 팀에 협조 요청 (승인 필요 항목)
 *
 * 사용법:
 *   const tc = require('../../../packages/core/lib/team-comm');
 *
 *   // 메시지 전송
 *   await tc.sendToTeamLead('claude-lead', 'luna', 'API 장애 발생 — 진입 중단 권고', { apiName: 'binance' });
 *
 *   // 브로드캐스트 회의
 *   await tc.teamLeadMeeting('일일 현황 공유', 'ska', { revenue: 450000 });
 *
 *   // 수신 메시지 폴링
 *   const msgs = await tc.getPendingMessages('luna');
 *   for (const m of msgs) { console.log(m.message); await tc.ackTeamMessage(m.id); }
 */

const stateBus = require('../../../bots/reservation/lib/state-bus');

// 유효한 팀장 ID 목록
const TEAM_LEADS = ['ska', 'claude-lead', 'luna'];

/**
 * 팀장 ID 검증
 * @param {string} id
 * @throws {Error}
 */
function _validateTeamLead(id) {
  if (!TEAM_LEADS.includes(id)) {
    throw new Error(`유효하지 않은 팀장 ID: ${id}. 허용값: ${TEAM_LEADS.join(', ')}`);
  }
}

/**
 * 팀장에게 메시지 전송
 *
 * @param {string} from      - 발신 팀장 ID ('ska' | 'claude-lead' | 'luna')
 * @param {string} to        - 수신 팀장 ID
 * @param {string} message   - 전달할 텍스트 메시지
 * @param {object} [context] - 추가 컨텍스트 (JSON 직렬화 가능)
 * @param {string} [priority] - 'critical' | 'high' | 'normal' | 'low'
 * @returns {Promise<number>} 생성된 이벤트 ID
 */
async function sendToTeamLead(from, to, message, context = {}, priority = 'normal') {
  _validateTeamLead(from);
  _validateTeamLead(to);

  if (from === to) {
    throw new Error(`자기 자신에게 메시지 전송 불가: ${from}`);
  }

  const payload = {
    message,
    context: context || {},
    sentAt: new Date().toISOString(),
  };

  const eventId = await stateBus.emitEvent(from, to, 'team_message', payload, priority);
  console.log(`📨 [팀 소통] ${from} → ${to}: "${message.slice(0, 60)}${message.length > 60 ? '…' : ''}" (이벤트 #${eventId})`);
  return eventId;
}

/**
 * 전체 팀장 회의 (브로드캐스트)
 * 발신자를 제외한 모든 팀장에게 회의 안건을 전달한다.
 *
 * @param {string} agenda    - 회의 안건 텍스트
 * @param {string} initiator - 회의 소집 팀장 ID
 * @param {object} [data]    - 첨부 데이터 (JSON 직렬화 가능)
 * @param {string} [priority]
 * @returns {Promise<number[]>} 생성된 이벤트 ID 배열
 */
async function teamLeadMeeting(agenda, initiator, data = {}, priority = 'normal') {
  _validateTeamLead(initiator);

  const recipients = TEAM_LEADS.filter(id => id !== initiator);
  const payload = {
    agenda,
    data: data || {},
    initiator,
    sentAt: new Date().toISOString(),
  };

  const eventIds = await Promise.all(
    recipients.map(to => stateBus.emitEvent(initiator, to, 'team_meeting', payload, priority))
  );

  console.log(`🏛️  [팀 회의] ${initiator} → [${recipients.join(', ')}]: "${agenda.slice(0, 60)}${agenda.length > 60 ? '…' : ''}" (이벤트 ${eventIds.join(', ')})`);
  return eventIds;
}

/**
 * 타 팀에 협조 요청 전송
 * 마스터 승인이 필요한 범위의 요청에 사용 (예: 루나→스카 매출 데이터 요청)
 *
 * @param {string} from       - 요청 팀장 ID
 * @param {string} to         - 수신 팀장 ID
 * @param {string} requestType - 요청 종류 ('data_share' | 'system_support' | 'joint_task')
 * @param {string} description - 요청 설명
 * @param {object} [params]   - 요청 세부 파라미터
 * @returns {Promise<number>} 생성된 이벤트 ID
 */
async function requestFromTeamLead(from, to, requestType, description, params = {}) {
  _validateTeamLead(from);
  _validateTeamLead(to);

  const payload = {
    requestType,
    description,
    params: params || {},
    sentAt: new Date().toISOString(),
  };

  const eventId = await stateBus.emitEvent(from, to, 'team_request', payload, 'high');
  console.log(`🤝 [팀 요청] ${from} → ${to} [${requestType}]: "${description.slice(0, 60)}${description.length > 60 ? '…' : ''}" (이벤트 #${eventId})`);
  return eventId;
}

/**
 * 미처리 팀 메시지 조회
 * event_type이 'team_message' | 'team_meeting' | 'team_request'인 이벤트만 반환.
 *
 * @param {string} to     - 수신 팀장 ID
 * @param {number} [limit]
 * @returns {Promise<Array<{ id, from_agent, event_type, message, context, agenda, data, sentAt, priority }>>}
 */
async function getPendingMessages(to, limit = 20) {
  _validateTeamLead(to);

  const events = await stateBus.getUnprocessedEvents(to, limit * 2); // 여유있게 조회 후 필터
  const TEAM_EVENT_TYPES = ['team_message', 'team_meeting', 'team_request'];

  return events
    .filter(e => TEAM_EVENT_TYPES.includes(e.event_type))
    .slice(0, limit)
    .map(e => {
      let parsed = {};
      try { parsed = JSON.parse(e.payload || '{}'); } catch {}
      return {
        id:         e.id,
        from:       e.from_agent,
        to:         e.to_agent,
        eventType:  e.event_type,
        priority:   e.priority,
        createdAt:  e.created_at,
        // team_message 필드
        message:    parsed.message || null,
        context:    parsed.context || {},
        // team_meeting 필드
        agenda:     parsed.agenda || null,
        data:       parsed.data || {},
        initiator:  parsed.initiator || null,
        // team_request 필드
        requestType: parsed.requestType || null,
        description: parsed.description || null,
        params:      parsed.params || {},
        // 공통
        sentAt:     parsed.sentAt || e.created_at,
      };
    });
}

/**
 * 팀 메시지 처리 완료 표시 (ACK)
 *
 * @param {number} eventId
 * @returns {Promise<void>}
 */
async function ackTeamMessage(eventId) {
  await stateBus.markEventProcessed(eventId);
}

/**
 * 전체 팀장 상태 요약 조회
 * State Bus의 agent_state 기반
 *
 * @returns {Promise<Array<{ agent, status, currentTask, lastSuccessAt, lastError, updatedAt }>>}
 */
async function getTeamStatus() {
  const all = await stateBus.getAllAgentStates();
  return all
    .filter(s => TEAM_LEADS.includes(s.agent))
    .map(s => ({
      agent:         s.agent,
      status:        s.status,
      currentTask:   s.current_task,
      lastSuccessAt: s.last_success_at,
      lastError:     s.last_error,
      updatedAt:     s.updated_at,
    }));
}

module.exports = {
  TEAM_LEADS,
  sendToTeamLead,
  teamLeadMeeting,
  requestFromTeamLead,
  getPendingMessages,
  ackTeamMessage,
  getTeamStatus,
};
