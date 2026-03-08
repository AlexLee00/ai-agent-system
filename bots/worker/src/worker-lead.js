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

const SCHEMA = 'worker';
const TOPIC  = getSecret('telegram_worker_topic_id') || null;

// ── 텔레그램 폴링 ─────────────────────────────────────────────────────
let _offset = 0;

async function _poll() {
  const token = getSecret('telegram_bot_token');
  if (!token) { console.warn('[worker-lead] telegram_bot_token 없음 — 폴링 스킵'); return; }

  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${_offset}&timeout=10&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (!data.ok) return;

    for (const upd of data.result) {
      _offset = upd.update_id + 1;
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

// ── 명령어 처리 ──────────────────────────────────────────────────────
async function handleCommand(text, fromTelegramId) {
  const parts  = text.split(/\s+/);
  const cmd    = parts[0].toLowerCase();

  if (!['/worker','/companies','/users','/approve','/reject'].includes(cmd)) return null;

  const user = fromTelegramId ? await _getUser(fromTelegramId) : null;
  if (!user) return '⚠️ 등록되지 않은 사용자입니다.\n워커팀 웹(<code>http://localhost:4000</code>)에서 계정을 확인하세요.';

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
        const approval = await pgPool.get(SCHEMA,
          `UPDATE worker.approval_requests SET status='approved', approver_id=$1, approved_at=NOW(), updated_at=NOW()
           WHERE id=$2 AND status='pending' RETURNING *`, [user.id, id]);
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
      const approval = await pgPool.get(SCHEMA,
        `UPDATE worker.approval_requests SET status='rejected', approver_id=$1, reject_reason=$2, rejected_at=NOW(), updated_at=NOW()
         WHERE id=$3 AND status='pending' RETURNING *`, [user.id, reason, id]);
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
    `💼 워커팀 (Phase 1)`,
    `══════════════════`,
    `역할: <b>${user.role}</b> | ${user.name}`,
    ``,
    `📌 명령어:`,
    `  /worker       — 이 도움말`,
    `  /approve      — 승인 대기 목록`,
    `  /approve {ID} — 승인`,
    `  /reject {ID} {사유} — 반려`,
  ];
  if (['master','admin'].includes(user.role)) lines.push(`  /users        — 사용자 목록`);
  if (user.role === 'master') lines.push(`  /companies    — 업체 목록`);
  lines.push(``, `🌐 웹: <code>http://localhost:4000</code>`);
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
