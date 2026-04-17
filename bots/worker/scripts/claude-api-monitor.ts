// @ts-nocheck
'use strict';
/**
 * claude-api-monitor.js — Claude API 사용량 10분 모니터링
 *
 * 실행: node scripts/claude-api-monitor.js
 * launchd: ai.worker.claude-monitor (10분 주기)
 *
 * 모니터링 항목:
 *   1. claude-code-spawns.jsonl — 최근 1분 Claude Code CLI 호출 횟수
 *   2. token_usage DB — 최근 1분 Anthropic 유료 API 사용 (다른 봇)
 *   3. Anthropic Usage API — 오늘/이번 달 누적 사용량
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');

const kst    = require('../../../packages/core/lib/kst');
const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  buildNoticeEvent,
  renderNoticeEvent,
  publishEventPipeline,
  buildSeverityTargets,
} = require('../../../packages/core/lib/reporting-hub');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory.legacy.js');
const { buildWorkerCliInsight } = require('../lib/cli-insight.legacy');
const {
  canonicalizeWorkerCriticalAlert,
  appendIncidentLine,
} = require('../lib/critical-alerts.legacy');

const SPAWN_LOG   = path.join(os.homedir(), '.openclaw', 'workspace', 'logs', 'claude-code-spawns.jsonl');
const CONFIG_YAML = path.join(__dirname, '../../investment/config.yaml');
const monitorMemory = createAgentMemory({ agentId: 'worker.claude-api-monitor', team: 'worker' });

// ── 설정 ──────────────────────────────────────────────────────────────
const ALERT_THRESHOLD_SPAWNS = 3;    // 1분 내 Claude Code 3회 이상 → 알림
const ALERT_THRESHOLD_COST   = 0.01; // 1분 내 Anthropic 과금 $0.01 이상 → 알림
const WINDOW_MS = 1 * 60 * 1000;    // 1분

function buildMonitorFallbackInsight({ spawns, dbCost, hasAlert }) {
  if (hasAlert) {
    return `Claude 사용량이 임계 구간으로 올라와, 최근 spawn 급증과 Anthropic 과금 원인을 우선 점검해야 합니다.`;
  }
  return `최근 1분 Claude 사용량은 정상 범위이며, 추가 조치보다 추세 관찰이 적절합니다.`;
}

// ── config.yaml에서 ANTHROPIC_API_KEY 로드 ────────────────────────────
function loadApiKey() {
  try {
    const yaml = fs.readFileSync(CONFIG_YAML, 'utf8');
    const m = yaml.match(/^anthropic:\s*\n(?:.*\n)*?.*api_key:\s*"([^"]+)"/m);
    return m ? m[1] : process.env.ANTHROPIC_API_KEY || '';
  } catch { return process.env.ANTHROPIC_API_KEY || ''; }
}

function buildMonitorMemoryQuery(kind, extras = []) {
  return [
    'worker claude api monitor',
    kind,
    ...extras,
  ].filter(Boolean).join(' ');
}

// ── Anthropic Usage API ───────────────────────────────────────────────
function fetchAnthropicUsage(apiKey) {
  return new Promise((resolve) => {
    if (!apiKey) return resolve(null);
    const today = kst.today();
    const opts = {
      hostname: 'api.anthropic.com',
      path: `/v1/usage?start_date=${today}&end_date=${today}&granularity=day`,
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 8000,
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, raw: body.slice(0, 200) }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── 최근 N분 Claude Code 스폰 횟수 ───────────────────────────────────
function countRecentSpawns(windowMs = WINDOW_MS) {
  try {
    if (!fs.existsSync(SPAWN_LOG)) return 0;
    const now   = Date.now();
    const lines = fs.readFileSync(SPAWN_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.filter(l => {
      try { return (now - new Date(JSON.parse(l).ts).getTime()) <= windowMs; }
      catch { return false; }
    }).length;
  } catch { return 0; }
}

// ── DB — 최근 1분 Anthropic 유료 사용량 ─────────────────────────────
async function getRecentDbUsage() {
  try {
    const rows = await pgPool.query('claude', `
      SELECT
        bot_name, model,
        SUM(tokens_in)::integer  AS tokens_in,
        SUM(tokens_out)::integer AS tokens_out,
        SUM(cost_usd)::float     AS cost_usd,
        COUNT(*)::integer        AS calls
      FROM token_usage
      WHERE is_free = 0
        AND recorded_at >= NOW() - INTERVAL '1 minute'
      GROUP BY bot_name, model
      ORDER BY cost_usd DESC
    `);
    return rows;
  } catch { return []; }
}

// ── 메인 ─────────────────────────────────────────────────────────────
async function main() {
  const isAlert = process.argv.includes('--alert-only');
  const apiKey  = loadApiKey();

  const [spawns, dbRows, anthropicRes] = await Promise.all([
    Promise.resolve(countRecentSpawns()),
    getRecentDbUsage(),
    fetchAnthropicUsage(apiKey),
  ]);

  const dbCost = dbRows.reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0);
  const now    = kst.datetimeStr();
  const hasAlert = spawns >= ALERT_THRESHOLD_SPAWNS || dbCost >= ALERT_THRESHOLD_COST;
  const kind = hasAlert ? 'alert' : 'report';

  // alert-only 모드에서는 임계값 초과 시만 전송
  if (isAlert && !hasAlert) {
    console.log(`[claude-monitor] ${now} — 정상 (spawn=${spawns}, cost=$${dbCost.toFixed(4)})`);
    return;
  }

  // ── 리포트 구성 ──
  const lines = [
    `🔍 Claude API 모니터 (${now})`,
    ``,
    `📡 Claude Code CLI (최근 1분)`,
    `  스폰 횟수: ${spawns}회${spawns >= ALERT_THRESHOLD_SPAWNS ? ' ⚠️' : ''}`,
  ];

  if (dbRows.length > 0) {
    lines.push(``, `💳 Anthropic API 과금 (최근 1분)`);
    for (const r of dbRows) {
      lines.push(`  • ${r.bot_name} [${r.model.split('/').pop()}] ${r.calls}회 — $${(parseFloat(r.cost_usd)||0).toFixed(4)}`);
    }
    lines.push(`  합계: $${dbCost.toFixed(4)}${dbCost >= ALERT_THRESHOLD_COST ? ' 🚨' : ''}`);
  } else {
    lines.push(``, `💳 Anthropic API 과금 (최근 1분): $0.0000`);
  }

  // Anthropic Usage API 결과
  if (anthropicRes?.status === 200 && anthropicRes.data) {
    const d = anthropicRes.data;
    const totalIn  = d.usage?.reduce?.((s, u) => s + (u.input_tokens  || 0), 0) ?? d.input_tokens  ?? '?';
    const totalOut = d.usage?.reduce?.((s, u) => s + (u.output_tokens || 0), 0) ?? d.output_tokens ?? '?';
    lines.push(``, `📊 Anthropic 오늘 누적 (API 보고)`,
      `  입력: ${typeof totalIn  === 'number' ? totalIn.toLocaleString()  : totalIn}tok`,
      `  출력: ${typeof totalOut === 'number' ? totalOut.toLocaleString() : totalOut}tok`,
    );
  } else if (anthropicRes?.status === 401) {
    lines.push(``, `⚠️ Anthropic Usage API: 인증 실패 (API Key 확인 필요)`);
  } else if (anthropicRes === null) {
    lines.push(``, `ℹ️ Anthropic Usage API: 연결 불가 (네트워크/엔드포인트 미지원)`);
  }

  const memoryQuery = buildMonitorMemoryQuery(kind, [
    `${spawns}-spawns`,
    dbCost >= ALERT_THRESHOLD_COST ? 'cost-threshold' : 'cost-normal',
  ]);
  const episodicHint = await monitorMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 모니터링',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      alert: '경고',
      report: '정상',
    },
    order: ['alert', 'report'],
  }).catch(() => '');
  const semanticHint = await monitorMemory.recallHint(`${memoryQuery} consolidated usage pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');

  const aiSummary = await buildWorkerCliInsight({
    bot: 'worker-claude-api-monitor',
    requestType: 'worker-claude-api-monitor',
    title: '워커 Claude API 사용량 모니터',
    data: {
      spawns,
      dbCost: Number(dbCost.toFixed(4)),
      hasAlert,
      thresholdSpawns: ALERT_THRESHOLD_SPAWNS,
      thresholdCost: ALERT_THRESHOLD_COST,
      dbRows: dbRows.map((row) => ({
        bot_name: row.bot_name,
        model: row.model,
        calls: row.calls,
        cost_usd: row.cost_usd,
      })),
      anthropicStatus: anthropicRes?.status || null,
    },
    fallback: buildMonitorFallbackInsight({ spawns, dbCost, hasAlert }),
  });

  if (hasAlert) lines.unshift(`🚨 *임계값 초과 감지!*`, ``);
  lines.push('', `🔍 AI: ${aiSummary}`);
  if (episodicHint) lines.push('', ...episodicHint.trimStart().split('\n'));
  if (semanticHint) lines.push('', ...semanticHint.trimStart().split('\n'));

  const baseMsg = lines.join('\n');
  const alertLevel = hasAlert ? 3 : 1;
  const notice = buildNoticeEvent({
    from_bot: 'worker-monitor',
    team: 'claude',
    event_type: hasAlert ? 'alert' : 'report',
    alert_level: alertLevel,
    title: '🔍 Claude API 사용량 모니터',
    summary: hasAlert
      ? `최근 1분 사용량이 임계값을 넘었습니다. spawn=${spawns}, cost=$${dbCost.toFixed(4)}`
      : `최근 1분 사용량 정상. spawn=${spawns}, cost=$${dbCost.toFixed(4)}`,
    details: lines.filter(Boolean),
    action: hasAlert ? '토큰 사용량과 Claude Code spawn 급증 원인을 확인하세요.' : '',
    payload: {
      title: 'Claude API 사용량 모니터',
      summary: hasAlert
        ? `임계 초과: spawn=${spawns}, cost=$${dbCost.toFixed(4)}`
        : `정상: spawn=${spawns}, cost=$${dbCost.toFixed(4)}`,
      details: lines.filter(Boolean),
      action: hasAlert ? '/claude-health | /reporting-health 확인' : '',
    },
  });
  const incidentState = canonicalizeWorkerCriticalAlert({
    source: 'worker-monitor',
    event_type: notice.event_type,
    alert_level: alertLevel,
    message: baseMsg,
  });
  if (incidentState.suppress) {
    console.log(`[claude-monitor] duplicate suppressed: ${incidentState.signature}`);
    return;
  }
  const msg = appendIncidentLine(renderNoticeEvent(notice) || baseMsg, incidentState.signature, incidentState.incident);
  console.log(msg);

  try {
    await publishEventPipeline({
      event: notice,
      targets: buildSeverityTargets({
        event: notice,
        topicTeam: 'claude-lead',
        includeQueue: false,
        includeTelegram: false,
      }),
      policy: {
        cooldownMs: hasAlert ? 5 * 60_000 : 30 * 60_000,
        quietHours: hasAlert ? null : { startHour: 23, endHour: 8, timezone: 'KST', maxAlertLevel: 2 },
      },
    });
  } catch (e) {
    console.error('[claude-monitor] 텔레그램 전송 실패:', e.message);
  }

  await monitorMemory.remember(msg, 'episodic', {
    importance: hasAlert ? 0.78 : 0.58,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind,
      spawns,
      dbCost: Number(dbCost.toFixed(4)),
      hasAnthropicUsageApi: Boolean(anthropicRes),
      anthropicStatus: anthropicRes?.status || null,
    },
  }).catch(() => {});
  await monitorMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
