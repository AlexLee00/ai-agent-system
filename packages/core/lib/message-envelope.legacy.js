'use strict';

/**
 * packages/core/lib/message-envelope.js — 봇 간 구조화 메시지 포맷
 *
 * 모든 봇 간 메시지는 이 포맷을 따른다.
 * State Bus, agent_events, 텔레그램 알림 모두 이 구조 사용.
 *
 * 사용법:
 *   const { createMessage, createReply, createApprovalRequest } = require('./message-envelope');
 *   const msg = createMessage('alert', 'dexter', 'claude-lead', { issue: '서버 다운' }, { priority: 'critical' });
 *   const reply = createReply(msg, 'task_result', 'claude-lead', { status: 'ok' });
 */

const crypto = require('crypto');

const MESSAGE_TYPES = [
  'task_request',      // 작업 요청
  'task_result',       // 작업 완료
  'task_failed',       // 작업 실패
  'handoff_request',   // 팀 간 위임
  'handoff_complete',  // 위임 완료
  'approval_required', // 승인 필요
  'approval_granted',  // 승인 완료
  'approval_denied',   // 승인 거부
  'alert',             // 알림/경고
  'status_update',     // 상태 업데이트
  'heartbeat',         // 생존 확인
];

const PRIORITIES = ['low', 'normal', 'high', 'critical'];

/**
 * 메시지 생성
 * @param {string} type - MESSAGE_TYPES 중 하나
 * @param {string} from - 발신 봇 (예: 'dexter', 'luna')
 * @param {string} to - 수신 봇 (예: 'claude-lead', 'master', 'broadcast')
 * @param {object} payload - 메시지 내용
 * @param {object} [options] - 추가 옵션
 * @returns {object} MessageEnvelope
 */
function createMessage(type, from, to, payload, options = {}) {
  if (!MESSAGE_TYPES.includes(type)) {
    console.warn(`[MessageEnvelope] 알 수 없는 type: ${type}`);
  }
  if (options.priority && !PRIORITIES.includes(options.priority)) {
    console.warn(`[MessageEnvelope] 알 수 없는 priority: ${options.priority}`);
  }

  return {
    message_id:     crypto.randomUUID(),
    trace_id:       options.trace_id || crypto.randomUUID(),
    run_id:         options.run_id || null,
    task_id:        options.task_id || null,
    from_bot:       from,
    to_bot:         to,
    message_type:   type,
    timestamp:      new Date().toISOString(),
    state_version:  options.state_version || 1,
    correlation_id: options.correlation_id || null,
    priority:       options.priority || 'normal',
    requires_ack:   options.requires_ack || false,
    payload,
  };
}

/**
 * 응답 메시지 생성 (원본 메시지의 trace_id/correlation_id 자동 연결)
 * @param {object} originalMessage - 원본 MessageEnvelope
 * @param {string} type - 응답 메시지 타입
 * @param {string} from - 발신 봇
 * @param {object} payload - 응답 내용
 * @param {object} [options] - 추가 옵션
 */
function createReply(originalMessage, type, from, payload, options = {}) {
  return createMessage(type, from, originalMessage.from_bot, payload, {
    trace_id:       originalMessage.trace_id,
    run_id:         originalMessage.run_id,
    task_id:        originalMessage.task_id,
    correlation_id: originalMessage.message_id,
    state_version:  (originalMessage.state_version || 0) + 1,
    ...options,
  });
}

/**
 * 승인 요청 메시지 생성 (마스터에게)
 * @param {string} from - 요청 봇
 * @param {object} payload - 승인 내용
 */
function createApprovalRequest(from, payload) {
  return createMessage('approval_required', from, 'master', {
    action_name:      payload.action_name,
    target_resource:  payload.target_resource || '',
    reason:           payload.reason || '',
    impact_summary:   payload.impact_summary || '',
    reversible:       payload.reversible !== undefined ? payload.reversible : true,
    proposed_args:    payload.proposed_args || {},
    ...payload,
  }, {
    priority:     'high',
    requires_ack: true,
    trace_id:     payload.trace_id,
  });
}

/**
 * 알림 레벨 변환 (MessageEnvelope priority → mainbot_queue alert_level)
 */
function priorityToAlertLevel(priority) {
  const map = { low: 1, normal: 1, high: 2, critical: 3 };
  return map[priority] || 1;
}

module.exports = {
  MESSAGE_TYPES,
  PRIORITIES,
  createMessage,
  createReply,
  createApprovalRequest,
  priorityToAlertLevel,
};
