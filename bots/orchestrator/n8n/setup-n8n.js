'use strict';
/**
 * bots/orchestrator/n8n/setup-n8n.js
 *
 * n8n 최초 설정 스크립트
 * - PostgreSQL + Telegram 자격증명 생성
 * - 팀 제이 파일럿 워크플로우 3개 생성
 *
 * 실행: node bots/orchestrator/n8n/setup-n8n.js
 */

const http   = require('http');
const https  = require('https');
const path   = require('path');
const fs     = require('fs');

const N8N_BASE = 'http://localhost:5678';
const EMAIL    = '***REMOVED***';
const PASSWORD = 'TeamJay2026!';

const SECRETS_PATH = path.join(__dirname, '../../../bots/reservation/secrets.json');
const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));

const BOT_TOKEN = secrets.telegram_bot_token;
const CHAT_ID   = String(secrets.telegram_group_id);
const TOPICS    = secrets.telegram_topic_ids || {};

// ─── HTTP 유틸 ──────────────────────────────────────────────────────────────

let _cookie = '';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 5678,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}),
        ...(_cookie ? { Cookie: _cookie } : {}),
      },
    };
    const req = http.request(opts, res => {
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        _cookie = setCookie.map(c => c.split(';')[0]).join('; ');
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── 로그인 ──────────────────────────────────────────────────────────────────

async function login() {
  const r = await request('POST', '/rest/login', {
    emailOrLdapLoginId: EMAIL,
    password: PASSWORD,
  });
  if (r.status !== 200) throw new Error(`로그인 실패: ${JSON.stringify(r.body)}`);
  console.log('  ✅ n8n 로그인 성공');
}

// ─── 자격증명 생성 ─────────────────────────────────────────────────────────

async function createCredential(name, type, data) {
  // 이미 있으면 스킵
  const list = await request('GET', '/rest/credentials');
  if (list.body?.data?.find(c => c.name === name)) {
    console.log(`  ⏭️  자격증명 "${name}" 이미 존재 — 스킵`);
    const existing = list.body.data.find(c => c.name === name);
    return existing.id;
  }

  const r = await request('POST', '/rest/credentials', { name, type, data });
  if (r.status !== 200) throw new Error(`자격증명 생성 실패: ${JSON.stringify(r.body)}`);
  console.log(`  ✅ 자격증명 생성: "${name}" (id: ${r.body.data?.id})`);
  return r.body.data?.id;
}

// ─── 워크플로우 생성 ────────────────────────────────────────────────────────

async function createWorkflow(workflow) {
  // 이름 중복 체크
  const list = await request('GET', '/rest/workflows');
  if (list.body?.data?.find(w => w.name === workflow.name)) {
    console.log(`  ⏭️  워크플로우 "${workflow.name}" 이미 존재 — 스킵`);
    return;
  }

  const r = await request('POST', '/rest/workflows', workflow);
  if (r.status !== 200) throw new Error(`워크플로우 생성 실패: ${JSON.stringify(r.body)}`);
  console.log(`  ✅ 워크플로우 생성: "${workflow.name}" (id: ${r.body.data?.id})`);

  // 워크플로우 활성화
  const id = r.body.data?.id;
  if (id) {
    await request('PATCH', `/rest/workflows/${id}`, { active: true });
    console.log(`  ✅ 워크플로우 활성화: "${workflow.name}"`);
  }
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔧 n8n 팀 제이 파일럿 설정 시작\n');

  await login();

  // ── 자격증명 생성 ─────────────────────────────────────────────────────────
  console.log('\n[1] 자격증명 설정...');

  const pgCredId = await createCredential('Team Jay PostgreSQL', 'postgres', {
    host:     'localhost',
    port:     5432,
    database: 'jay',
    user:     process.env.USER || 'alexlee',
    password: '',
    ssl:      false,
    sshTunnel: false,
  });

  const tgCredId = await createCredential('Team Jay Telegram', 'telegramApi', {
    accessToken: BOT_TOKEN,
  });

  // ── 워크플로우 생성 ──────────────────────────────────────────────────────
  console.log('\n[2] 워크플로우 생성...');

  // 2-1. 일간 시스템 상태 리포트
  await createWorkflow({
    name: '일간 시스템 상태 리포트',
    active: true,
    nodes: [
      {
        id: 'trigger-daily',
        name: '매일 08:00',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [240, 300],
        parameters: {
          rule: { interval: [{ field: 'hours', hoursInterval: 24 }] },
          triggerAtHour: 8,
          triggerAtMinute: 0,
          timezone: 'Asia/Seoul',
        },
      },
      {
        id: 'query-dexter',
        name: '덱스터 최신 점검',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [460, 200],
        parameters: {
          operation: 'select',
          schema: { __rl: true, value: 'reservation', mode: 'name' },
          table:  { __rl: true, value: 'agent_events', mode: 'name' },
          where: { values: [{ column: 'from_agent', condition: 'equal', value: 'dexter' }] },
          sort:  { values: [{ column: 'created_at', direction: 'DESC' }] },
          limit: 1,
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'query-llm',
        name: 'LLM 비용 오늘',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [460, 350],
        parameters: {
          operation: 'executeQuery',
          query: "SELECT COALESCE(SUM(cost_usd),0) AS total_cost, COUNT(*) AS calls FROM reservation.llm_log WHERE created_at::date = CURRENT_DATE",
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'query-trades',
        name: '루나 오늘 거래',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [460, 500],
        parameters: {
          operation: 'executeQuery',
          query: "SELECT COUNT(*) AS trades, COALESCE(SUM(pnl_usdt),0) AS total_pnl FROM investment.trades WHERE created_at::date = CURRENT_DATE",
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'format-report',
        name: '리포트 포맷',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [680, 350],
        parameters: {
          jsCode: `
const dexterRow = $('덱스터 최신 점검').first().json;
const llmRow    = $('LLM 비용 오늘').first().json;
const tradeRow  = $('루나 오늘 거래').first().json;

const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const dexterStatus = dexterRow?.payload ? JSON.parse(dexterRow.payload)?.overall || '?' : '데이터 없음';
const llmCost  = parseFloat(llmRow?.total_cost || 0).toFixed(4);
const llmCalls = llmRow?.calls || 0;
const trades   = tradeRow?.trades || 0;
const pnl      = parseFloat(tradeRow?.total_pnl || 0).toFixed(2);

const icon = dexterStatus === 'ok' ? '✅' : dexterStatus === 'warn' ? '⚠️' : '❌';

return [{
  json: {
    text: \`📊 <b>일간 시스템 리포트</b>\\n📅 \${now}\\n\\n\` +
          \`\${icon} 덱스터 점검: \${dexterStatus?.toUpperCase() || 'N/A'}\\n\` +
          \`💰 LLM 비용: $\${llmCost} (\${llmCalls}건)\\n\` +
          \`💹 루나 거래: \${trades}건 / PnL: \${pnl} USDT\`
  }
}];
          `.trim(),
        },
      },
      {
        id: 'send-telegram-daily',
        name: '📌 총괄 토픽 발송',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [900, 350],
        parameters: {
          chatId: CHAT_ID,
          text:   '={{ $json.text }}',
          additionalFields: {
            parse_mode:       'HTML',
            message_thread_id: String(TOPICS.general || TOPICS.claude_lead || ''),
          },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
    ],
    connections: {
      '매일 08:00':    { main: [[{ node: '덱스터 최신 점검', type: 'main', index: 0 }, { node: 'LLM 비용 오늘', type: 'main', index: 0 }, { node: '루나 오늘 거래', type: 'main', index: 0 }]] },
      '덱스터 최신 점검': { main: [[{ node: '리포트 포맷', type: 'main', index: 0 }]] },
      'LLM 비용 오늘':  { main: [[{ node: '리포트 포맷', type: 'main', index: 0 }]] },
      '루나 오늘 거래':  { main: [[{ node: '리포트 포맷', type: 'main', index: 0 }]] },
      '리포트 포맷':    { main: [[{ node: '📌 총괄 토픽 발송', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  });

  // 2-2. CRITICAL 알림 에스컬레이션
  await createWorkflow({
    name: 'CRITICAL 알림 에스컬레이션',
    active: true,
    nodes: [
      {
        id: 'webhook-critical',
        name: 'CRITICAL 웹훅',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [240, 300],
        parameters: {
          httpMethod:      'POST',
          path:            'critical',
          responseMode:    'responseNode',
          responseCode:    200,
        },
        webhookId: 'team-jay-critical',
      },
      {
        id: 'check-severity',
        name: 'CRITICAL 여부',
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        position: [460, 300],
        parameters: {
          conditions: {
            options: { caseSensitive: false },
            conditions: [{ leftValue: '={{ $json.body?.severity }}', operator: { type: 'string', operation: 'equals' }, rightValue: 'critical' }],
          },
        },
      },
      {
        id: 'send-emergency',
        name: '🚨 긴급 토픽 발송',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [680, 200],
        parameters: {
          chatId: CHAT_ID,
          text:   '🚨 <b>CRITICAL 알림</b>\\n{{ $json.body?.message || $json.body?.label || "이슈 발생" }}\\n\\n{{ $json.body?.detail || "" }}',
          additionalFields: {
            parse_mode:       'HTML',
            message_thread_id: String(TOPICS.emergency || TOPICS.claude_lead || ''),
          },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
      {
        id: 'respond-ok',
        name: '응답',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1,
        position: [680, 400],
        parameters: { respondWith: 'json', responseBody: '{"ok":true}' },
      },
      {
        id: 'wait-5min',
        name: '5분 대기',
        type: 'n8n-nodes-base.wait',
        typeVersion: 1.1,
        position: [900, 200],
        parameters: { amount: 5, unit: 'minutes' },
      },
      {
        id: 'check-recovery',
        name: '복구 확인 조회',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [1120, 200],
        parameters: {
          operation: 'executeQuery',
          query: "SELECT id, payload FROM reservation.agent_events WHERE from_agent='doctor' AND event_type='recovery_completed' AND created_at > NOW() - INTERVAL '10 minutes' ORDER BY created_at DESC LIMIT 1",
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'check-recovered',
        name: '복구됐나?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        position: [1340, 200],
        parameters: {
          conditions: {
            conditions: [{ leftValue: '={{ $json.id }}', operator: { type: 'string', operation: 'exists' } }],
          },
        },
      },
      {
        id: 'send-dm',
        name: '마스터 DM 발송',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [1560, 300],
        parameters: {
          chatId: '***REMOVED***',
          text:   '⚠️ <b>미복구 CRITICAL</b>\\n5분 경과 후에도 복구 미확인\\n수동 점검이 필요합니다.',
          additionalFields: { parse_mode: 'HTML' },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
    ],
    connections: {
      'CRITICAL 웹훅':    { main: [[{ node: 'CRITICAL 여부', type: 'main', index: 0 }]] },
      'CRITICAL 여부':   { main: [
        [{ node: '🚨 긴급 토픽 발송', type: 'main', index: 0 }, { node: '응답', type: 'main', index: 0 }],
        [{ node: '응답', type: 'main', index: 0 }],
      ]},
      '🚨 긴급 토픽 발송': { main: [[{ node: '5분 대기', type: 'main', index: 0 }]] },
      '5분 대기':         { main: [[{ node: '복구 확인 조회', type: 'main', index: 0 }]] },
      '복구 확인 조회':   { main: [[{ node: '복구됐나?', type: 'main', index: 0 }]] },
      '복구됐나?':        { main: [[], [{ node: '마스터 DM 발송', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  });

  // 2-3. 주간 매매 성과 요약
  await createWorkflow({
    name: '주간 매매 성과 요약',
    active: true,
    nodes: [
      {
        id: 'trigger-weekly',
        name: '매주 일요일 20:00',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [240, 300],
        parameters: {
          rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [0] }] },
          triggerAtHour: 20,
          triggerAtMinute: 0,
          timezone: 'Asia/Seoul',
        },
      },
      {
        id: 'query-weekly-trades',
        name: '주간 거래 조회',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [460, 200],
        parameters: {
          operation: 'executeQuery',
          query: `SELECT
  COUNT(*) AS total_trades,
  COUNT(CASE WHEN pnl_usdt > 0 THEN 1 END) AS wins,
  COUNT(CASE WHEN pnl_usdt < 0 THEN 1 END) AS losses,
  COALESCE(SUM(pnl_usdt), 0) AS total_pnl,
  COALESCE(MAX(pnl_usdt), 0) AS best_trade,
  COALESCE(MIN(pnl_usdt), 0) AS worst_trade
FROM investment.trades
WHERE created_at > NOW() - INTERVAL '7 days'`,
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'query-performance',
        name: '주간 성과 조회',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [460, 420],
        parameters: {
          operation: 'executeQuery',
          query: `SELECT
  date,
  total_pnl,
  win_rate,
  total_trades
FROM investment.performance_daily
WHERE date > CURRENT_DATE - INTERVAL '7 days'
ORDER BY date ASC`,
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'format-weekly',
        name: '주간 성과 포맷',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [700, 300],
        parameters: {
          jsCode: `
const t = $('주간 거래 조회').first().json;
const total  = parseInt(t.total_trades || 0);
const wins   = parseInt(t.wins || 0);
const losses = parseInt(t.losses || 0);
const pnl    = parseFloat(t.total_pnl || 0).toFixed(2);
const best   = parseFloat(t.best_trade || 0).toFixed(2);
const worst  = parseFloat(t.worst_trade || 0).toFixed(2);
const wr     = total > 0 ? ((wins/total)*100).toFixed(1) : '0.0';
const pnlIcon = parseFloat(pnl) >= 0 ? '📈' : '📉';

return [{
  json: {
    text: \`💰 <b>주간 매매 성과 리포트</b>\\n\` +
          \`📅 \${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })} 기준 7일간\\n\\n\` +
          \`\${pnlIcon} 총 손익: <b>\${pnl} USDT</b>\\n\` +
          \`📊 거래: \${total}건 (승: \${wins} / 패: \${losses})\\n\` +
          \`🎯 승률: \${wr}%\\n\` +
          \`⬆️ 최고: +\${best} USDT\\n\` +
          \`⬇️ 최저: \${worst} USDT\`
  }
}];
          `.trim(),
        },
      },
      {
        id: 'send-weekly',
        name: '💰 루나 토픽 발송',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [920, 300],
        parameters: {
          chatId: CHAT_ID,
          text:   '={{ $json.text }}',
          additionalFields: {
            parse_mode:       'HTML',
            message_thread_id: String(TOPICS.luna || ''),
          },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
    ],
    connections: {
      '매주 일요일 20:00': { main: [[{ node: '주간 거래 조회', type: 'main', index: 0 }, { node: '주간 성과 조회', type: 'main', index: 0 }]] },
      '주간 거래 조회':    { main: [[{ node: '주간 성과 포맷', type: 'main', index: 0 }]] },
      '주간 성과 조회':    { main: [[{ node: '주간 성과 포맷', type: 'main', index: 0 }]] },
      '주간 성과 포맷':    { main: [[{ node: '💰 루나 토픽 발송', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  });

  console.log('\n✅ n8n 파일럿 설정 완료!');
  console.log('→ http://localhost:5678 에서 워크플로우 확인\n');
}

main().catch(e => { console.error('❌ 오류:', e.message); process.exit(1); });
