// @ts-nocheck
'use strict';

/**
 * scripts/health-dashboard-server.js — 클로드팀 시스템 헬스 대시보드
 *
 * 봇 상태 / 이슈 이력 / 리소스 / 클로드팀장 모드를 웹으로 실시간 확인
 *
 * 실행: node scripts/health-dashboard-server.js [--port=3032]
 * 브라우저: http://localhost:3032
 */

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execSync } = require('child_process');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const {
  getServiceOwnership,
  isElixirOwnedService,
  isRetiredService,
  isExpectedIdleService,
  isOptionalService,
} = require('../../../packages/core/lib/service-ownership.js');
// getAllPoolStats는 module.exports에 포함됨
const { LEAD_MODES, _getLeadMode } = require('../lib/claude-lead-brain');
const cfg = require('../lib/config');

const args    = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port='));
const PORT    = portArg ? parseInt(portArg.split('=')[1]) : 3032;

const HTML_FILE = path.join(__dirname, 'health-dashboard.html');
const WORKSPACE_LOG_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'logs');

function getAvailableMemoryGB() {
  try {
    const vmstat = execSync('vm_stat', { encoding: 'utf8', timeout: 3000 });
    const page = 16384;
    const get = key => {
      const m = vmstat.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? (parseInt(m[1], 10) * page) / 1073741824 : 0;
    };
    return get('Pages free') + get('Pages inactive') + get('Pages speculative');
  } catch {
    return os.freemem() / 1073741824;
  }
}

function readLogSnapshot(fileName, tailLines = 12) {
  const filePath = path.join(WORKSPACE_LOG_DIR, fileName);
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').slice(-tailLines);
    return {
      exists: true,
      path: filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      tail: lines,
    };
  } catch {
    return {
      exists: false,
      path: filePath,
      mtimeMs: 0,
      size: 0,
      tail: [],
    };
  }
}

function summarizeLogState({ label, stdoutFile, stderrFile, healthy = false }) {
  const stdout = readLogSnapshot(stdoutFile);
  const stderr = readLogSnapshot(stderrFile);
  const latestStdout = stdout.mtimeMs || 0;
  const latestStderr = stderr.mtimeMs || 0;
  const latestTail = stderr.tail.join('\n');
  const now = Date.now();
  const ageMinutes = latestStderr > 0
    ? Math.max(0, Math.round((now - latestStderr) / 60000))
    : null;
  const benignPatterns = [
    '이미 실행 중',
    'terminated: 15',
    'sigterm',
    'module_not_found',
  ];
  const hasBenignTail = benignPatterns.some(pattern =>
    latestTail.toLowerCase().includes(pattern.toLowerCase()),
  );

  let status = 'ok';
  let detail = healthy ? '현재 서비스 정상' : '최근 에러 로그 없음';

  if (stderr.exists) {
    if (healthy && latestStdout >= latestStderr) {
      status = 'stale';
      detail = `과거 에러 흔적 (${ageMinutes ?? 0}분 전, 최신 stdout이 더 새로움)`;
    } else if (healthy && hasBenignTail) {
      status = 'stale';
      detail = `현재 서비스 정상, benign/stale stderr (${ageMinutes ?? 0}분 전)`;
    } else if (!healthy && latestStderr > 0) {
      status = 'warn';
      detail = `최근 stderr 존재 (${ageMinutes ?? 0}분 전)`;
    }
  }

  return {
    label,
    status,
    detail,
    stdout_mtime: latestStdout ? new Date(latestStdout).toISOString() : null,
    stderr_mtime: latestStderr ? new Date(latestStderr).toISOString() : null,
    stderr_size: stderr.size,
  };
}

// ─── 데이터 조회 ─────────────────────────────────────────────────────

async function getDoctorStats() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await pgPool.query('reservation', `
      SELECT
        task_type,
        COUNT(*) FILTER (WHERE success = true)  AS ok_cnt,
        COUNT(*) FILTER (WHERE success = false) AS fail_cnt,
        COUNT(*) AS total,
        MAX(created_at) AS last_at
      FROM doctor_log
      WHERE created_at > $1
      GROUP BY task_type
      ORDER BY total DESC
    `, [cutoff]);
    return rows;
  } catch (e) {
    return [];
  }
}

async function getRecentIssues() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await pgPool.query('reservation', `
      SELECT id, task_type, success, error_msg, requested_by, created_at
      FROM doctor_log
      WHERE created_at > $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [cutoff]);
    return rows;
  } catch (e) {
    return [];
  }
}

function extractDecision(result) {
  if (!result || typeof result !== 'object') return '';
  return String(result.decision || result.action || '').toLowerCase().trim();
}

function isLowRiskIntegritySummary(summary = '') {
  const text = String(summary || '').toLowerCase();
  return text.length > 0 && (
    text.includes('코드 무결성') ||
    text.includes('git 무결성') ||
    text.includes('git 상태') ||
    text.includes('git 변경사항') ||
    text.includes('체크섬')
  );
}

function isSoftShadowMatchRow(row) {
  if (!row) return false;
  const ruleDecision = extractDecision(row.rule_result);
  const llmDecision = extractDecision(row.llm_result);
  if (!ruleDecision || !llmDecision) return false;
  if (ruleDecision === llmDecision) return true;
  if (!isLowRiskIntegritySummary(row.input_summary)) return false;
  const soft = new Set(['ignore', 'monitor']);
  return soft.has(ruleDecision) && soft.has(llmDecision);
}

function detectShadowMismatchReasons(summary = '') {
  const text = String(summary || '').toLowerCase();
  const reasons = [];
  if (text.includes('openclaw') || text.includes('게이트웨이')) reasons.push('openclaw_memory');
  if (text.includes('swap')) reasons.push('swap_pressure');
  if (text.includes('고아 node') || text.includes('orphan node')) reasons.push('orphan_nodes');
  if (text.includes('덱스터 full') || text.includes('덱스터 quick') || text.includes('덱스터 일일보고')) reasons.push('dexter_launchd');
  if (text.includes('루나 크립토') || text.includes('crypto 사이클')) reasons.push('luna_crypto_cycle');
  if (text.includes('ownership alignment')) reasons.push('ownership_alignment');
  if (text.includes('코드 무결성') || text.includes('체크섬') || text.includes('git 무결성')) reasons.push('code_integrity');
  return reasons;
}

async function getShadowStats() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await pgPool.query('reservation', `
      SELECT
        match,
        rule_result,
        llm_result,
        input_summary,
        elapsed_ms,
        mode,
        created_at
      FROM shadow_log
      WHERE team = 'claude-lead' AND created_at > $1
      ORDER BY created_at DESC
      LIMIT 200
    `, [cutoff]);
    if (!rows || rows.length === 0) {
      return { total: 0, matched: 0, mismatched: 0, avg_ms: 0, mode: 'shadow', soft_adjusted: 0 };
    }
    const total = rows.length;
    const matched = rows.filter(isSoftShadowMatchRow).length;
    const mismatched = Math.max(0, total - matched);
    const elapsedValues = rows.map(row => Number(row.elapsed_ms)).filter(v => Number.isFinite(v));
    const avgMs = elapsedValues.length
      ? elapsedValues.reduce((sum, value) => sum + value, 0) / elapsedValues.length
      : 0;
    const softAdjusted = rows.filter(row => row?.match === false && isSoftShadowMatchRow(row)).length;
    const mode = rows[0]?.mode || 'shadow';
    const mismatchRows = rows.filter(row => !isSoftShadowMatchRow(row));
    const decisionPairs = new Map();
    const reasonCounts = new Map();

    for (const row of mismatchRows) {
      const ruleDecision = extractDecision(row.rule_result) || 'unknown';
      const llmDecision = extractDecision(row.llm_result) || 'unknown';
      const pairKey = `${ruleDecision}->${llmDecision}`;
      decisionPairs.set(pairKey, (decisionPairs.get(pairKey) || 0) + 1);

      for (const reason of detectShadowMismatchReasons(row.input_summary)) {
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
      }
    }

    const topDecisionPairs = [...decisionPairs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pair, count]) => ({ pair, count }));

    const topReasons = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([reason, count]) => ({ reason, count }));

    const recentMismatchPreview = mismatchRows.slice(0, 3).map(row => ({
      created_at: row.created_at,
      rule_decision: extractDecision(row.rule_result) || 'unknown',
      llm_decision: extractDecision(row.llm_result) || 'unknown',
      summary: String(row.input_summary || '').slice(0, 180),
      reasons: detectShadowMismatchReasons(row.input_summary),
    }));

    return {
      total,
      matched,
      mismatched,
      avg_ms: avgMs,
      mode,
      soft_adjusted: softAdjusted,
      top_decision_pairs: topDecisionPairs,
      top_reasons: topReasons,
      recent_mismatch_preview: recentMismatchPreview,
    };
  } catch (e) {
    return {
      total: 0,
      matched: 0,
      mismatched: 0,
      avg_ms: 0,
      mode: 'shadow',
      soft_adjusted: 0,
      top_decision_pairs: [],
      top_reasons: [],
      recent_mismatch_preview: [],
    };
  }
}

function getBotStatuses() {
  const BOTS = [
    { label: '덱스터 (quick)',       service: 'ai.claude.dexter.quick' },
    { label: '덱스터 (full)',        service: 'ai.claude.dexter' },
    { label: '아처',                 service: 'ai.claude.archer' },
    { label: '클로드 자동개발 (legacy)', service: 'ai.claude.auto-dev' },
    { label: '클로드 자동개발 (shadow)', service: 'ai.claude.auto-dev.shadow' },
    { label: '클로드 자동개발 (L5)',    service: 'ai.claude.auto-dev.autonomous' },
    { label: '스카 커맨더',          service: 'ai.ska.commander' },
    { label: '앤디 (네이버모니터)', service: 'ai.ska.naver-monitor' },
    { label: '루나 커맨더',          service: 'ai.investment.commander' },
    { label: '루나 크립토',          service: 'ai.investment.crypto' },
    { label: '제이 (오케스트레이터)', service: 'ai.orchestrator' },
  ];

  return BOTS.map(b => {
    const ownership = getServiceOwnership(b.service);

    try {
      execSync(`launchctl list ${b.service} 2>/dev/null`, { timeout: 3000 });
      if (isRetiredService(b.service)) {
        return {
          label: b.label,
          service: b.service,
          status: 'retired',
          owner: ownership?.owner || 'retired',
        };
      }

      return {
        label: b.label,
        service: b.service,
        status: 'running',
        owner: ownership?.owner || 'launchd',
      };
    } catch {
      let status = 'stopped';

      if (isRetiredService(b.service)) {
        status = 'retired';
      } else if (isElixirOwnedService(b.service)) {
        status = 'managed-by-elixir';
      } else if (isExpectedIdleService(b.service)) {
        status = 'expected-idle';
      } else if (isOptionalService(b.service)) {
        status = 'optional-stopped';
      }

      return {
        label: b.label,
        service: b.service,
        status,
        owner: ownership?.owner || 'launchd',
      };
    }
  });
}

function isLaunchdServiceRunning(service) {
  try {
    execSync(`launchctl list ${service} 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function getResourceStats() {
  try {
    const cpuCount    = os.cpus().length;
    const totalMem    = os.totalmem();
    const availableMemGB = getAvailableMemoryGB();
    const totalMemGB = totalMem / (1024 ** 3);
    const usedMemPct  = Math.max(0, Math.min(100, Math.round(((totalMemGB - availableMemGB) / totalMemGB) * 100)));
    const loadAvg     = os.loadavg();
    const uptimeDays  = Math.floor(os.uptime() / 86400);

    // 디스크 사용량
    let diskUsage = '조회 불가';
    try {
      const df = execSync("df -h / | tail -1 | awk '{print $5}'", { encoding: 'utf8', timeout: 3000 }).trim();
      diskUsage = df;
    } catch {}

    return {
      cpu_count:    cpuCount,
      mem_used_pct: usedMemPct,
      mem_total_gb: Math.round(totalMemGB),
      mem_available_gb: Number(availableMemGB.toFixed(1)),
      load_1m:      loadAvg[0].toFixed(2),
      load_5m:      loadAvg[1].toFixed(2),
      uptime_days:  uptimeDays,
      disk_usage:   diskUsage,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function getHealthData() {
  const [doctorStats, recentIssues, shadowStats] = await Promise.all([
    getDoctorStats(),
    getRecentIssues(),
    getShadowStats(),
  ]);

  const botStatuses = getBotStatuses();
  const resources   = getResourceStats();
  const leadMode    = _getLeadMode();

  // DB 커넥션 풀 상태
  let poolStats = [];
  try {
    poolStats = pgPool.getAllPoolStats();
  } catch {}

  const healthyStatuses = new Set(['running', 'managed-by-elixir', 'expected-idle', 'optional-stopped']);
  const runningCount = botStatuses.filter(b => healthyStatuses.has(b.status)).length;
  const totalBots    = botStatuses.length;
  const commanderHealthy = isLaunchdServiceRunning('ai.claude.commander');
  const dashboardHealthy = isLaunchdServiceRunning('ai.claude.health-dashboard');
  const logHealth = [
    summarizeLogState({
      label: 'claude commander',
      stdoutFile: 'claude-commander.log',
      stderrFile: 'claude-commander-error.log',
      healthy: commanderHealthy,
    }),
    summarizeLogState({
      label: 'health dashboard',
      stdoutFile: 'claude-health-dashboard.log',
      stderrFile: 'claude-health-dashboard-error.log',
      healthy: dashboardHealthy,
    }),
  ];

  return {
    generated_at:  new Date().toISOString(),
    lead_mode:     leadMode,
    adaptive_lead: cfg.RUNTIME?.autonomy?.adaptiveLead || null,
    lead_modes:    LEAD_MODES,
    bot_statuses:  botStatuses,
    bot_summary:   { running: runningCount, total: totalBots },
    doctor_stats:  doctorStats,
    recent_issues: recentIssues,
    shadow_stats:  shadowStats,
    pool_stats:    poolStats,
    log_health:    logHealth,
    resources,
  };
}

// ─── HTTP 서버 ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/api/health') {
    try {
      const data = await getHealthData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('health-dashboard.html 파일을 찾을 수 없습니다.');
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.log(`[클로드팀 헬스 대시보드] 포트 ${PORT}는 이미 사용 중입니다. 기존 인스턴스를 유지합니다.`);
    process.exit(0);
  }
  console.error('[클로드팀 헬스 대시보드] 서버 오류:', error.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[클로드팀 헬스 대시보드] 서버 시작: http://localhost:${PORT}`);
  console.log(`  헬스 API: http://localhost:${PORT}/api/health`);
  console.log('  종료: Ctrl+C');
});
