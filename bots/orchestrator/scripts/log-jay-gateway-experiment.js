#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildPayload } = require('./check-jay-gateway-primary');
const { collectJayUsage } = require('../../../scripts/reviews/lib/jay-usage');

const DEFAULT_HOURS = 24;
const ACTIVE_WINDOW_HOURS = 3;

function parseArgs(argv = process.argv.slice(2)) {
  const hoursArg = argv.find((arg) => arg.startsWith('--hours='));
  const outputArg = argv.find((arg) => arg.startsWith('--output='));
  const hours = Math.max(1, Number(hoursArg?.split('=')[1] || DEFAULT_HOURS));
  const outputPath = outputArg?.split('=').slice(1).join('=') || path.join(os.homedir(), '.openclaw', 'workspace', 'jay-gateway-experiments.jsonl');
  return {
    hours,
    outputPath,
    json: argv.includes('--json'),
    write: argv.includes('--write'),
  };
}

function safeReadLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function parseLogTimestamp(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  if (!match) return null;
  const ts = new Date(match[1]).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function filterRecentLines(lines, hours) {
  const minTs = Date.now() - (hours * 60 * 60 * 1000);
  return lines.filter((line) => {
    const ts = parseLogTimestamp(line);
    return Number.isFinite(ts) && ts >= minTs;
  });
}

function getLastTimestamp(lines, pattern) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!pattern.test(lines[i])) continue;
    const ts = parseLogTimestamp(lines[i]);
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  return null;
}

function countMatches(lines, pattern) {
  return lines.reduce((sum, line) => sum + (pattern.test(line) ? 1 : 0), 0);
}

function summarizeGatewayLogs(hours) {
  const gatewayErrPath = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.err.log');
  const gatewayLogPath = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log');
  const errLines = filterRecentLines(safeReadLines(gatewayErrPath), hours);
  const outLines = filterRecentLines(safeReadLines(gatewayLogPath), hours);
  const activeLines = filterRecentLines(errLines, ACTIVE_WINDOW_HOURS);

  const rateLimitPattern = /API rate limit reached/i;
  const failoverPattern = /FailoverError/i;
  const staleSocketPattern = /health-monitor: restarting \(reason: stale-socket\)/i;
  const schemaSnapshotPattern = /google tool schema snapshot/i;

  return {
    observedHours: hours,
    paths: {
      errorLog: gatewayErrPath,
      outputLog: gatewayLogPath,
    },
    rateLimitCount: countMatches(errLines, rateLimitPattern),
    failoverErrorCount: countMatches(errLines, failoverPattern),
    staleSocketRestartCount: countMatches(outLines, staleSocketPattern),
    schemaSnapshotCount: countMatches(outLines, schemaSnapshotPattern),
    activeRateLimitCount: countMatches(activeLines, rateLimitPattern),
    lastRateLimitAt: getLastTimestamp(errLines, rateLimitPattern),
    lastStaleSocketRestartAt: getLastTimestamp(outLines, staleSocketPattern),
  };
}

function topJayUsageModels(jayUsage, limit = 5) {
  return Object.values(jayUsage.byModel || {})
    .sort((a, b) => Number(b.totalTokens || 0) - Number(a.totalTokens || 0))
    .slice(0, limit)
    .map((row) => ({
      provider: row.provider,
      model: row.model,
      calls: Number(row.calls || 0),
      totalTokens: Number(row.totalTokens || 0),
    }));
}

function safeExecJson(scriptPath, args = []) {
  try {
    const raw = execFileSync('node', [scriptPath, ...args], {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      error: error.stderr?.toString().trim() || error.message,
    };
  }
}

function deriveExperimentStage({ gatewayMetrics, primaryCheck, orchestratorHealth }) {
  if (!primaryCheck.aligned) return 'sync_first';
  if (gatewayMetrics.activeRateLimitCount > 0) return 'compare';
  if (orchestratorHealth?.decision?.level && orchestratorHealth.decision.level !== 'hold') return 'compare';
  return 'hold';
}

function buildSnapshot(hours) {
  const primaryCheck = buildPayload();
  const gatewayMetrics = summarizeGatewayLogs(hours);
  const jayUsage = collectJayUsage({ days: Math.max(1, Math.ceil(hours / 24)) });
  const healthReport = safeExecJson(
    path.join(__dirname, 'health-report.js'),
    ['--json'],
  );
  const jayReview = safeExecJson(
    path.join(__dirname, '..', '..', '..', 'scripts', 'reviews', 'jay-llm-daily-review.js'),
    [`--days=${Math.max(1, Math.ceil(hours / 24))}`, '--json'],
  );

  const snapshot = {
    capturedAt: new Date().toISOString(),
    observedHours: hours,
    experimentStage: deriveExperimentStage({
      gatewayMetrics,
      primaryCheck,
      orchestratorHealth: healthReport.ok ? healthReport.data : null,
    }),
    primaryCheck: {
      runtimePrimary: primaryCheck.runtimePrimary,
      openclawPrimary: primaryCheck.openclawPrimary,
      aligned: primaryCheck.aligned,
      recommendation: primaryCheck.recommendation,
      candidates: primaryCheck.candidateProfiles.map((profile) => ({
        key: profile.key,
        model: profile.model,
        configured: profile.configured,
      })),
    },
    gatewayMetrics,
    orchestratorHealth: healthReport.ok
      ? {
          okCount: healthReport.data.okCount,
          warnCount: healthReport.data.warnCount,
          errorCount: healthReport.data.errorCount,
          decision: healthReport.data.decision,
        }
      : {
          error: healthReport.error,
        },
    jayUsage: {
      totalCalls: Number(jayUsage.total.calls || 0),
      totalTokens: Number(jayUsage.total.totalTokens || 0),
      topModels: topJayUsageModels(jayUsage),
    },
    jayReview: jayReview.ok
      ? {
          recommendations: jayReview.data.recommendations || [],
          llmUsageTop: Array.isArray(jayReview.data.llmUsage)
            ? jayReview.data.llmUsage.slice(0, 5).map((row) => ({
                requestType: row.request_type,
                model: row.model,
                calls: Number(row.calls || 0),
                failedCalls: Number(row.failed_calls || 0),
                avgLatencyMs: Math.round(Number(row.avg_latency_ms || 0)),
              }))
            : [],
        }
      : {
          error: jayReview.error,
        },
  };

  return snapshot;
}

function persistSnapshot(snapshot, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function printHuman(snapshot, outputPath, willWrite) {
  const lines = [];
  lines.push('🤖 제이 gateway 전환 실험 로그');
  lines.push('');
  lines.push(`기록 시각: ${snapshot.capturedAt}`);
  lines.push(`관찰 구간: 최근 ${snapshot.observedHours}시간`);
  lines.push(`현재 단계: ${snapshot.experimentStage}`);
  lines.push(`정합성: ${snapshot.primaryCheck.aligned ? '일치' : '불일치'}`);
  lines.push(`runtime/openclaw primary: ${snapshot.primaryCheck.runtimePrimary} / ${snapshot.primaryCheck.openclawPrimary || '확인 불가'}`);
  lines.push('');
  lines.push('gateway 지표:');
  lines.push(`- rate limit: ${snapshot.gatewayMetrics.rateLimitCount}건 (최근 ${ACTIVE_WINDOW_HOURS}시간 활성 ${snapshot.gatewayMetrics.activeRateLimitCount}건)`);
  lines.push(`- failover error: ${snapshot.gatewayMetrics.failoverErrorCount}건`);
  lines.push(`- stale socket restart: ${snapshot.gatewayMetrics.staleSocketRestartCount}건`);
  lines.push(`- 마지막 rate limit: ${snapshot.gatewayMetrics.lastRateLimitAt || '없음'}`);
  lines.push('');
  lines.push('제이 usage:');
  lines.push(`- 총 호출: ${snapshot.jayUsage.totalCalls}회`);
  lines.push(`- 총 토큰: ${snapshot.jayUsage.totalTokens}`);
  if (snapshot.orchestratorHealth?.decision?.level) {
    lines.push('');
    lines.push(`오케스트레이터 health: ${snapshot.orchestratorHealth.decision.level}`);
  }
  if (snapshot.jayReview?.error) {
    lines.push('');
    lines.push(`참고: jay-llm-daily-review 직접 호출은 실패했습니다 (${snapshot.jayReview.error})`);
  }
  if (willWrite) {
    lines.push('');
    lines.push(`저장 파일: ${outputPath}`);
  }
  return lines.join('\n');
}

function main() {
  const { hours, json, write, outputPath } = parseArgs();
  const snapshot = buildSnapshot(hours);

  if (write) {
    persistSnapshot(snapshot, outputPath);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ outputPath, snapshot }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${printHuman(snapshot, outputPath, write)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`❌ log-jay-gateway-experiment 실패: ${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildSnapshot,
  summarizeGatewayLogs,
  parseArgs,
  persistSnapshot,
};
