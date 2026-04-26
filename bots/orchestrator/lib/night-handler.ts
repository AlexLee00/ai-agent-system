// @ts-nocheck
'use strict';
const kst = require('../../../packages/core/lib/kst');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const {
  buildSnippetEvent,
  renderSnippetEvent,
  getRecentPayloadWarnings,
  summarizePayloadWarnings,
} = require('../../../packages/core/lib/reporting-hub');
const billingGuard = require('../../../packages/core/lib/billing-guard');

/**
 * lib/night-handler.js — 야간 자율 운영 관리
 *
 * 야간(22:00~08:00 KST):
 *   - MEDIUM(2) 이하 알람 → morning_queue 보류
 *   - HIGH(3) 이상 → 즉시 발송 (단, 배치 요약)
 *   - CRITICAL(4) → 항상 즉시 발송
 *
 * 08:00 KST 아침 브리핑: morning_queue 배치 요약 발송
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'claude';

function getAiAgentHome() {
  return process.env.AI_AGENT_HOME || process.env.JAY_HOME || path.join(os.homedir(), '.ai-agent-system');
}

function getInvestmentStateFile(filename) {
  return path.join(process.env.INVESTMENT_STATE_DIR || path.join(getAiAgentHome(), 'investment'), filename);
}

function formatGuardScope(scope = '') {
  const normalized = String(scope || '').trim().toLowerCase();
  if (normalized === 'investment.normal.crypto') return '암호화폐';
  if (normalized === 'investment.normal.domestic') return '국내주식';
  if (normalized === 'investment.normal.overseas') return '해외주식';
  if (normalized.startsWith('investment.normal.crypto.')) return `암호화폐/${normalized.split('.').pop()}`;
  if (normalized.startsWith('investment.normal.domestic.')) return `국내주식/${normalized.split('.').pop()}`;
  if (normalized.startsWith('investment.normal.overseas.')) return `해외주식/${normalized.split('.').pop()}`;
  return normalized || 'unknown';
}

function formatGuardExpiry(expiresAt) {
  if (!expiresAt) return '수동 해제';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '수동 해제';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatGuardReason(reason = '') {
  const text = String(reason || '').trim();
  if (!text) return '';
  return text
    .replace(/^\[(.*?)\]\s*/i, '$1 ')
    .replace(/10분 급등\s*/g, '급등 ')
    .replace(/\s+/g, ' ')
    .trim();
}

// KST 시간 (0~23)
function getKSTHour() {
  return new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
}

/**
 * 현재 야간 여부
 */
function isNightTime() {
  const h = getKSTHour();
  return h >= 22 || h < 8;
}

/**
 * 야간에 알람을 보류할지 결정
 */
function shouldDefer(alertLevel) {
  if (!isNightTime()) return false;
  return alertLevel <= 2;
}

/**
 * morning_queue에 보류 등록
 */
async function deferToMorning(queueId, summary, bots = []) {
  await pgPool.run(SCHEMA, `
    INSERT INTO morning_queue (queue_id, summary, bot_list)
    VALUES ($1, $2, $3)
  `, [queueId, summary, JSON.stringify(bots)]);
}

/**
 * morning_queue에서 미발송 항목 조회 및 마킹
 */
async function flushMorningQueue() {
  const rows = await pgPool.query(SCHEMA, `
    SELECT * FROM morning_queue WHERE sent_at IS NULL ORDER BY deferred_at ASC
  `);

  if (rows.length === 0) return [];

  const now = new Date().toISOString();
  const ids = rows.map(r => r.id);
  await pgPool.run(SCHEMA, `
    UPDATE morning_queue SET sent_at = $1 WHERE id = ANY($2::int[])
  `, [now, ids]);

  return rows;
}

/**
 * 아침 브리핑 메시지 생성
 */
function buildMorningBriefing(items) {
  if (items.length === 0) return null;

  const byBot = {};
  for (const item of items) {
    let bots;
    try { bots = JSON.parse(item.bot_list); } catch { bots = ['알 수 없음']; }
    for (const bot of bots) {
      if (!byBot[bot]) byBot[bot] = [];
      byBot[bot].push(item.summary);
    }
  }

  const lines = [`🌅 야간 알람 브리핑 (총 ${items.length}건)`, ``];

  for (const [bot, summaries] of Object.entries(byBot)) {
    lines.push(`【${bot}】 ${summaries.length}건`);
    for (const s of summaries.slice(0, 3)) {
      lines.push(`  • ${s}`);
    }
    if (summaries.length > 3) {
      lines.push(`  • ... 외 ${summaries.length - 3}건`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function runNodeScriptJson(script, timeoutMs = 60_000) {
  const root = path.join(__dirname, '..', '..', '..');
  return await new Promise((resolve) => {
    const child = spawn('node', [script, '--json'], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

async function buildOpsHealthAlertSnippet() {
  const root = path.join(__dirname, '..', '..', '..');
  const scripts = [
    { title: '오케스트레이터', path: path.join(root, 'bots', 'orchestrator', 'scripts', 'health-report.js') },
    { title: '루나', path: path.join(root, 'bots', 'investment', 'scripts', 'health-report.js') },
    { title: '워커', path: path.join(root, 'bots', 'worker', 'scripts', 'health-report.js') },
    { title: '클로드', path: path.join(root, 'bots', 'claude', 'scripts', 'health-report.js') },
    { title: '스카', path: path.join(root, 'bots', 'reservation', 'scripts', 'health-report.js') },
    { title: 'AI 피드백', path: path.join(root, 'bots', 'orchestrator', 'scripts', 'feedback-health.js') },
  ];

  const [orchestrator, luna, worker, claude, ska, feedback] = await Promise.all(scripts.map((entry) => runNodeScriptJson(entry.path)));
  const rows = [
    {
      title: '오케스트레이터',
      hasWarn: !orchestrator || orchestrator.serviceHealth.warnCount > 0 || orchestrator.criticalWebhookHealth.warnCount > 0,
      summary: orchestrator
        ? `서비스 경고 ${orchestrator.serviceHealth.warnCount}건 / critical 경고 ${orchestrator.criticalWebhookHealth.warnCount}건`
        : '조회 실패',
    },
    {
      title: '루나',
      hasWarn: !luna || luna.serviceHealth.warnCount > 0,
      summary: luna ? `서비스 경고 ${luna.serviceHealth.warnCount}건` : '조회 실패',
    },
    {
      title: '워커',
      hasWarn: !worker || worker.serviceHealth.warnCount > 0 || worker.endpointHealth.warnCount > 0,
      summary: worker
        ? `서비스 경고 ${worker.serviceHealth.warnCount}건 / 엔드포인트 경고 ${worker.endpointHealth.warnCount}건`
        : '조회 실패',
    },
    {
      title: '클로드',
      hasWarn: !claude || claude.serviceHealth.warnCount > 0 || claude.dashboardHealth.warnCount > 0,
      summary: claude
        ? `서비스 경고 ${claude.serviceHealth.warnCount}건 / 대시보드 경고 ${claude.dashboardHealth.warnCount}건`
        : '조회 실패',
    },
    {
      title: '스카',
      hasWarn: !ska || ska.serviceHealth.warnCount > 0 || ska.monitorHealth.warnCount > 0,
      summary: ska
        ? `서비스 경고 ${ska.serviceHealth.warnCount}건 / 모니터 경고 ${ska.monitorHealth.warnCount}건`
        : '조회 실패',
    },
    {
      title: 'AI 피드백',
      hasWarn: !feedback || Boolean(feedback.decision?.recommended),
      summary: feedback
        ? `세션 ${feedback.totalSessions}건 / rejected ${feedback.totalRejected}건${feedback.decision?.recommended ? ' / 품질 점검 필요' : ''}`
        : '조회 실패',
    },
  ].filter((row) => row.hasWarn);

  if (rows.length === 0) return null;

  return renderSnippetEvent(buildSnippetEvent({
    from_bot: 'mainbot',
    team: 'system',
    event_type: 'briefing_alert',
    alert_level: 3,
    title: '🚨 운영 헬스 경고',
    lines: rows.map((row) => `${row.title}: ${row.summary}`),
    detailHint: '/ops-health alerts | /orchestrator-health',
    payload: { kind: 'ops_health', rows },
  }));
}

async function runPythonScriptJson(python, script, args = [], timeoutMs = 60_000) {
  const root = path.join(__dirname, '..', '..', '..');
  return await new Promise((resolve) => {
    const child = spawn(python, [script, ...args], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

async function buildSkaForecastAlertSnippet() {
  const root = path.join(__dirname, '..', '..', '..');
  const python = path.join(root, 'bots', 'ska', 'venv', 'bin', 'python');
  const script = path.join(root, 'bots', 'ska', 'src', 'forecast_health.py');
  const report = await runPythonScriptJson(python, script, ['--days=30', '--json']);
  const tuning = report?.tuning_candidate;
  const summary = report?.summary;

  if (!tuning?.recommended) return null;

  const lines = [];
  if (summary?.avg_mape != null) {
    lines.push(`평균 MAPE: ${summary.avg_mape.toFixed(1)}%`);
  }
  if (summary?.hit_rate_20 != null) {
    lines.push(`20% 적중률: ${summary.hit_rate_20.toFixed(1)}%`);
  }
  for (const reason of (tuning.reasons || []).slice(0, 3)) {
    lines.push(reason);
  }
  return renderSnippetEvent(buildSnippetEvent({
    from_bot: 'rebecca',
    team: 'reservation',
    event_type: 'forecast_alert',
    alert_level: 2,
    title: '📉 스카 예측 경고',
    lines,
    detailHint: '/ska-forecast | /ska-review',
    payload: { kind: 'ska_forecast', tuning, forecast_summary: summary },
  }));
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatAgeMinutes(minutes) {
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return remain > 0 ? `${hours}시간 ${remain}분` : `${hours}시간`;
}

function pushUniqueLine(lines, line) {
  if (!lines.includes(line)) lines.push(line);
}

function getLunaRiskSnapshot() {
  const statePath = getInvestmentStateFile('investment-state.json');
  const costPath = getInvestmentStateFile('investment-cost.json');
  const state = readJsonFileSafe(statePath);
  const cost = readJsonFileSafe(costPath);
  const lines = [];
  const reasons = [];

  if (!state?.lastCycleAt) {
    pushUniqueLine(lines, '  • 투자 상태 파일이 없거나 lastCycleAt이 비어 있음');
    reasons.push('투자 상태 파일 누락');
  } else {
    const ageMinutes = Math.max(0, Math.floor((Date.now() - Number(state.lastCycleAt)) / 60_000));
    if (ageMinutes >= 60) {
      pushUniqueLine(lines, `  • 마지막 루나 사이클이 ${formatAgeMinutes(ageMinutes)} 전 상태로 멈춤`);
      reasons.push(`사이클 stale ${formatAgeMinutes(ageMinutes)}`);
    }
  }

  if (state?.lastUsdtAlertAt) {
    const usdtAlertMinutes = Math.max(0, Math.floor((Date.now() - Number(state.lastUsdtAlertAt)) / 60_000));
    if (usdtAlertMinutes <= 24 * 60) {
      pushUniqueLine(lines, `  • 최근 USDT 잔고 경고가 ${formatAgeMinutes(usdtAlertMinutes)} 전에 발생`);
      reasons.push(`USDT 경고 ${formatAgeMinutes(usdtAlertMinutes)} 전`);
    }
  }

  if (!cost?.date || !cost?.daily_budget) {
    pushUniqueLine(lines, '  • 비용 추적 상태를 읽지 못함');
    reasons.push('비용 추적 상태 읽기 실패');
  } else {
    const budgetPct = Number(cost.usage || 0) / Number(cost.daily_budget || 1);
    const isToday = cost.date === kst.today();
    if (!isToday) {
      pushUniqueLine(lines, `  • 비용 스냅샷 날짜가 오래됨 (${cost.date})`);
      reasons.push(`비용 스냅샷 stale (${cost.date})`);
    } else if (budgetPct >= 0.8) {
      pushUniqueLine(lines, `  • 일일 LLM 비용 사용률 ${(budgetPct * 100).toFixed(1)}%`);
      reasons.push(`일일 비용 ${(budgetPct * 100).toFixed(1)}%`);
    }
  }

  const activeGuards = billingGuard.listActiveGuards('investment.normal');
  if (activeGuards.length > 0) {
    pushUniqueLine(lines, `  • 투자 LLM guard ${activeGuards.length}건 활성`);
    reasons.push(`LLM guard ${activeGuards.length}건 활성`);
    for (const guard of activeGuards.slice(0, 3)) {
      pushUniqueLine(
        lines,
        `  • ${formatGuardScope(guard.scope)} 차단 / 해제 ${formatGuardExpiry(guard.expires_at)}`
      );
      if (guard.reason) {
        pushUniqueLine(lines, `    사유: ${formatGuardReason(guard.reason)}`);
      }
    }
  }

  return {
    hasWarn: lines.length > 0,
    lines,
    reasons,
    guardCount: activeGuards.length,
  };
}

async function buildLunaRiskAlertSnippet() {
  const { hasWarn, lines } = getLunaRiskSnapshot();

  if (!hasWarn) return null;

  return renderSnippetEvent(buildSnippetEvent({
    from_bot: 'luna',
    team: 'investment',
    event_type: 'risk_alert',
    alert_level: 2,
    title: '📈 루나 운영 경고',
    lines: lines.map((line) => line.replace(/^•\s*/, '').replace(/^-\s*/, '').replace(/^\s*•\s*/, '').trim()),
    detailHint: '/luna-health',
    payload: { kind: 'luna_risk' },
  }));
}

async function buildReportingHealthAlertSnippet() {
  const summary = summarizePayloadWarnings(
    getRecentPayloadWarnings({ withinHours: 24, limit: 50 })
  );

  if (!summary || summary.count === 0) return null;

  const latestWarning = Array.isArray(summary.latest?.warnings) && summary.latest.warnings.length > 0
    ? summary.latest.warnings.join(', ')
    : 'latest_unknown';

  return renderSnippetEvent(buildSnippetEvent({
    from_bot: 'reporting-hub',
    team: 'system',
    event_type: 'reporting_alert',
    alert_level: 2,
    title: '🧾 리포팅 파이프라인 경고',
    lines: [
      `최근 24시간 payload 경고 ${summary.count}건`,
      ...summary.topProducers.map((line) => line.trim()),
      `최근 경고: ${summary.latest?.team || 'general'}/${summary.latest?.from_bot || 'unknown'} - ${latestWarning}`,
    ],
    detailHint: '/reporting-health | /orchestrator-health',
    payload: { kind: 'reporting_health', warning_summary: summary },
  }));
}

async function buildMorningBriefingWithOps(items) {
  const brief = buildMorningBriefing(items);
  if (!brief) return null;
  const opsSnippet = await buildOpsHealthAlertSnippet();
  const forecastSnippet = await buildSkaForecastAlertSnippet();
  const lunaSnippet = await buildLunaRiskAlertSnippet();
  const reportingSnippet = await buildReportingHealthAlertSnippet();
  const extras = [opsSnippet, forecastSnippet, lunaSnippet, reportingSnippet].filter(Boolean);
  if (extras.length === 0) return brief;
  return `${brief}\n\n${extras.join('\n\n')}`;
}

/**
 * 08:00 KST 기준 브리핑 타이밍인지 확인
 */
function isBriefingTime(lastBriefHour) {
  const h = getKSTHour();
  return h === 8 && lastBriefHour !== 8;
}

module.exports = {
  isNightTime,
  shouldDefer,
  deferToMorning,
  flushMorningQueue,
  buildMorningBriefing,
  buildMorningBriefingWithOps,
  buildOpsHealthAlertSnippet,
  buildSkaForecastAlertSnippet,
  getLunaRiskSnapshot,
  buildLunaRiskAlertSnippet,
  buildReportingHealthAlertSnippet,
  isBriefingTime,
};
