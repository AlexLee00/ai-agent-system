'use strict';
const kst = require('../../../packages/core/lib/kst');
const path = require('path');
const { spawn } = require('child_process');

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
    { title: '루나', path: path.join(root, 'bots', 'investment', 'scripts', 'health-report.js') },
    { title: '워커', path: path.join(root, 'bots', 'worker', 'scripts', 'health-report.js') },
    { title: '클로드', path: path.join(root, 'bots', 'claude', 'scripts', 'health-report.js') },
    { title: '스카', path: path.join(root, 'bots', 'reservation', 'scripts', 'health-report.js') },
  ];

  const [luna, worker, claude, ska] = await Promise.all(scripts.map((entry) => runNodeScriptJson(entry.path)));
  const rows = [
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
  ].filter((row) => row.hasWarn);

  if (rows.length === 0) return null;

  const lines = ['🚨 운영 헬스 경고', ''];
  for (const row of rows) {
    lines.push(`  • ${row.title}: ${row.summary}`);
  }
  lines.push('');
  lines.push('상세 확인: /ops-health alerts');
  return lines.join('\n');
}

async function buildMorningBriefingWithOps(items) {
  const brief = buildMorningBriefing(items);
  if (!brief) return null;
  const opsSnippet = await buildOpsHealthAlertSnippet();
  if (!opsSnippet) return brief;
  return `${brief}\n\n${opsSnippet}`;
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
  isBriefingTime,
};
