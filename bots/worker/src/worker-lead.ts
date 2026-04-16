import path from 'node:path';

const ROOT = path.join(__dirname, '../../..');
const env = require(path.join(ROOT, 'packages/core/lib/env'));
const pgPool = require(path.join(ROOT, 'packages/core/lib/pg-pool'));
const sender = require(path.join(ROOT, 'packages/core/lib/telegram-sender'));
const { initHubConfig } = require(path.join(ROOT, 'packages/core/lib/llm-keys'));
const { initHubSecrets, getSecret } = require('../lib/secrets');
const { getWorkerLeadRuntimeConfig } = require('../lib/runtime-config');
const { ensureChatSchema, handleChatMessage } = require('../lib/chat-agent');

const emily = require('./emily');
const noah = require('./noah');
const oliver = require('./oliver');
const {
  handleCallback: handleApprovalCallback,
  approve: approveApprovalRequest,
  reject: rejectApprovalRequest,
} = require('../lib/approval');

const SCHEMA = 'worker';
const TOPIC = getSecret('telegram_worker_topic_id') || null;
const leadRuntimeConfig = getWorkerLeadRuntimeConfig();
const DEFAULT_POLL_MS = Number(leadRuntimeConfig.defaultPollMs || 2000);
const NO_TOKEN_POLL_MS = Number(leadRuntimeConfig.noTokenPollMs || 30000);
const TELEGRAM_LONG_POLL_SECONDS = Number(leadRuntimeConfig.telegramLongPollSeconds || 10);
const TELEGRAM_REQUEST_TIMEOUT_MS = Number(leadRuntimeConfig.telegramRequestTimeoutMs || 15000);

let offset = 0;
let missingTokenLogged = false;

async function poll(): Promise<{ sleepMs: number }> {
  const token = getSecret('telegram_bot_token');
  if (!token) {
    if (!missingTokenLogged) {
      if (!env.IS_OPS) {
        console.log('[worker-lead] telegram_bot_token 없음 — 텔레그램 폴링 비활성');
      }
      missingTokenLogged = true;
    }
    return { sleepMs: NO_TOKEN_POLL_MS };
  }

  if (missingTokenLogged) {
    console.log('[worker-lead] telegram_bot_token 감지 — 텔레그램 폴링 재개');
    missingTokenLogged = false;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${TELEGRAM_LONG_POLL_SECONDS}&allowed_updates=["message","callback_query"]`,
      { signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS) },
    );
    const data = await response.json() as { ok?: boolean; result?: any[] };
    if (!data.ok || !Array.isArray(data.result)) return { sleepMs: DEFAULT_POLL_MS };

    for (const update of data.result) {
      offset = Number(update.update_id || 0) + 1;

      if (update.callback_query) {
        const callbackQuery = update.callback_query;
        const user = callbackQuery.from?.id ? await getUser(callbackQuery.from.id) : null;
        if (user) {
          const reply = await handleApprovalCallback(callbackQuery.data, user);
          if (reply) {
            await sendReply(callbackQuery.message.chat.id, reply, callbackQuery.message.message_thread_id);
          }
        }
        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackQuery.id }),
        }).catch(() => {});
        continue;
      }

      const message = update.message;
      if (!message?.text) continue;
      if (TOPIC && message.message_thread_id !== TOPIC) continue;

      const fromId = message.from?.id;
      const text = String(message.text).trim();
      const reply = await handleCommand(text, fromId);
      if (reply) await sendReply(message.chat.id, reply, message.message_thread_id);
    }
  } catch {
    return { sleepMs: DEFAULT_POLL_MS };
  }

  return { sleepMs: DEFAULT_POLL_MS };
}

async function sendReply(chatId: number | string, text: string, threadId?: number | null): Promise<void> {
  try {
    await sender.sendDirect(chatId, text, {
      threadId,
      parseMode: 'HTML',
      disableWebPagePreview: true,
    });
  } catch {}
}

async function getUser(telegramId: number | string): Promise<any> {
  return pgPool.get(
    SCHEMA,
    'SELECT * FROM worker.users WHERE telegram_id = $1 AND deleted_at IS NULL',
    [telegramId],
  );
}

async function getLatestTelegramSession(companyId: string, userId: string): Promise<any> {
  return pgPool.get(
    SCHEMA,
    `SELECT id
     FROM worker.chat_sessions
     WHERE company_id=$1 AND user_id=$2 AND channel='telegram' AND deleted_at IS NULL
     ORDER BY last_at DESC
     LIMIT 1`,
    [companyId, userId],
  );
}

async function handleNaturalLanguage(text: string, user: any): Promise<string> {
  await ensureChatSchema();
  const latest = await getLatestTelegramSession(user.company_id, user.id);
  const result = await handleChatMessage({
    text,
    sessionId: latest?.id || null,
    user,
    companyId: user.company_id,
    channel: 'telegram',
  });
  return result?.reply || '요청을 처리했지만 응답을 생성하지 못했습니다.';
}

export async function handleCommand(text: string, fromTelegramId?: number | string | null): Promise<string | null> {
  const parts = text.split(/\s+/);
  const command = String(parts[0] || '').toLowerCase();

  const phase2Commands = [
    '/doc_upload', '/doc_list', '/doc_search', '/emily_report',
    '/journal', '/journal_list', '/journal_edit', '/journal_delete',
    '/checkin', '/checkout', '/attendance', '/employee_list', '/leave_request',
    '/sales_today', '/sales_week', '/sales_register', '/sales_analysis',
  ];

  if (phase2Commands.includes(command)) {
    const user = fromTelegramId ? await getUser(fromTelegramId) : null;
    if (!user) return '⚠️ 등록되지 않은 사용자입니다.';
    const context = { user };
    const args = parts.slice(1).join(' ');

    let reply = await emily.handleCommand(command, args, context);
    if (reply !== null) return reply;

    reply = await noah.handleCommand(command, args, context);
    if (reply !== null) return reply;

    reply = await oliver.handleCommand(command, args, context);
    if (reply !== null) return reply;
  }

  const user = fromTelegramId ? await getUser(fromTelegramId) : null;
  if (!user) {
    return '⚠️ 등록되지 않은 사용자입니다.\n워커팀 웹(<code>http://localhost:4000</code>)에서 계정을 확인하세요.';
  }

  if (!['/worker', '/companies', '/users', '/approve', '/reject'].includes(command)) {
    if (command.startsWith('/')) return null;
    return handleNaturalLanguage(text, user);
  }

  try {
    if (command === '/worker') return helpMessage(user);

    if (command === '/companies') {
      if (user.role !== 'master') return '⚠️ 마스터 전용 명령어입니다.';
      const rows = await pgPool.query(
        SCHEMA,
        'SELECT id, name FROM worker.companies WHERE deleted_at IS NULL ORDER BY name',
      );
      if (!rows.length) return '📋 등록된 업체가 없습니다.';
      return `📋 업체 목록 (${rows.length}개)\n${rows.map((row: any) => `  • <b>${row.name}</b> (<code>${row.id}</code>)`).join('\n')}`;
    }

    if (command === '/users') {
      if (!['master', 'admin'].includes(user.role)) return '⚠️ 관리자 이상 전용 명령어입니다.';
      const where = user.role === 'master' ? '' : 'AND company_id=$1';
      const params = user.role === 'master' ? [] : [user.company_id];
      const rows = await pgPool.query(
        SCHEMA,
        `SELECT username, role, name FROM worker.users WHERE deleted_at IS NULL ${where} ORDER BY role, name LIMIT 20`,
        params,
      );
      if (!rows.length) return '👥 사용자가 없습니다.';
      return `👥 사용자 목록\n${rows.map((row: any) => `  • <b>${row.name}</b> @${row.username} [${row.role}]`).join('\n')}`;
    }

    if (command === '/approve') {
      if (!['master', 'admin'].includes(user.role)) return '⚠️ 관리자 이상 전용 명령어입니다.';

      if (parts[1]) {
        const id = parseInt(parts[1] || '', 10);
        if (Number.isNaN(id)) return '⚠️ 올바른 승인 ID를 입력하세요.';
        const approval = await approveApprovalRequest({
          requestId: id,
          approverId: user.id,
          approverRole: user.role,
          approverCompanyId: user.company_id,
        });
        if (!approval) return `⚠️ 승인 요청 #${id}을 찾을 수 없거나 이미 처리되었습니다.`;
        return `✅ 승인 완료 — #${id} [${approval.category}] ${approval.action}`;
      }

      const where = user.role === 'master' ? '' : 'AND company_id=$1';
      const params = user.role === 'master' ? [] : [user.company_id];
      const rows = await pgPool.query(
        SCHEMA,
        `SELECT id, category, action, priority, created_at FROM worker.approval_requests WHERE status='pending' ${where} ORDER BY priority DESC, created_at ASC LIMIT 10`,
        params,
      );
      if (!rows.length) return '✅ 대기 중인 승인 요청이 없습니다.';
      return `📋 승인 대기 목록 (${rows.length}건)\n${rows.map((row: any) => `  #${row.id} [${row.priority === 'urgent' ? '🔴' : '⚪'}${row.category}] ${row.action}`).join('\n')}\n\n<code>/approve {ID}</code> 또는 <code>/reject {ID} {사유}</code>`;
    }

    if (command === '/reject') {
      if (!['master', 'admin'].includes(user.role)) return '⚠️ 관리자 이상 전용 명령어입니다.';
      const id = parseInt(parts[1] || '', 10);
      const reason = parts.slice(2).join(' ');
      if (Number.isNaN(id) || !reason) return '⚠️ 사용법: <code>/reject {ID} {반려 사유}</code>';
      const approval = await rejectApprovalRequest({
        requestId: id,
        approverId: user.id,
        reason,
        approverRole: user.role,
        approverCompanyId: user.company_id,
      });
      if (!approval) return `⚠️ 승인 요청 #${id}을 찾을 수 없거나 이미 처리되었습니다.`;
      return `❌ 반려 완료 — #${id} [${approval.category}] ${approval.action}\n사유: ${reason}`;
    }
  } catch (error) {
    console.error('[worker-lead] 명령 처리 오류:', error instanceof Error ? error.message : String(error));
    return '❌ 처리 중 오류가 발생했습니다.';
  }

  return null;
}

function helpMessage(user: any): string {
  const lines = [
    '💼 워커팀 (Phase 2)',
    '══════════════════',
    `역할: <b>${user.role}</b> | ${user.name}`,
    '',
    '📌 기본 명령어:',
    '  /worker       — 이 도움말',
    '  /approve      — 승인 대기 목록',
    '  /approve {ID} — 승인',
    '  /reject {ID} {사유} — 반려',
    '',
    '📎 에밀리 (문서/업무일지):',
    '  /doc_upload   — 업로드 안내',
    '  /doc_list     — 최근 문서',
    '  /doc_search   — 검색',
    '  /emily_report — 주간 리포트',
    '',
    '📝 업무일지:',
    '  /journal {내용}          — 오늘 일지 등록',
    '  /journal_list             — 이번 주 목록',
    '  /journal_edit {ID} {내용} — 수정',
    '  /journal_delete {ID}      — 삭제',
    '',
    '👥 노아 (인사):',
    '  /checkin      — 출근 체크',
    '  /checkout     — 퇴근 체크',
    '  /attendance   — 오늘 근태',
    '  /employee_list — 직원 목록',
    '  /leave_request — 휴가 신청',
    '',
    '💰 올리버 (매출):',
    '  /sales_today  — 오늘 매출',
    '  /sales_week   — 주간 매출',
    '  /sales_register — 매출 등록',
    '  /sales_analysis — AI 분석',
  ];
  if (['master', 'admin'].includes(user.role)) lines.push('', '  /users        — 사용자 목록');
  if (user.role === 'master') lines.push('  /companies    — 업체 목록');
  lines.push('', '🌐 웹: <code>http://localhost:4000</code> (API)', '🌐 대시보드: <code>http://localhost:4001</code>');
  lines.push('', '💬 자연어 예시:', '  내일 오전 10시 김대리 업체 미팅 잡아줘', '  오늘 일정 보여줘', '  지난주 매출 보고서 만들어줘');
  return lines.join('\n');
}

async function main(): Promise<void> {
  await initHubSecrets();
  await initHubConfig();
  console.log('[worker-lead] 워커팀장 봇 가동');
  for (;;) {
    const result = await poll();
    const sleepMs = result?.sleepMs || DEFAULT_POLL_MS;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
