#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = '/Users/alexlee/projects/ai-agent-system';

const TEAM_HEALTH_COMMANDS = [
  { team: 'orchestrator', script: path.join(ROOT, 'bots/orchestrator/scripts/health-report.js') },
  { team: 'worker', script: path.join(ROOT, 'bots/worker/scripts/health-report.js') },
  { team: 'claude', script: path.join(ROOT, 'bots/claude/scripts/health-report.js') },
  { team: 'blog', script: path.join(ROOT, 'bots/blog/scripts/health-report.js') },
  { team: 'investment', script: path.join(ROOT, 'bots/investment/scripts/health-report.js') },
  { team: 'reservation', script: path.join(ROOT, 'bots/reservation/scripts/health-report.js') },
];

const FALLBACK_TEAM_PROBES = {
  orchestrator: ['http://127.0.0.1:5678/healthz'],
  worker: ['http://127.0.0.1:4000/api/health', 'http://127.0.0.1:4001'],
  claude: ['http://127.0.0.1:3032/api/health', 'http://127.0.0.1:5678/healthz'],
  blog: ['http://127.0.0.1:3100/health', 'http://127.0.0.1:5678/healthz'],
  investment: [],
  reservation: [],
};

const FALLBACK_LAUNCHD_LABELS = {
  orchestrator: ['ai.orchestrator'],
  worker: ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'],
  claude: ['ai.claude.commander', 'ai.claude.health-dashboard', 'ai.claude.dexter'],
  blog: ['ai.blog.node-server'],
  investment: ['ai.investment.commander', 'ai.investment.crypto', 'ai.investment.domestic', 'ai.investment.overseas', 'ai.investment.argos', 'ai.investment.reporter'],
  reservation: ['ai.ska.commander', 'ai.ska.naver-monitor', 'ai.ska.kiosk-monitor'],
};

const AUXILIARY_COMMANDS = [
  { key: 'errorReview', script: path.join(ROOT, 'scripts/reviews/error-log-daily-review.js'), args: ['--days=1', '--json'] },
  { key: 'jayUsage', script: path.join(ROOT, 'scripts/reviews/jay-llm-usage-report.js'), args: ['--days=1', '--json'] },
];

function parseArgs(argv = process.argv.slice(2)) {
  return { json: argv.includes('--json') };
}

function extractJson(output) {
  const text = String(output || '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) throw new Error('JSON payload not found');
  return JSON.parse(text.slice(first, last + 1));
}

function runNodeJson(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });

  const stdout = String(result.stdout || '');
  if (stdout.trim()) {
    try {
      return extractJson(stdout);
    } catch {
      // fall through to process-level error handling below
    }
  }

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(String(result.stderr || `node exited with code ${result.status}`));
  }
  throw new Error('JSON payload not found');
}

function runSafeNodeJson(script, args = []) {
  try {
    return { ok: true, data: runNodeJson(script, args) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function checkHttpOk(url) {
  try {
    const output = execFileSync('curl', ['-s', url], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return Boolean(String(output || '').trim());
  } catch {
    return false;
  }
}

function loadLaunchctlState() {
  let output = '';
  try {
    output = execFileSync('launchctl', ['list'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {};
  }

  const rows = {};
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const label = parts[2];
    rows[label] = { pid: parts[0], status: parts[1], label };
  }
  return rows;
}

function buildLaunchdTeamHealth(team, launchctlRows) {
  const labels = FALLBACK_LAUNCHD_LABELS[team] || [];
  if (!labels.length || !launchctlRows || Object.keys(launchctlRows).length === 0) {
    return { okCount: 0, warnCount: 0, ok: [], warn: [] };
  }

  const ok = [];
  const warn = [];
  for (const label of labels) {
    const row = launchctlRows[label];
    if (!row) {
      warn.push(`  service missing: ${label}`);
      continue;
    }
    const pidActive = row.pid !== '-';
    const statusOk = String(row.status) === '0';
    if (pidActive || statusOk) {
      ok.push(`  service ok: ${label} (pid=${row.pid}, status=${row.status})`);
    } else {
      warn.push(`  service warn: ${label} (pid=${row.pid}, status=${row.status})`);
    }
  }

  return {
    okCount: ok.length,
    warnCount: warn.length,
    ok,
    warn,
  };
}

async function buildFallbackTeamResult(team, healthError = null, launchctlRows = {}) {
  const launchdHealth = buildLaunchdTeamHealth(team, launchctlRows);
  const endpoints = FALLBACK_TEAM_PROBES[team] || [];
  if (!endpoints.length) {
    const hasLaunchdSignal = launchdHealth.okCount > 0 || launchdHealth.warnCount > 0;
    return {
      team,
      ok: true,
      data: {
        source: hasLaunchdSignal ? 'health_report_failed_launchctl' : 'health_report_failed_probe_unavailable',
        serviceHealth: hasLaunchdSignal ? launchdHealth : { okCount: 0, warnCount: 0, ok: [], warn: [] },
        decision: {
          level: launchdHealth.warnCount > 0 ? 'medium' : 'hold',
          recommended: launchdHealth.warnCount > 0,
          reasons: [
            hasLaunchdSignal
              ? `health-report 실행 실패로 launchctl 기준 서비스 상태를 요약했습니다.${healthError ? ` (${healthError})` : ''}`
              : `전용 endpoint probe가 없어 팀 상태를 과장 없이 보류합니다.${healthError ? ` (${healthError})` : ''}`,
          ],
        },
        healthError,
      },
    };
  }

  const results = [];
  for (const url of endpoints) {
    results.push(await checkHttpOk(url));
  }
  const okCount = results.filter(Boolean).length;
  const warnCount = endpoints.length - okCount;

  if (okCount === 0) {
    const hasLaunchdSignal = launchdHealth.okCount > 0 || launchdHealth.warnCount > 0;
    return {
      team,
      ok: true,
      data: {
        source: hasLaunchdSignal ? 'health_report_failed_launchctl' : 'health_report_failed_probe_unavailable',
        serviceHealth: hasLaunchdSignal
          ? launchdHealth
          : {
              okCount: 0,
              warnCount: 0,
              ok: [],
              warn: [],
            },
        decision: {
          level: launchdHealth.warnCount > 0 ? 'medium' : 'hold',
          recommended: launchdHealth.warnCount > 0,
          reasons: [
            hasLaunchdSignal
              ? `endpoint probe는 비었지만 launchctl 기준 서비스 상태를 보수적으로 사용했습니다.${healthError ? ` (${healthError})` : ''}`
              : `fallback probe가 현재 런타임에서 응답을 확인하지 못해 팀 상태를 과장 없이 보류합니다.${healthError ? ` (${healthError})` : ''}`,
          ],
        },
        healthError,
      },
    };
  }

  return {
    team,
    ok: true,
    data: {
      source: 'fallback_probe',
      serviceHealth: {
        okCount,
        warnCount,
        ok: endpoints.filter((_, i) => results[i]).map((url) => `  endpoint ok: ${url}`),
        warn: endpoints.filter((_, i) => !results[i]).map((url) => `  endpoint warn: ${url}`),
      },
      decision: {
        level: warnCount > 0 ? 'medium' : 'hold',
        recommended: warnCount > 0,
        reasons: [
          warnCount > 0
            ? `fallback probe 기준 endpoint 경고 ${warnCount}건이 있습니다.`
            : 'fallback probe 기준 핵심 endpoint가 응답 중입니다.',
        ],
      },
      healthError,
    },
  };
}

function toSummaryLine(team, data) {
  const decision = data?.decision || {};
  const service = data?.serviceHealth || {};
  return {
    team,
    source: data?.source || 'health-report',
    level: decision.level || 'unknown',
    recommended: Boolean(decision.recommended),
    okCount: Number(service.okCount || 0),
    warnCount: Number(service.warnCount || 0),
    reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
    healthError: data?.healthError || null,
  };
}

function buildRecommendations(teamSummaries, auxiliary) {
  const lines = [];
  const warnedTeams = teamSummaries.filter((item) => item.warnCount > 0 || item.recommended);

  for (const team of warnedTeams) {
    if (team.team === 'orchestrator') {
      lines.push('- orchestrator는 payload schema 경고와 gateway rate limit을 우선 점검하는 편이 좋습니다.');
    } else if (team.team === 'claude') {
      lines.push('- claude는 shadow mismatch를 계속 추적해야 합니다. 서비스 다운보다 품질 편차 점검이 우선입니다.');
    } else {
      lines.push(`- ${team.team} 팀은 health 경고 사유를 먼저 확인하세요: ${team.reasons[0] || '원인 확인 필요'}`);
    }
  }

  if (auxiliary.errorReview?.ok) {
    const repeated = auxiliary.errorReview.data?.repeated?.[0];
    if (repeated) {
      lines.push(`- 반복 오류 최상위는 \`${repeated.label} / ${repeated.categoryLabel}\` ${Number(repeated.count || 0).toLocaleString()}회입니다. 이 경로를 우선 보정하는 편이 효율적입니다.`);
    }
  }

  if (!lines.length) {
    lines.push('- 오늘 기준으로는 치명적 운영 이상보다 세부 품질 경고 위주입니다. 설정값 변경보다 경고 원인 정리가 우선입니다.');
  }

  return lines;
}

function buildTextReport(report) {
  const lines = [];
  lines.push('📙 일일 운영 분석 입력 요약');
  lines.push('');
  lines.push('팀 헬스 요약:');
  for (const item of report.teamSummaries) {
    lines.push(`- ${item.team}: source=${item.source}, level=${item.level}, ok=${item.okCount}, warn=${item.warnCount}`);
    if (item.reasons[0]) lines.push(`  사유: ${item.reasons[0]}`);
    if (item.healthError) lines.push(`  입력 오류: ${item.healthError}`);
  }
  lines.push('');
  lines.push('보조 입력 상태:');
  for (const [key, value] of Object.entries(report.auxiliary)) {
    lines.push(`- ${key}: ${value.ok ? 'ok' : `failed (${value.error})`}`);
  }
  lines.push('');
  lines.push('추천:');
  for (const line of report.recommendations) lines.push(line);
  return lines.join('\n');
}

async function main() {
  const { json } = parseArgs();
  const launchctlRows = loadLaunchctlState();

  const teamResults = [];
  for (const item of TEAM_HEALTH_COMMANDS) {
    const result = runSafeNodeJson(item.script, ['--json']);
    if (result.ok) {
      teamResults.push({ team: item.team, ...result });
    } else {
      teamResults.push(await buildFallbackTeamResult(item.team, result.error, launchctlRows));
    }
  }

  const auxiliary = {};
  for (const item of AUXILIARY_COMMANDS) {
    auxiliary[item.key] = runSafeNodeJson(item.script, item.args);
  }

  const teamSummaries = teamResults.filter((item) => item.ok).map((item) => toSummaryLine(item.team, item.data));
  const report = {
    generatedAt: new Date().toISOString(),
    sourcePriority: ['health-report', 'fallback_probe', 'auxiliary_review'],
    teamResults,
    auxiliary,
    teamSummaries,
    recommendations: buildRecommendations(teamSummaries, auxiliary),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${buildTextReport(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
