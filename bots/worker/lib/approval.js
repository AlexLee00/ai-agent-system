'use strict';
/**
 * bots/worker/lib/approval.js — 업무 승인 시스템
 *
 * 3단계 승인:
 *   자동승인:   근태 체크인/체크아웃
 *   관리자승인: 휴가 신청, 매출 수정
 *   마스터승인: 권한 변경, 업체 설정
 *
 * 텔레그램 인라인 버튼 발송 + 콜백 처리
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const { getSecret } = require('./secrets');

const SCHEMA     = 'worker';
const SEP_SINGLE = '───────────────';
const SEP_DOUBLE = '═══════════════';

// ── 승인 레벨 정의 ────────────────────────────────────────────────────

const APPROVAL_LEVELS = {
  checkin:        'auto',    // 자동
  checkout:       'auto',    // 자동
  leave_request:  'admin',   // 관리자
  sales_update:   'admin',   // 관리자
  role_change:    'master',  // 마스터
  company_config: 'master',  // 마스터
};

function getRequiredLevel(action) {
  return APPROVAL_LEVELS[action] || 'admin';
}

// ── 승인 요청 생성 ────────────────────────────────────────────────────

async function createRequest({
  companyId, requesterId, category, action,
  targetTable, targetId, payload, priority = 'normal',
}) {
  const level = getRequiredLevel(action);

  // 자동 승인 대상
  if (level === 'auto') {
    return { id: null, autoApproved: true };
  }

  const row = await pgPool.get(SCHEMA,
    `INSERT INTO worker.approval_requests
       (company_id, requester_id, category, action, target_table, target_id, payload, status, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING id`,
    [companyId, requesterId, category, action,
     targetTable, targetId || null, JSON.stringify(payload), priority]);

  return { id: row.id, autoApproved: false };
}

async function attachTarget({ requestId, targetId }) {
  return pgPool.get(SCHEMA,
    `UPDATE worker.approval_requests
     SET target_id=$2, updated_at=NOW()
     WHERE id=$1
     RETURNING id, target_id`,
    [requestId, targetId]);
}

async function _syncTargetStatus(req, nextStatus) {
  if (!req?.target_table || !req?.target_id) return;
  if (req.target_table !== 'agent_tasks') return;

  if (nextStatus === 'approved') {
    await pgPool.run(SCHEMA,
      `UPDATE worker.agent_tasks
       SET status='queued', updated_at=NOW()
       WHERE id=$1 AND approval_id=$2`,
      [req.target_id, req.id]);
    return;
  }

  if (nextStatus === 'rejected') {
    await pgPool.run(SCHEMA,
      `UPDATE worker.agent_tasks
       SET status='rejected', updated_at=NOW(), completed_at=NOW()
       WHERE id=$1 AND approval_id=$2`,
      [req.target_id, req.id]);
  }
}

// ── 승인 처리 ─────────────────────────────────────────────────────────

async function approve({ requestId, approverId, approverRole = 'member', approverCompanyId = null }) {
  const params = [requestId, approverId];
  let where = 'id=$1 AND status=\'pending\'';
  if (approverRole !== 'master') {
    params.push(approverCompanyId);
    where += ` AND company_id=$${params.length}`;
  }
  const req = await pgPool.get(SCHEMA,
    `UPDATE worker.approval_requests
     SET status='approved', approver_id=$2, approved_at=NOW(), updated_at=NOW()
     WHERE ${where} RETURNING *`,
    params);

  if (!req) throw new Error('요청을 찾을 수 없거나 이미 처리됨');
  await _syncTargetStatus(req, 'approved');
  return req;
}

async function reject({ requestId, approverId, reason, approverRole = 'member', approverCompanyId = null }) {
  const params = [requestId, approverId, reason || '반려'];
  let where = 'id=$1 AND status=\'pending\'';
  if (approverRole !== 'master') {
    params.push(approverCompanyId);
    where += ` AND company_id=$${params.length}`;
  }
  const req = await pgPool.get(SCHEMA,
    `UPDATE worker.approval_requests
     SET status='rejected', approver_id=$2, reject_reason=$3, rejected_at=NOW(), updated_at=NOW()
     WHERE ${where} RETURNING *`,
    params);

  if (!req) throw new Error('요청을 찾을 수 없거나 이미 처리됨');
  await _syncTargetStatus(req, 'rejected');
  return req;
}

// ── 대기 목록 ─────────────────────────────────────────────────────────

async function getPendingRequests({ companyId, limit = 10 }) {
  return pgPool.query(SCHEMA,
    `SELECT ar.*, u.name AS requester_name
     FROM worker.approval_requests ar
     LEFT JOIN worker.users u ON u.id = ar.requester_id
     WHERE ar.company_id=$1 AND ar.status='pending' AND ar.deleted_at IS NULL
     ORDER BY ar.priority DESC, ar.created_at ASC LIMIT $2`,
    [companyId, limit]);
}

// ── 텔레그램 인라인 버튼 발송 ────────────────────────────────────────

const ACTION_LABELS = {
  leave_request:  '휴가 신청',
  sales_update:   '매출 수정',
  role_change:    '권한 변경',
  company_config: '업체 설정',
};

function _buildApprovalText(requestId, action, requesterName, payload) {
  const p      = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
  const label  = ACTION_LABELS[action] || action;
  const lines  = [
    `📋 <b>${label} 승인 요청 #${requestId}</b>`,
    SEP_SINGLE,
    `신청자: ${requesterName || '알 수 없음'}`,
  ];

  // 휴가 신청 전용 상세
  if (action === 'leave_request') {
    if (p.date)   lines.push(`날짜: ${p.date}`);
    if (p.reason) lines.push(`사유: ${p.reason}`);
  } else {
    // 일반: payload 키-값 표시
    for (const [k, v] of Object.entries(p)) {
      if (!k.startsWith('_') && v != null) lines.push(`${k}: ${v}`);
    }
  }

  lines.push(SEP_SINGLE);
  return lines.join('\n');
}

async function sendApprovalRequest({ chatId, requestId, action, requesterName, payload }) {
  const token = getSecret('telegram_bot_token');
  if (!token || !chatId) return;

  const text = _buildApprovalText(requestId, action, requesterName, payload);
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ 승인', callback_data: `approve:${requestId}` },
      { text: '❌ 반려', callback_data: `reject:${requestId}` },
    ]],
  };

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard }),
    });
  } catch (e) {
    console.warn('[approval] 텔레그램 발송 실패:', e.message);
  }
}

// ── 텔레그램 콜백 쿼리 처리 ──────────────────────────────────────────

async function handleCallback(callbackData, callbackUser) {
  const [action, requestIdStr] = (callbackData || '').split(':');
  const requestId = parseInt(requestIdStr, 10);
  if (!requestId) return null;

  try {
    if (action === 'approve') {
      await approve({
        requestId,
        approverId: callbackUser.id,
        approverRole: callbackUser.role,
        approverCompanyId: callbackUser.company_id,
      });
      return `✅ 승인 완료 #${requestId}`;
    }
    if (action === 'reject') {
      await reject({
        requestId,
        approverId: callbackUser.id,
        reason: '반려',
        approverRole: callbackUser.role,
        approverCompanyId: callbackUser.company_id,
      });
      return `❌ 반려 완료 #${requestId}`;
    }
  } catch (e) {
    return `⚠️ 처리 실패: ${e.message}`;
  }

  return null;
}

module.exports = {
  getRequiredLevel,
  createRequest, attachTarget, approve, reject,
  getPendingRequests,
  sendApprovalRequest, handleCallback,
};
