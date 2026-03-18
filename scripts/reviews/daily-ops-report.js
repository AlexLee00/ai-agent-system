#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync, execSync, spawnSync } = require('child_process');
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

const FALLBACK_FILE_ACTIVITY = {
  investment: {
    filePath: '/tmp/investment-health-check.log',
    staleMs: 30 * 60 * 1000,
    label: 'investment health-check log',
  },
  reservation: {
    filePath: '/tmp/naver-ops-mode.log',
    staleMs: 20 * 60 * 1000,
    label: 'naver-monitor log',
  },
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

function classifyHealthError(errorText, source = '') {
  const text = String(errorText || '').toLowerCase();
  const sourceText = String(source || '').toLowerCase();
  if (!text) {
    if (sourceText.includes('probe_unavailable')) return 'probe_unavailable';
    return 'unknown_error';
  }
  if (text.includes('eperm')) {
    if (text.includes('pg-pool') || text.includes('node_modules/pg-pool')) return 'db_sandbox_restricted';
    if (text.includes('launchctl')) return 'launchctl_sandbox_restricted';
    if (text.includes('curl') || text.includes('healthz') || text.includes('127.0.0.1')) return 'probe_sandbox_restricted';
    return 'sandbox_restricted';
  }
  if (text.includes('econnrefused') || text.includes('connection refused')) return 'service_unreachable';
  if (text.includes('json payload not found')) return 'json_payload_missing';
  if (text.includes('timed out') || text.includes('timeout')) return 'timeout';
  if (text.includes('launchctl')) return 'launchctl_failed';
  if (text.includes('healthz') || text.includes('127.0.0.1') || text.includes('probe')) return 'probe_unavailable';
  if (sourceText.includes('probe_unavailable')) return 'probe_unavailable';
  return 'script_failed';
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
    output = execSync('launchctl list', {
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

function buildFileActivityTeamHealth(team) {
  const config = FALLBACK_FILE_ACTIVITY[team];
  if (!config) {
    return { okCount: 0, warnCount: 0, ok: [], warn: [] };
  }

  try {
    const stat = fs.statSync(config.filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    const minutesAgo = Math.floor(ageMs / 60000);
    if (ageMs > config.staleMs) {
      return {
        okCount: 0,
        warnCount: 1,
        ok: [],
        warn: [`  ${config.label}: ${minutesAgo}분 무활동`],
      };
    }
    return {
      okCount: 1,
      warnCount: 0,
      ok: [`  ${config.label}: 최근 ${minutesAgo}분 이내 활동`],
      warn: [],
    };
  } catch {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  ${config.label}: 파일 없음`],
    };
  }
}

function mergeHealthSignals(...signals) {
  return signals.reduce((acc, signal) => ({
    okCount: acc.okCount + Number(signal?.okCount || 0),
    warnCount: acc.warnCount + Number(signal?.warnCount || 0),
    ok: [...acc.ok, ...(signal?.ok || [])],
    warn: [...acc.warn, ...(signal?.warn || [])],
  }), { okCount: 0, warnCount: 0, ok: [], warn: [] });
}

function buildLocalFallbackMeta(mergedHealth, hasFallbackSignal) {
  if (!hasFallbackSignal) {
    return {
      enabled: false,
      status: 'missing',
      summary: 'local fallback 신호 없음',
    };
  }

  const status = mergedHealth.warnCount > 0 ? 'warn' : 'active';
  return {
    enabled: true,
    status,
    okCount: mergedHealth.okCount,
    warnCount: mergedHealth.warnCount,
    summary: status === 'warn'
      ? `local fallback 경고 ${mergedHealth.warnCount}건`
      : `local fallback 활동 신호 ${mergedHealth.okCount}건`,
  };
}

function classifySourceMode(source, data = {}) {
  const normalized = String(source || '').toLowerCase();
  if (normalized === 'health-report') return 'live';
  if (normalized === 'fallback_probe') return 'endpoint_fallback';
  if (normalized === 'health_report_failed_local_fallback') return 'local_fallback';
  if (normalized === 'error-review') return 'auxiliary_review';
  if (normalized === 'auxiliary_review_failed') return 'auxiliary_review_failed';
  if (normalized.includes('probe_unavailable')) return 'unavailable';
  if (data?.localFallback?.enabled) return 'local_fallback';
  return 'unknown';
}

async function buildFallbackTeamResult(team, healthError = null, launchctlRows = {}) {
  const launchdHealth = buildLaunchdTeamHealth(team, launchctlRows);
  const fileHealth = buildFileActivityTeamHealth(team);
  const endpoints = FALLBACK_TEAM_PROBES[team] || [];
  const failureCode = classifyHealthError(healthError, endpoints.length ? 'health_report_failed_probe_unavailable' : 'health_report_failed_no_probe');
  if (!endpoints.length) {
    const mergedHealth = mergeHealthSignals(launchdHealth, fileHealth);
    const hasFallbackSignal = mergedHealth.okCount > 0 || mergedHealth.warnCount > 0;
    const localFallback = buildLocalFallbackMeta(mergedHealth, hasFallbackSignal);
    return {
      team,
      ok: true,
      data: {
        source: hasFallbackSignal ? 'health_report_failed_local_fallback' : 'health_report_failed_probe_unavailable',
        failureCode: hasFallbackSignal ? failureCode : 'no_probe_configured',
        localFallback,
        serviceHealth: hasFallbackSignal ? mergedHealth : { okCount: 0, warnCount: 0, ok: [], warn: [] },
        decision: {
          level: mergedHealth.warnCount > 0 ? 'medium' : 'hold',
          recommended: mergedHealth.warnCount > 0,
          reasons: [
            hasFallbackSignal
              ? `health-report 실행 실패로 로컬 fallback 신호(launchd/log activity) 기준 상태를 요약했습니다.${healthError ? ` (${healthError})` : ''}`
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
    const mergedHealth = mergeHealthSignals(launchdHealth, fileHealth);
    const hasFallbackSignal = mergedHealth.okCount > 0 || mergedHealth.warnCount > 0;
    const localFallback = buildLocalFallbackMeta(mergedHealth, hasFallbackSignal);
    return {
      team,
      ok: true,
      data: {
        source: hasFallbackSignal ? 'health_report_failed_local_fallback' : 'health_report_failed_probe_unavailable',
        failureCode: hasFallbackSignal ? failureCode : failureCode,
        localFallback,
        serviceHealth: hasFallbackSignal
          ? mergedHealth
          : {
              okCount: 0,
              warnCount: 0,
              ok: [],
              warn: [],
            },
        decision: {
          level: mergedHealth.warnCount > 0 ? 'medium' : 'hold',
          recommended: mergedHealth.warnCount > 0,
          reasons: [
            hasFallbackSignal
              ? `endpoint probe는 비었지만 로컬 fallback 신호(launchd/log activity)를 보수적으로 사용했습니다.${healthError ? ` (${healthError})` : ''}`
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
      localFallback: {
        enabled: false,
        status: 'not_used',
        summary: 'endpoint probe 사용',
      },
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
  const source = data?.source || 'health-report';
  return {
    team,
    source,
    sourceMode: classifySourceMode(source, data),
    level: decision.level || 'unknown',
    recommended: Boolean(decision.recommended),
    okCount: Number(service.okCount || 0),
    warnCount: Number(service.warnCount || 0),
    reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
    healthError: data?.healthError || null,
    failureCode: data?.failureCode || null,
    localFallback: data?.localFallback || null,
  };
}

function buildRecommendations(teamSummaries, auxiliary) {
  const lines = [];
  const warnedTeams = teamSummaries.filter((item) => item.warnCount > 0 || item.recommended);
  const dbSandboxTeams = teamSummaries.filter((item) => item.failureCode === 'db_sandbox_restricted');
  const dbSandboxWithFallbackTeams = dbSandboxTeams.filter((item) => item.localFallback?.enabled);
  const dbSandboxWithoutFallbackTeams = dbSandboxTeams.filter((item) => !item.localFallback?.enabled);
  const noProbeTeams = teamSummaries.filter((item) => item.failureCode === 'no_probe_configured');
  const unavailableTeams = teamSummaries.filter((item) => item.sourceMode === 'unavailable');

  if (dbSandboxWithFallbackTeams.length) {
    lines.push(`- ${dbSandboxWithFallbackTeams.map((item) => item.team).join(', ')} 팀은 health-report DB 제한이 있지만 local fallback 활동 신호는 살아 있습니다. 운영 런타임 DB 제한 해소 전까지는 fallback 신호를 보조 기준으로 보세요.`);
  }

  if (dbSandboxWithoutFallbackTeams.length) {
    lines.push(`- ${dbSandboxWithoutFallbackTeams.map((item) => item.team).join(', ')} 팀은 health-report 실행 자체보다 현재 실행 컨텍스트의 DB 제한을 먼저 풀어야 합니다.`);
  }

  if (noProbeTeams.length) {
    lines.push(`- ${noProbeTeams.map((item) => item.team).join(', ')} 팀은 fallback probe가 없어 관측 공백이 큽니다. launchd 외 대체 신호를 설계하는 편이 좋습니다.`);
  }

  if (unavailableTeams.length && !dbSandboxWithoutFallbackTeams.length) {
    lines.push(`- ${unavailableTeams.map((item) => item.team).join(', ')} 팀은 현재 관측 source가 unavailable 상태라, endpoint 또는 local fallback 신호를 더 보강하는 편이 좋습니다.`);
  }

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

function buildActiveIssues(teamSummaries, auxiliary) {
  const items = [];

  for (const item of teamSummaries) {
    if ((item.warnCount || 0) > 0 || item.recommended) {
      items.push({
        team: item.team,
        level: item.level,
        source: item.source,
        sourceMode: item.sourceMode || 'unknown',
        summary: item.reasons[0] || '원인 확인 필요',
      });
    }
  }

  const repeated = auxiliary.errorReview?.ok
    ? auxiliary.errorReview.data?.repeated?.[0]
    : null;
  if (repeated) {
    items.push({
      team: 'global',
      level: 'medium',
      source: 'error-review',
      sourceMode: classifySourceMode('error-review'),
      summary: `반복 오류 상위: ${repeated.label} / ${repeated.categoryLabel} ${Number(repeated.count || 0).toLocaleString()}회`,
    });
  }

  return items;
}

function buildHistoricalIssues(auxiliary) {
  const items = [];
  const repeated = auxiliary.errorReview?.ok
    ? auxiliary.errorReview.data?.repeated || []
    : [];

  for (const row of repeated.slice(0, 5)) {
    items.push({
      label: row.label,
      category: row.categoryLabel,
      count: Number(row.count || 0),
      sample: row.sample || null,
    });
  }

  return items;
}

function buildInputFailures(teamSummaries, auxiliary) {
  const teamFailures = teamSummaries
    .filter((item) => item.healthError || String(item.source || '').includes('failed'))
    .map((item) => ({
      kind: 'team_health',
      target: item.team,
      source: item.source,
      sourceMode: item.sourceMode || 'unknown',
      code: item.failureCode || classifyHealthError(item.healthError || item.source, item.source),
      error: item.healthError || item.reasons[0] || '입력 실패',
      fallbackStatus: item.localFallback?.enabled ? item.localFallback.summary : null,
    }));

  const auxiliaryFailures = Object.entries(auxiliary)
    .filter(([, value]) => !value.ok)
    .map(([key, value]) => ({
      kind: 'auxiliary',
      target: key,
      source: 'auxiliary_review_failed',
      code: classifyHealthError(value.error, 'auxiliary_review_failed'),
      error: value.error || '입력 실패',
    }));

  return [...teamFailures, ...auxiliaryFailures];
}

function buildTextReport(report) {
  const lines = [];
  lines.push('📙 일일 운영 분석');
  lines.push('');

  lines.push('현재 활성 이슈:');
  if (report.activeIssues.length === 0) {
    lines.push('- 없음');
  } else {
    for (const item of report.activeIssues) {
      lines.push(`- ${item.team}: level=${item.level}, source=${item.source}`);
      lines.push(`  sourceMode: ${item.sourceMode || 'unknown'}`);
      lines.push(`  사유: ${item.summary}`);
    }
  }

  lines.push('');

  lines.push('누적 반복 이슈:');
  if (report.historicalIssues.length === 0) {
    lines.push('- 없음');
  } else {
    for (const item of report.historicalIssues) {
      lines.push(`- ${item.label} / ${item.category}: ${item.count}회`);
      if (item.sample) lines.push(`  예시: ${item.sample}`);
    }
  }

  lines.push('');
  lines.push('입력 실패:');
  if (report.inputFailures.length === 0) {
    lines.push('- 없음');
  } else {
    for (const item of report.inputFailures) {
      lines.push(`- ${item.target}: source=${item.source}, sourceMode=${item.sourceMode || 'unknown'}, code=${item.code || 'unknown_error'}`);
      lines.push(`  오류: ${item.error}`);
      if (item.fallbackStatus) lines.push(`  보조 신호: ${item.fallbackStatus}`);
    }
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
  const activeIssues = buildActiveIssues(teamSummaries, auxiliary);
  const historicalIssues = buildHistoricalIssues(auxiliary);
  const inputFailures = buildInputFailures(teamSummaries, auxiliary);
  const report = {
    generatedAt: new Date().toISOString(),
    sourcePriority: ['health-report', 'fallback_probe', 'auxiliary_review'],
    teamResults,
    auxiliary,
    teamSummaries,
    activeIssues,
    historicalIssues,
    inputFailures,
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

module.exports = {
  parseArgs,
  runNodeJson,
  runSafeNodeJson,
  buildFallbackTeamResult,
  toSummaryLine,
  buildRecommendations,
  buildActiveIssues,
  buildHistoricalIssues,
  buildInputFailures,
  classifyHealthError,
  buildTextReport,
};
