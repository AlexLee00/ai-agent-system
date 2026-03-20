'use strict';
/**
 * bots/orchestrator/n8n/setup-ska-workflows.js
 *
 * 스카팀 매출 n8n 워크플로우 2개 생성
 *   SKA-WF-01: 일간 매출 요약 + AI 분석      (매일 22:00)
 *   SKA-WF-03: 주간 매출 트렌드 + AI 예측    (매주 월 09:00)
 *
 * ⚠️ 기존 launchd 스크립트 수정 없음 — SELECT 전용
 * 실행: node bots/orchestrator/n8n/setup-ska-workflows.js
 */

const http = require('http');
const path = require('path');
const fs   = require('fs');
const yaml = require('js-yaml');
const { createN8nSetupClient } = require('../../../packages/core/lib/n8n-setup-client');

const N8N_BASE = 'http://localhost:5678';
const EMAIL    = '***REMOVED***';
const PASSWORD = 'TeamJay2026!';

// ── secrets / config 로드 ──────────────────────────────────────────────────
const SECRETS_PATH = path.join(__dirname, '../../../bots/reservation/secrets.json');
const INVEST_CFG   = path.join(__dirname, '../../../bots/investment/config.yaml');

const secrets    = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
const investCfg  = yaml.load(fs.readFileSync(INVEST_CFG, 'utf8'));

const CHAT_ID    = String(secrets.telegram_group_id);
const TOPICS     = secrets.telegram_topic_ids || {};
const SKA_TOPIC  = String(TOPICS.ska  || '');
const GEN_TOPIC  = String(TOPICS.general || TOPICS.claude_lead || '');

const GEMINI_KEY = investCfg.gemini?.api_key || '';
const client = createN8nSetupClient({ email: EMAIL, password: PASSWORD, logger: console });

// ── HTTP 유틸 ──────────────────────────────────────────────────────────────
let _cookie = '';

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 5678,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}),
        ...(_cookie ? { Cookie: _cookie } : {}),
      },
    };
    const req = http.request(opts, res => {
      const sc = res.headers['set-cookie'];
      if (sc) _cookie = sc.map(c => c.split(';')[0]).join('; ');
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

// ── 로그인 ─────────────────────────────────────────────────────────────────
async function login() {
  await client.login();
}

// ── 기존 자격증명 ID 조회 ──────────────────────────────────────────────────
async function getCredentialId(name) {
  try {
    return await client.getCredentialId(name);
  } catch {
    throw new Error(`자격증명 "${name}" 없음 — setup-n8n.js 먼저 실행`);
  }
}

// ── 워크플로우 생성 ────────────────────────────────────────────────────────
async function createWorkflow(workflow) {
  await client.createOrReplaceWorkflow(workflow);
}

async function removeWorkflowByName(name) {
  const existing = (await client.listWorkflows()).find((item) => item.name === name);
  if (!existing?.id) return false;

  const deactivate = await client.request('POST', `/rest/workflows/${existing.id}/deactivate`);
  if (deactivate.status === 200) {
    console.log(`  ⏸️ 워크플로우 비활성화: "${name}" (id: ${existing.id})`);
  }

  const archive = await client.request('POST', `/rest/workflows/${existing.id}/archive`);
  if (archive.status === 200) {
    console.log(`  📦 워크플로우 아카이브: "${name}" (id: ${existing.id})`);
  }

  const removed = await client.request('DELETE', `/rest/workflows/${existing.id}`);
  if (removed.status !== 200) {
    throw new Error(`워크플로우 삭제 실패: ${name}`);
  }
  console.log(`  🗑️ 기존 워크플로우 삭제: "${name}" (id: ${existing.id})`);
  return true;
}

// ── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏢 스카팀 매출 n8n 워크플로우 설정 시작\n');

  await login();

  // 기존 자격증명 재사용
  console.log('\n[1] 기존 자격증명 조회...');
  const pgCredId = await getCredentialId('Team Jay PostgreSQL');
  const tgCredId = await getCredentialId('Team Jay Telegram');

  console.log('\n[2] 워크플로우 생성...');

  console.log('\n[2-A] 불필요한 매출 급감 경보 워크플로우 정리...');
  await removeWorkflowByName('SKA-WF-02 예약 매출 선행 감지');
  await removeWorkflowByName('SKA-WF-02 매출 이상 감지');

  // ════════════════════════════════════════════════════════════════════════
  // SKA-WF-01: 일간 매출 요약 + AI 분석 (매일 22:00)
  // 테이블: reservation.daily_summary (date TEXT, total_amount, pickko_total, general_revenue, entries_count)
  // ════════════════════════════════════════════════════════════════════════
  await createWorkflow({
    name: 'SKA-WF-01 일간 매출 요약',
    active: true,
    nodes: [
      {
        id: 'ska01-trigger',
        name: '매일 22:00',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [240, 300],
        parameters: {
          rule: { interval: [{ field: 'hours', hoursInterval: 24 }] },
          triggerAtHour: 22,
          triggerAtMinute: 0,
          timezone: 'Asia/Seoul',
        },
      },
      {
        id: 'ska01-today',
        name: '오늘 매출',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [460, 300],
        parameters: {
          operation: 'executeQuery',
          query: `SELECT
  COALESCE(total_amount, 0)      AS total,
  COALESCE(entries_count, 0)     AS cnt,
  COALESCE(pickko_total, 0)      AS pickko,
  COALESCE(general_revenue, 0)   AS general,
  COALESCE(pickko_study_room, 0) AS study_room
FROM reservation.daily_summary
WHERE date = TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')`,
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'ska01-yesterday',
        name: '전일 매출',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [680, 300],
        parameters: {
          operation: 'executeQuery',
          query: `SELECT COALESCE(total_amount, 0) AS total
FROM reservation.daily_summary
WHERE date = TO_CHAR(CURRENT_DATE - 1, 'YYYY-MM-DD')`,
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'ska01-lastweek',
        name: '전주 동요일 매출',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [900, 300],
        parameters: {
          operation: 'executeQuery',
          query: `SELECT COALESCE(total_amount, 0) AS total
FROM reservation.daily_summary
WHERE date = TO_CHAR(CURRENT_DATE - 7, 'YYYY-MM-DD')`,
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'ska01-calc',
        name: '변동률 계산',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1120, 300],
        parameters: {
          jsCode: `
const today    = $('오늘 매출').first().json;
const yest     = $('전일 매출').first().json;
const lastWeek = $('전주 동요일 매출').first().json;

const todayTotal = Number(today.total)    || 0;
const yesterTotal= Number(yest.total)     || 0;
const lwTotal    = Number(lastWeek.total) || 0;
const cnt        = Number(today.cnt)      || 0;
const pickko     = Number(today.pickko)   || 0;
const general    = Number(today.general)  || 0;
const studyRoom  = Number(today.study_room) || 0;

const dayChange  = yesterTotal > 0 ? ((todayTotal - yesterTotal) / yesterTotal * 100).toFixed(1) : null;
const weekChange = lwTotal     > 0 ? ((todayTotal - lwTotal)     / lwTotal     * 100).toFixed(1) : null;

const absDay = dayChange !== null ? Math.abs(parseFloat(dayChange)) : 0;
const alert  = absDay > 20 ? 'HIGH' : 'NORMAL';

return [{ json: { todayTotal, yesterTotal, lwTotal, cnt, pickko, general, studyRoom, dayChange, weekChange, alert } }];
          `.trim(),
        },
      },
      {
        id: 'ska01-if',
        name: '이상 여부',
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        position: [1340, 300],
        parameters: {
          conditions: {
            options: { caseSensitive: false },
            conditions: [
              { leftValue: '={{ $json.alert }}', operator: { type: 'string', operation: 'equals' }, rightValue: 'HIGH' },
            ],
          },
        },
      },
      {
        id: 'ska01-tg-alert',
        name: '🏢 스카 이상 알림',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [1560, 200],
        parameters: {
          chatId: CHAT_ID,
          text: `={{
'📊 <b>스카 매출 요약</b>\\n' +
'═══════════════════\\n' +
'오늘: ' + Number($json.todayTotal).toLocaleString('ko-KR') + '원 (' + $json.cnt + '건)\\n' +
'  픽코: ' + Number($json.pickko).toLocaleString('ko-KR') + '원' +
  ($json.studyRoom > 0 ? ' (스터디룸: ' + Number($json.studyRoom).toLocaleString('ko-KR') + '원)' : '') + '\\n' +
'  일반: ' + Number($json.general).toLocaleString('ko-KR') + '원\\n' +
'\\n전일 대비: ' + ($json.dayChange !== null ? ($json.dayChange > 0 ? '📈 +' : '📉 ') + $json.dayChange + '%' : 'N/A (전일 데이터 없음)') + '\\n' +
'전주 동요일 대비: ' + ($json.weekChange !== null ? ($json.weekChange > 0 ? '📈 +' : '📉 ') + $json.weekChange + '%' : 'N/A') + '\\n' +
'\\n⚠️ <b>전일 대비 20%+ 변동!</b>'
}}`,
          additionalFields: {
            parse_mode: 'HTML',
            message_thread_id: SKA_TOPIC,
          },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
      {
        id: 'ska01-tg-normal',
        name: '🏢 스카 일반 리포트',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [1560, 400],
        parameters: {
          chatId: CHAT_ID,
          text: `={{
'📊 <b>스카 매출 요약</b>\\n' +
'═══════════════════\\n' +
'오늘: ' + Number($json.todayTotal).toLocaleString('ko-KR') + '원 (' + $json.cnt + '건)\\n' +
'  픽코: ' + Number($json.pickko).toLocaleString('ko-KR') + '원' +
  ($json.studyRoom > 0 ? ' (스터디룸: ' + Number($json.studyRoom).toLocaleString('ko-KR') + '원)' : '') + '\\n' +
'  일반: ' + Number($json.general).toLocaleString('ko-KR') + '원\\n' +
'\\n전일 대비: ' + ($json.dayChange !== null ? ($json.dayChange > 0 ? '📈 +' : '📉 ') + $json.dayChange + '%' : 'N/A (전일 데이터 없음)') + '\\n' +
'전주 동요일 대비: ' + ($json.weekChange !== null ? ($json.weekChange > 0 ? '📈 +' : '📉 ') + $json.weekChange + '%' : 'N/A')
}}`,
          additionalFields: {
            parse_mode: 'HTML',
            message_thread_id: SKA_TOPIC,
          },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
    ],
    connections: {
      '매일 22:00':       { main: [[{ node: '오늘 매출',        type: 'main', index: 0 }]] },
      '오늘 매출':        { main: [[{ node: '전일 매출',        type: 'main', index: 0 }]] },
      '전일 매출':        { main: [[{ node: '전주 동요일 매출', type: 'main', index: 0 }]] },
      '전주 동요일 매출': { main: [[{ node: '변동률 계산',      type: 'main', index: 0 }]] },
      '변동률 계산':      { main: [[{ node: '이상 여부',        type: 'main', index: 0 }]] },
      '이상 여부':        { main: [
        [{ node: '🏢 스카 이상 알림',   type: 'main', index: 0 }],
        [{ node: '🏢 스카 일반 리포트', type: 'main', index: 0 }],
      ]},
    },
    settings: {},
  });

  // ════════════════════════════════════════════════════════════════════════
  // SKA-WF-03: 주간 매출 트렌드 + AI 예측 (매주 월 09:00)
  // ════════════════════════════════════════════════════════════════════════
  await createWorkflow({
    name: 'SKA-WF-03 주간 매출 트렌드',
    active: true,
    nodes: [
      {
        id: 'ska03-trigger',
        name: '매주 월 09:00',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [240, 300],
        parameters: {
          rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1] }] },
          triggerAtHour: 9,
          triggerAtMinute: 0,
          timezone: 'Asia/Seoul',
        },
      },
      {
        id: 'ska03-daily',
        name: '최근 28일 일별 매출',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [460, 300],
        parameters: {
          operation: 'executeQuery',
          query: `SELECT
  date,
  EXTRACT(DOW FROM date::date) AS dow,
  COALESCE(total_amount, 0)    AS daily_total,
  COALESCE(entries_count, 0)   AS cnt
FROM reservation.daily_summary
WHERE date::date >= CURRENT_DATE - 28
  AND date::date < CURRENT_DATE
ORDER BY date`,
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'ska03-weekly',
        name: '주별 합계',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [680, 300],
        parameters: {
          operation: 'executeQuery',
          query: `SELECT
  date_trunc('week', date::date)::date AS week_start,
  COALESCE(SUM(total_amount), 0)       AS weekly_total,
  COALESCE(SUM(entries_count), 0)      AS weekly_cnt,
  ROUND(AVG(total_amount)::numeric, 0) AS avg_daily
FROM reservation.daily_summary
WHERE date::date >= CURRENT_DATE - 28
  AND date::date < CURRENT_DATE
GROUP BY date_trunc('week', date::date)
ORDER BY week_start`,
        },
        credentials: { postgres: { id: pgCredId, name: 'Team Jay PostgreSQL' } },
      },
      {
        id: 'ska03-trend',
        name: '트렌드 분석',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [900, 300],
        parameters: {
          jsCode: `
const dailyData  = $('최근 28일 일별 매출').all().map(r => r.json);
const weeklyData = $('주별 합계').all().map(r => r.json);

// 요일별 평균 (0=일, 1=월 ... 6=토)
const dowNames = ['일','월','화','수','목','금','토'];
const dowBucket = {};
dailyData.forEach(d => {
  const k = String(Math.round(Number(d.dow)));
  if (!dowBucket[k]) dowBucket[k] = [];
  dowBucket[k].push(Number(d.daily_total));
});
const dowSummary = Object.entries(dowBucket)
  .sort(([a],[b]) => Number(a)-Number(b))
  .map(([dow, amounts]) => ({
    day: dowNames[Number(dow)] || dow,
    avg: Math.round(amounts.reduce((a,b)=>a+b,0) / amounts.length),
  }));

// 주별 추세
const weekTrend = weeklyData.map((w, i) => {
  const prev = i > 0 ? Number(weeklyData[i-1].weekly_total) : null;
  const curr = Number(w.weekly_total);
  return {
    week:  'W' + (i + 1),
    start: w.week_start,
    total: curr,
    cnt:   Number(w.weekly_cnt),
    change: prev !== null && prev > 0
      ? ((curr - prev) / prev * 100).toFixed(1)
      : null,
  };
});

// 최고 매출 요일
const topDow = [...dowSummary].sort((a,b)=>b.avg-a.avg)[0];

// 최근 주 vs 4주전 증감
const first = weeklyData[0] ? Number(weeklyData[0].weekly_total) : 0;
const last  = weeklyData[weeklyData.length-1] ? Number(weeklyData[weeklyData.length-1].weekly_total) : 0;
const overallTrend = first > 0 ? ((last - first) / first * 100).toFixed(1) : '0';

return [{ json: { weekTrend, dowSummary, topDow, overallTrend } }];
          `.trim(),
        },
      },
      {
        id: 'ska03-ai',
        name: 'Gemini AI 분석',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [1120, 300],
        parameters: {
          method: 'POST',
          url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
          sendHeaders: true,
          headerParameters: {
            parameters: [{ name: 'Content-Type', value: 'application/json' }],
          },
          sendBody: true,
          contentType: 'raw',
          rawContentType: 'application/json',
          body: `={{ JSON.stringify({
  contents: [{
    parts: [{
      text: '스터디카페 매출 데이터를 분석해줘. 한국어로 4줄 이내로 간결하게.\\n\\n' +
        '주별 추세: ' + JSON.stringify($json.weekTrend) + '\\n' +
        '요일별 평균(원): ' + JSON.stringify($json.dowSummary) + '\\n' +
        '4주 전 대비 전체 변화율: ' + $json.overallTrend + '%\\n\\n' +
        '1. 매출 추세 (증가/감소/유지)\\n' +
        '2. 가장 매출 높은 요일과 이유 추측\\n' +
        '3. 이번 주 예상 매출 범위\\n' +
        '4. 주의사항 또는 기회'
    }]
  }]
}) }}`,
          options: { timeout: 15000 },
        },
      },
      {
        id: 'ska03-report',
        name: '리포트 조합',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1340, 300],
        parameters: {
          jsCode: `
const trend  = $('트렌드 분석').first().json;
const aiBody = $('Gemini AI 분석').first().json;

const aiText = aiBody?.candidates?.[0]?.content?.parts?.[0]?.text
  || '분석 불가 (Gemini 오류)';

const fmt = n => Number(n).toLocaleString('ko-KR');

const weekLines = trend.weekTrend.map(w =>
  '  ' + w.week + ' (' + w.start + '): ' + fmt(w.total) + '원' +
  (w.change !== null ? ' (' + (w.change > 0 ? '+' : '') + w.change + '%)' : '')
).join('\\n');

const dowLines = trend.dowSummary.map(d =>
  '  ' + d.day + ': ' + fmt(d.avg) + '원 평균'
).join('\\n');

const report =
  '📊 <b>스카 주간 매출</b>\\n' +
  '═══════════════════\\n\\n' +
  '■ 주별 추이 (4주)\n' + weekLines + '\\n\\n' +
  '■ 요일별 평균\\n' + dowLines + '\\n' +
  '  → 최고: ' + (trend.topDow?.day || '?') + '요일 (평균 ' + fmt(trend.topDow?.avg || 0) + '원)\\n\\n' +
  '■ AI 분석 (Gemini)\\n' + aiText;

return [{ json: { report } }];
          `.trim(),
        },
      },
      {
        id: 'ska03-tg-ska',
        name: '🏢 스카 토픽 발송',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [1560, 300],
        parameters: {
          chatId: CHAT_ID,
          text: '={{ $json.report }}',
          additionalFields: {
            parse_mode: 'HTML',
            message_thread_id: SKA_TOPIC,
          },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
      {
        id: 'ska03-tg-general',
        name: '📌 총괄 토픽 발송',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [1780, 300],
        parameters: {
          chatId: CHAT_ID,
          text: '={{ $json.report }}',
          additionalFields: {
            parse_mode: 'HTML',
            message_thread_id: GEN_TOPIC || SKA_TOPIC,
          },
        },
        credentials: { telegramApi: { id: tgCredId, name: 'Team Jay Telegram' } },
      },
    ],
    connections: {
      '매주 월 09:00':       { main: [[{ node: '최근 28일 일별 매출', type: 'main', index: 0 }]] },
      '최근 28일 일별 매출': { main: [[{ node: '주별 합계',            type: 'main', index: 0 }]] },
      '주별 합계':           { main: [[{ node: '트렌드 분석',          type: 'main', index: 0 }]] },
      '트렌드 분석':         { main: [[{ node: 'Gemini AI 분석',       type: 'main', index: 0 }]] },
      'Gemini AI 분석':      { main: [[{ node: '리포트 조합',          type: 'main', index: 0 }]] },
      '리포트 조합':         { main: [[{ node: '🏢 스카 토픽 발송',   type: 'main', index: 0 }]] },
      '🏢 스카 토픽 발송':  { main: [[{ node: '📌 총괄 토픽 발송',   type: 'main', index: 0 }]] },
    },
    settings: {},
  });

  console.log('\n✅ 스카팀 n8n 워크플로우 2개 설정 완료\n');
  console.log('  SKA-WF-01: 일간 매출 요약 + AI 분석  (매일 22:00)');
  console.log('  SKA-WF-03: 주간 매출 트렌드 + Gemini  (매주 월 09:00)');
  console.log('\n📌 테이블: reservation.daily_summary + reservation.room_revenue (SELECT 전용)');
}

main().catch(err => {
  console.error('\n❌ 오류:', err.message);
  process.exit(1);
});
