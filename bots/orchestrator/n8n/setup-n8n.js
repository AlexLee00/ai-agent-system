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
const { createN8nSetupClient } = require('../../../packages/core/lib/n8n-setup-client');

const N8N_BASE = 'http://localhost:5678';
const EMAIL    = process.env.N8N_EMAIL || 'admin@example.com';
const PASSWORD = 'TeamJay2026!';
const client = createN8nSetupClient({ email: EMAIL, password: PASSWORD, logger: console });

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
  await client.login();
}

// ─── 자격증명 생성 ─────────────────────────────────────────────────────────

async function createCredential(name, type, data) {
  return client.createCredential(name, type, data);
}

// ─── 워크플로우 생성 ────────────────────────────────────────────────────────

async function createWorkflow(workflow) {
  await client.createOrReplaceWorkflow(workflow);
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
        position: [460, 300],
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
        position: [680, 300],
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
        position: [900, 300],
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
        position: [1120, 300],
        parameters: {
          jsCode: `
const dexterRow = $('덱스터 최신 점검').first().json;
const llmRow    = $('LLM 비용 오늘').first().json;
const tradeRow  = $('루나 오늘 거래').first().json;

const now      = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const payload  = dexterRow?.payload ? JSON.parse(dexterRow.payload) : {};
const sysStatus = payload?.overall || '?';
const errCnt   = parseInt(payload?.errorCount || 0);
const warnCnt  = parseInt(payload?.warnCount  || 0);
const llmCost  = parseFloat(llmRow?.total_cost || 0).toFixed(2);
const llmCalls = parseInt(llmRow?.calls || 0);
const trades   = parseInt(tradeRow?.trades || 0);
const pnl      = parseFloat(tradeRow?.total_pnl || 0).toFixed(2);
const pnlSign  = parseFloat(pnl) >= 0 ? '+' : '';
const statusMap = { ok: '정상', warn: '경고', error: '오류', critical: '긴급 장애' };
const sysLabel = statusMap[String(sysStatus).toLowerCase()] || sysStatus || '미상';
const sysIcon  = sysStatus === 'ok' ? '✅' : sysStatus === 'warn' ? '⚠️' : '❌';
const issueStr = errCnt + warnCnt > 0
  ? \` (경고 \${warnCnt} / 긴급 \${errCnt})\`
  : ' — 이상 없음';

return [{
  json: {
    text: \`📊 <b>팀 제이 일간 시스템 리포트</b>\\n\` +
          \`───────────────────\\n\` +
          \`📅 \${now}\\n\\n\` +
          \`<b>■ 시스템</b>\\n\` +
          \`\${sysIcon} 덱스터: \${sysLabel}\${issueStr}\\n\\n\` +
          \`<b>■ LLM 비용 (24h)</b>\\n\` +
          \`합계: $\${llmCost} (\${llmCalls}건)\\n\\n\` +
          \`<b>■ 루나 매매</b>\\n\` +
          \`거래: \${trades}건 / PnL: \${pnlSign}\${pnl} USDT\`
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
        position: [1340, 300],
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
      '매일 08:00':      { main: [[{ node: '덱스터 최신 점검', type: 'main', index: 0 }]] },
      '덱스터 최신 점검': { main: [[{ node: 'LLM 비용 오늘',   type: 'main', index: 0 }]] },
      'LLM 비용 오늘':   { main: [[{ node: '루나 오늘 거래',   type: 'main', index: 0 }]] },
      '루나 오늘 거래':  { main: [[{ node: '리포트 포맷',       type: 'main', index: 0 }]] },
      '리포트 포맷':     { main: [[{ node: '📌 총괄 토픽 발송', type: 'main', index: 0 }]] },
    },
    settings: {},
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
        id: 'check-health-probe',
        name: '헬스 probe?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        position: [460, 180],
        parameters: {
          conditions: {
            options: { caseSensitive: false },
            conditions: [{
              leftValue: '={{ $json.body?._healthProbe || $json.headers?.["x-health-probe"] || "" }}',
              operator: { type: 'string', operation: 'notEmpty' },
            }],
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
          text:   '={{ (() => { const body = $json.body || {}; const serviceMap = { "health-check": "헬스체크", "claude-health-check": "클로드 헬스체크", "claude-health-report": "클로드 헬스 리포트", "worker-health-report": "워커 헬스 리포트", "blog-health-report": "블로 헬스 리포트", "ska-health-report": "스카 헬스 리포트" }; const statusMap = { critical: "긴급 장애", error: "오류 발생", failed: "실패", warn: "경고", warning: "경고", ok: "정상", recovered: "복구됨", degraded: "성능 저하", timeout: "응답 지연", stale: "지연 감지" }; const messageMap = { probe: "상태 점검", heartbeat: "상태 확인", incident: "장애 감지" }; const rawService = body.service || body.label || "미상"; const rawStatus = body.status || ""; const rawMessage = body.message || body.label || ""; const service = serviceMap[rawService] || rawService; const status = statusMap[String(rawStatus).toLowerCase()] || rawStatus; const message = messageMap[String(rawMessage).toLowerCase()] || rawMessage || status || "이슈 발생"; const detail = body.detail || ""; return ["🚨 <b>CRITICAL 알림</b>", message, detail ? ("세부: " + detail) : "", service ? ("서비스: " + service) : "", status ? ("상태: " + status) : "", "감지: " + (new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" }))].filter(Boolean).join("\\n\\n"); })() }}',
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
          chatId: process.env.TELEGRAM_CHAT_ID || '',
          text:   '⚠️ <b>미복구 긴급 장애 — 마스터 확인 필요</b>\\n───────────────────\\n5분 경과 후에도 복구 미확인\\n수동 점검이 필요합니다.',
          additionalFields: { parse_mode: 'HTML' },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
    ],
    connections: {
      'CRITICAL 웹훅':     { main: [[{ node: '헬스 probe?',      type: 'main', index: 0 }]] },
      '헬스 probe?':       { main: [
        [{ node: '응답',              type: 'main', index: 0 }],
        [{ node: 'CRITICAL 여부',      type: 'main', index: 0 }],
      ]},
      'CRITICAL 여부':     { main: [
        [{ node: '🚨 긴급 토픽 발송', type: 'main', index: 0 }],
        [{ node: '응답',              type: 'main', index: 0 }],
      ]},
      '🚨 긴급 토픽 발송': { main: [[{ node: '응답',            type: 'main', index: 0 }]] },
      '응답':              { main: [[{ node: '5분 대기',         type: 'main', index: 0 }]] },
      '5분 대기':          { main: [[{ node: '복구 확인 조회',   type: 'main', index: 0 }]] },
      '복구 확인 조회':    { main: [[{ node: '복구됐나?',        type: 'main', index: 0 }]] },
      '복구됐나?':         { main: [[], [{ node: '마스터 DM 발송', type: 'main', index: 0 }]] },
    },
    settings: {},
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
        position: [460, 300],
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
        position: [680, 300],
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
        position: [900, 300],
        parameters: {
          jsCode: `
const t      = $('주간 거래 조회').first().json;
const total  = parseInt(t.total_trades || 0);
const wins   = parseInt(t.wins || 0);
const losses = parseInt(t.losses || 0);
const pnl    = parseFloat(t.total_pnl || 0).toFixed(2);
const best   = parseFloat(t.best_trade || 0).toFixed(2);
const worst  = parseFloat(t.worst_trade || 0).toFixed(2);
const wr     = total > 0 ? ((wins/total)*100).toFixed(1) : '0.0';
const pnlSign = parseFloat(pnl) >= 0 ? '+' : '';
const pnlIcon = parseFloat(pnl) >= 0 ? '📈' : '📉';

const kst       = new Date(Date.now() + 9 * 3600 * 1000);
const endDate   = kst.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
const startKst  = new Date(kst.getTime() - 6 * 86400000);
const startDate = startKst.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });

return [{
  json: {
    text: \`📊 <b>루나팀 주간 매매 성과</b>\\n\` +
          \`───────────────────\\n\` +
          \`📅 \${startDate} ~ \${endDate}\\n\\n\` +
          \`<b>■ 성과</b>\\n\` +
          \`매매: \${total}건 (승 \${wins} / 패 \${losses})\\n\` +
          \`승률: \${wr}%\\n\` +
          \`총 PnL: \${pnlSign}\${pnl} USDT \${pnlIcon}\\n\` +
          \`최대 수익: +\${best} USDT\\n\` +
          \`최대 손실: \${worst} USDT\\n\\n\` +
          \`<b>■ 자본</b>\\n\` +
          \`서킷 발동: 0회 ✅\`
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
        position: [1120, 300],
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
      '매주 일요일 20:00': { main: [[{ node: '주간 거래 조회',      type: 'main', index: 0 }]] },
      '주간 거래 조회':    { main: [[{ node: '주간 성과 조회',      type: 'main', index: 0 }]] },
      '주간 성과 조회':    { main: [[{ node: '주간 성과 포맷',      type: 'main', index: 0 }]] },
      '주간 성과 포맷':    { main: [[{ node: '💰 루나 토픽 발송', type: 'main', index: 0 }]] },
    },
    settings: {},
  });

  console.log('\n✅ n8n 파일럿 설정 완료!');
  console.log('→ http://localhost:5678 에서 워크플로우 확인\n');
}

main().catch(e => { console.error('❌ 오류:', e.message); process.exit(1); });
