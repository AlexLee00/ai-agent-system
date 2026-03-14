'use strict';

/**
 * bots/worker/src/worker-lead.js — 워커팀장 봇 (Phase 1)
 *
 * 텔레그램 명령어 처리:
 *   /worker       — 상태 + 도움말
 *   /companies    — 업체 목록 (master)
 *   /users        — 사용자 목록 (admin+)
 *   /approve      — 승인 대기 목록
 *   /approve {id} — 승인
 *   /reject {id} {reason} — 반려
 */

const path   = require('path');
const ROOT   = path.join(__dirname, '../../..');
const pgPool = require(path.join(ROOT, 'packages/core/lib/pg-pool'));
const sender = require(path.join(ROOT, 'packages/core/lib/telegram-sender'));
const { getSecret } = require('../lib/secrets');
const { ensureChatSchema, handleChatMessage } = require('../lib/chat-agent');

// ── Phase 2 봇 ────────────────────────────────────────────────────────
const emily  = require('./emily');
const noah   = require('./noah');
const oliver = require('./oliver');
const {
  handleCallback: handleApprovalCallback,
  approve: approveApprovalRequest,
  reject: rejectApprovalRequest,
} = require('../lib/approval');

const SCHEMA = 'worker';
const TOPIC  = getSecret('telegram_worker_topic_id') || null;

// ── 텔레그램 폴링 ─────────────────────────────────────────────────────
let _offset = 0;

async function _poll() {
  const token = getSecret('telegram_bot_token');
  if (!token) { console.warn('[worker-lead] telegram_bot_token 없음 — 폴링 스킵'); return; }

  try {
    const res  = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${_offset}&timeout=10&allowed_updates=["message","callback_query"]`,
      { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (!data.ok) return;

    for (const upd of data.result) {
      _offset = upd.update_id + 1;

      // 인라인 버튼 콜백 (승인/반려)
      if (upd.callback_query) {
        const cb   = upd.callback_query;
        const user = cb.from?.id ? await _getUser(cb.from.id) : null;
        if (user) {
          const reply = await handleApprovalCallback(cb.data, user);
          if (reply) {
            await _sendReply(token, cb.message.chat.id, reply, cb.message.message_thread_id);
          }
        }
        // 콜백 응답 (버튼 로딩 해제)
        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cb.id }),
        }).catch(() => {});
        continue;
      }

      const msg = upd.message;
      if (!msg?.text) continue;

      // 워커 Topic 메시지만 처리 (TOPIC 설정 시)
      if (TOPIC && msg.message_thread_id !== TOPIC) continue;

      const fromId = msg.from?.id;
      const text   = msg.text.trim();
      const reply  = await handleCommand(text, fromId);
      if (reply) await _sendReply(token, msg.chat.id, reply, msg.message_thread_id);
    }
  } catch { /* 폴링 오류 무시 */ }
}

async function _sendReply(token, chatId, text, threadId) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (threadId) body.message_thread_id = threadId;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
  } catch { /* 무시 */ }
}

// ── 사용자 인증 ──────────────────────────────────────────────────────
async function _getUser(telegramId) {
  return pgPool.get(SCHEMA,
    `SELECT * FROM worker.users WHERE telegram_id = $1 AND deleted_at IS NULL`, [telegramId]);
}

async function _getLatestTelegramSession(companyId, userId) {
  return pgPool.get(SCHEMA,
    `SELECT id
     FROM worker.chat_sessions
     WHERE company_id=$1 AND user_id=$2 AND channel='telegram' AND deleted_at IS NULL
     ORDER BY last_at DESC
     LIMIT 1`,
    [companyId, userId]);
}

async function _handleNaturalLanguage(text, user) {
  await ensureChatSchema();
  const latest = await _getLatestTelegramSession(user.company_id, user.id);
  const result = await handleChatMessage({
    text,
    sessionId: latest?.id || null,
    user,
    companyId: user.company_id,
    channel: 'telegram',
  });
  return result?.reply || '요청을 처리했지만 응답을 생성하지 못했습니다.';
}

// ── 명령어 처리 ──────────────────────────────────────────────────────
async function handleCommand(text, fromTelegramId) {
  const parts  = text.split(/\s+/);
  const cmd    = parts[0].toLowerCase();

  // Phase 2 봇 위임 (에밀리/노아/올리버)
  const PHASE2_CMDS = [
    '/doc_upload','/doc_list','/doc_search','/emily_report',              // 에밀리
    '/journal','/journal_list','/journal_edit','/journal_delete',         // 에밀리 업무일지
    '/checkin','/checkout','/attendance','/employee_list','/leave_request', // 노아
    '/sales_today','/sales_week','/sales_register','/sales_analysis',       // 올리버
  ];
  if (PHASE2_CMDS.includes(cmd)) {
    const user = fromTelegramId ? await _getUser(fromTelegramId) : null;
    if (!user) return '⚠️ 등록되지 않은 사용자입니다.';
    const ctx = { user };
    const args = parts.slice(1).join(' ');

    // 에밀리 명령어
    let reply = await emily.handleCommand(cmd, args, ctx);
    if (reply !== null) return reply;

    // 노아 명령어
    reply = await noah.handleCommand(cmd, args, ctx);
    if (reply !== null) return reply;

    // 올리버 명령어
    reply = await oliver.handleCommand(cmd, args, ctx);
    if (reply !== null) return reply;
  }

  const user = fromTelegramId ? await _getUser(fromTelegramId) : null;
  if (!user) return '⚠️ 등록되지 않은 사용자입니다.\n워커팀 웹(<code>http://localhost:4000</code>)에서 계정을 확인하세요.';

  if (!['/worker','/companies','/users','/approve','/reject'].includes(cmd)) {
    if (cmd.startsWith('/')) return null;
    return _handleNaturalLanguage(text, user);
  }

  try {
    if (cmd === '/worker') return _helpMessage(user);

    if (cmd === '/companies') {
      if (user.role !== 'master') return '⚠️ 마스터 전용 명령어입니다.';
      const rows = await pgPool.query(SCHEMA, `SELECT id, name FROM worker.companies WHERE deleted_at IS NULL ORDER BY name`);
      if (!rows.length) return '📋 등록된 업체가 없습니다.';
      return `📋 업체 목록 (${rows.length}개)\n` + rows.map(r => `  • <b>${r.name}</b> (<code>${r.id}</code>)`).join('\n');
    }

    if (cmd === '/users') {
      if (!['master','admin'].includes(user.role)) return '⚠️ 관리자 이상 전용 명령어입니다.';
      const where = user.role === 'master' ? '' : 'AND company_id=$1';
      const params = user.role === 'master' ? [] : [user.company_id];
      const rows = await pgPool.query(SCHEMA,
        `SELECT username, role, name FROM worker.users WHERE deleted_at IS NULL ${where} ORDER BY role, name LIMIT 20`, params);
      if (!rows.length) return '👥 사용자가 없습니다.';
      return `👥 사용자 목록\n` + rows.map(r => `  • <b>${r.name}</b> @${r.username} [${r.role}]`).join('\n');
    }

    if (cmd === '/approve') {
      if (!['master','admin'].includes(user.role)) return '⚠️ 관리자 이상 전용 명령어입니다.';

      // /approve {id} — 승인
      if (parts[1]) {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) return '⚠️ 올바른 승인 ID를 입력하세요.';
        const approval = await approveApprovalRequest({ requestId: id, approverId: user.id });
        if (!approval) return `⚠️ 승인 요청 #${id}을 찾을 수 없거나 이미 처리되었습니다.`;
        return `✅ 승인 완료 — #${id} [${approval.category}] ${approval.action}`;
      }

      // /approve — 대기 목록
      const where = user.role === 'master' ? '' : 'AND company_id=$1';
      const params = user.role === 'master' ? [] : [user.company_id];
      const rows = await pgPool.query(SCHEMA,
        `SELECT id, category, action, priority, created_at FROM worker.approval_requests WHERE status='pending' ${where} ORDER BY priority DESC, created_at ASC LIMIT 10`, params);
      if (!rows.length) return '✅ 대기 중인 승인 요청이 없습니다.';
      return `📋 승인 대기 목록 (${rows.length}건)\n` +
        rows.map(r => `  #${r.id} [${r.priority === 'urgent' ? '🔴' : '⚪'}${r.category}] ${r.action}`).join('\n') +
        '\n\n<code>/approve {ID}</code> 또는 <code>/reject {ID} {사유}</code>';
    }

    if (cmd === '/reject') {
      if (!['master','admin'].includes(user.role)) return '⚠️ 관리자 이상 전용 명령어입니다.';
      const id     = parseInt(parts[1], 10);
      const reason = parts.slice(2).join(' ');
      if (isNaN(id) || !reason) return '⚠️ 사용법: <code>/reject {ID} {반려 사유}</code>';
      const approval = await rejectApprovalRequest({ requestId: id, approverId: user.id, reason });
      if (!approval) return `⚠️ 승인 요청 #${id}을 찾을 수 없거나 이미 처리되었습니다.`;
      return `❌ 반려 완료 — #${id} [${approval.category}] ${approval.action}\n사유: ${reason}`;
    }
  } catch (e) {
    console.error('[worker-lead] 명령 처리 오류:', e.message);
    return '❌ 처리 중 오류가 발생했습니다.';
  }

  return null;
}

function _helpMessage(user) {
  const lines = [
    `💼 워커팀 (Phase 2)`,
    `══════════════════`,
    `역할: <b>${user.role}</b> | ${user.name}`,
    ``,
    `📌 기본 명령어:`,
    `  /worker       — 이 도움말`,
    `  /approve      — 승인 대기 목록`,
    `  /approve {ID} — 승인`,
    `  /reject {ID} {사유} — 반려`,
    ``,
    `📎 에밀리 (문서/업무일지):`,
    `  /doc_upload   — 업로드 안내`,
    `  /doc_list     — 최근 문서`,
    `  /doc_search   — 검색`,
    `  /emily_report — 주간 리포트`,
    ``,
    `📝 업무일지:`,
    `  /journal {내용}          — 오늘 일지 등록`,
    `  /journal_list             — 이번 주 목록`,
    `  /journal_edit {ID} {내용} — 수정`,
    `  /journal_delete {ID}      — 삭제`,
    ``,
    `👥 노아 (인사):`,
    `  /checkin      — 출근 체크`,
    `  /checkout     — 퇴근 체크`,
    `  /attendance   — 오늘 근태`,
    `  /employee_list — 직원 목록`,
    `  /leave_request — 휴가 신청`,
    ``,
    `💰 올리버 (매출):`,
    `  /sales_today  — 오늘 매출`,
    `  /sales_week   — 주간 매출`,
    `  /sales_register — 매출 등록`,
    `  /sales_analysis — AI 분석`,
  ];
  if (['master','admin'].includes(user.role)) lines.push(``, `  /users        — 사용자 목록`);
  if (user.role === 'master') lines.push(`  /companies    — 업체 목록`);
  lines.push(``, `🌐 웹: <code>http://localhost:4000</code> (API)`, `🌐 대시보드: <code>http://localhost:4001</code>`);
  lines.push(``, `💬 자연어 예시:`, `  내일 오전 10시 김대리 업체 미팅 잡아줘`, `  오늘 일정 보여줘`, `  지난주 매출 보고서 만들어줘`);
  return lines.join('\n');
}

// ── 메인 루프 ─────────────────────────────────────────────────────────
async function main() {
  console.log('[worker-lead] 워커팀장 봇 가동');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await _poll();
    await new Promise(r => setTimeout(r, 2000));
  }
}

module.exports = { handleCommand };

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
