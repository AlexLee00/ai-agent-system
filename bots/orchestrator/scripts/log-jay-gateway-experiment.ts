// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildPayload } = require('./check-jay-gateway-primary');
const { collectJayUsage } = require('../../../scripts/reviews/lib/jay-usage');

const DEFAULT_HOURS = 24;
const ACTIVE_WINDOW_HOURS = 3;
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const DEFAULT_WORKSPACE_OUTPUT = path.join(os.homedir(), '.openclaw', 'workspace', 'jay-gateway-experiments.jsonl');
const FALLBACK_OUTPUT = path.join(REPO_ROOT, 'tmp', 'jay-gateway-experiments.jsonl');

function parseArgs(argv = process.argv.slice(2)) {
  const hoursArg = argv.find((arg) => arg.startsWith('--hours='));
  const outputArg = argv.find((arg) => arg.startsWith('--output='));
  const hours = Math.max(1, Number(hoursArg?.split('=')[1] || DEFAULT_HOURS));
  const outputPath = outputArg?.split('=').slice(1).join('=') || DEFAULT_WORKSPACE_OUTPUT;
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

function findLastLineIndex(lines, pattern) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
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

function countUniqueIncidents(lines, pattern) {
  const seen = new Set();
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    const ts = parseLogTimestamp(line);
    const normalized = line
      .replace(/lane=[^ ]+/g, 'lane=*')
      .replace(/durationMs=\d+/g, 'durationMs=*')
      .trim();
    const key = `${Number.isFinite(ts) ? ts : 'na'}|${normalized}`;
    seen.add(key);
  }
  return seen.size;
}

function summarizeEmbeddedRateLimitRuns(lines) {
  const counts = {};
  for (const line of lines) {
    if (!/API rate limit reached/i.test(line)) continue;
    const match = line.match(/runId=([A-Za-z0-9._:-]+)/);
    if (!match) continue;
    const runId = match[1];
    counts[runId] = (counts[runId] || 0) + 1;
  }
  const entries = Object.entries(counts).map(([runId, count]) => ({ runId, count }));
  return {
    uniqueRunCount: entries.length,
    retryBurstCount: entries.filter((item) => item.count > 1).length,
    maxAttemptsPerRun: entries.reduce((max, item) => Math.max(max, item.count), 0),
    topBurstRuns: entries
      .filter((item) => item.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

function summarizeGatewayWindow({ errLines, outLines, activeLines, observedHours, windowLabel }) {
  const rateLimitPattern = /API rate limit reached/i;
  const failoverPattern = /FailoverError/i;
  const providerAuthMissingPattern = /No API key found for provider/i;
  const staleSocketPattern = /health-monitor: restarting \(reason: stale-socket\)/i;
  const schemaSnapshotPattern = /google tool schema snapshot/i;

  const rateLimitCount = countMatches(errLines, rateLimitPattern);
  const activeRateLimitCount = countMatches(activeLines, rateLimitPattern);
  const providerAuthMissingCount = countMatches(errLines, providerAuthMissingPattern);
  const uniqueRateLimitIncidentCount = countUniqueIncidents(errLines, rateLimitPattern);
  const activeUniqueRateLimitIncidentCount = countUniqueIncidents(activeLines, rateLimitPattern);
  const failoverErrorCount = countMatches(errLines, failoverPattern);
  const nonAuthFailoverErrorCount = errLines.reduce((sum, line) => {
    if (!failoverPattern.test(line)) return sum;
    if (providerAuthMissingPattern.test(line)) return sum;
    return sum + 1;
  }, 0);
  const embeddedRateLimitRuns = summarizeEmbeddedRateLimitRuns(errLines);
  const activeEmbeddedRateLimitRuns = summarizeEmbeddedRateLimitRuns(activeLines);

  return {
    windowLabel,
    observedHours,
    lineCount: errLines.length,
    rateLimitCount,
    uniqueRateLimitIncidentCount,
    failoverErrorCount,
    nonAuthFailoverErrorCount,
    providerAuthMissingCount,
    embeddedRateLimitRuns,
    activeEmbeddedRateLimitRuns,
    staleSocketRestartCount: countMatches(outLines, staleSocketPattern),
    schemaSnapshotCount: countMatches(outLines, schemaSnapshotPattern),
    activeRateLimitCount,
    activeUniqueRateLimitIncidentCount,
    lastRateLimitAt: getLastTimestamp(errLines, rateLimitPattern),
    lastStaleSocketRestartAt: getLastTimestamp(outLines, staleSocketPattern),
  };
}

function summarizeGatewayLogs(hours) {
  const gatewayErrPath = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.err.log');
  const gatewayLogPath = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log');
  const errAllLines = safeReadLines(gatewayErrPath);
  const outAllLines = safeReadLines(gatewayLogPath);
  const errLines = filterRecentLines(errAllLines, hours);
  const outLines = filterRecentLines(outAllLines, hours);
  const activeLines = filterRecentLines(errLines, ACTIVE_WINDOW_HOURS);
  const restartMarkerPattern = /^\[start-gateway\]/;
  const lastRestartErrIndex = findLastLineIndex(errAllLines, restartMarkerPattern);
  const lastRestartOutIndex = findLastLineIndex(outAllLines, restartMarkerPattern);
  const postRestartErrLines = lastRestartErrIndex >= 0 ? errAllLines.slice(lastRestartErrIndex + 1) : [];
  const postRestartOutLines = lastRestartOutIndex >= 0 ? outAllLines.slice(lastRestartOutIndex + 1) : [];
  const postRestartActiveLines = filterRecentLines(postRestartErrLines, ACTIVE_WINDOW_HOURS);

  return {
    observedHours: hours,
    paths: {
      errorLog: gatewayErrPath,
      outputLog: gatewayLogPath,
    },
    ...summarizeGatewayWindow({
      errLines,
      outLines,
      activeLines,
      observedHours: hours,
      windowLabel: 'rolling',
    }),
    postRestart: lastRestartErrIndex >= 0 || lastRestartOutIndex >= 0
      ? summarizeGatewayWindow({
          errLines: postRestartErrLines,
          outLines: postRestartOutLines,
          activeLines: postRestartActiveLines,
          observedHours: hours,
          windowLabel: 'post_restart',
        })
      : null,
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
    const raw = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: REPO_ROOT,
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

function persistSnapshotWithFallback(snapshot, preferredOutputPath) {
  const attempts = [preferredOutputPath, FALLBACK_OUTPUT].filter((value, index, array) => value && array.indexOf(value) === index);
  let lastError = null;

  for (const outputPath of attempts) {
    try {
      persistSnapshot(snapshot, outputPath);
      return {
        ok: true,
        outputPath,
        fallbackUsed: outputPath !== preferredOutputPath,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    outputPath: preferredOutputPath,
    fallbackUsed: false,
    error: lastError,
  };
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
  lines.push(`- unique rate limit incidents: ${snapshot.gatewayMetrics.uniqueRateLimitIncidentCount}건 (최근 ${ACTIVE_WINDOW_HOURS}시간 활성 ${snapshot.gatewayMetrics.activeUniqueRateLimitIncidentCount}건)`);
  lines.push(`- failover error: ${snapshot.gatewayMetrics.failoverErrorCount}건 (auth missing 제외 ${snapshot.gatewayMetrics.nonAuthFailoverErrorCount}건)`);
  lines.push(`- provider auth missing: ${snapshot.gatewayMetrics.providerAuthMissingCount}건`);
  lines.push(`- embedded unique runs: ${snapshot.gatewayMetrics.embeddedRateLimitRuns.uniqueRunCount}건 (재시도 burst ${snapshot.gatewayMetrics.embeddedRateLimitRuns.retryBurstCount}건, 최대 ${snapshot.gatewayMetrics.embeddedRateLimitRuns.maxAttemptsPerRun}회)`);
  lines.push(`- stale socket restart: ${snapshot.gatewayMetrics.staleSocketRestartCount}건`);
  lines.push(`- 마지막 rate limit: ${snapshot.gatewayMetrics.lastRateLimitAt || '없음'}`);
  if (snapshot.gatewayMetrics.postRestart) {
    lines.push('- 마지막 gateway 재기동 이후:');
    lines.push(`  rate limit ${snapshot.gatewayMetrics.postRestart.rateLimitCount}건 / auth missing ${snapshot.gatewayMetrics.postRestart.providerAuthMissingCount}건 / retry burst ${snapshot.gatewayMetrics.postRestart.embeddedRateLimitRuns.retryBurstCount}건 / 최대 ${snapshot.gatewayMetrics.postRestart.embeddedRateLimitRuns.maxAttemptsPerRun}회`);
  }
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
  let finalOutputPath = outputPath;
  let fallbackUsed = false;

  if (write) {
    const persisted = persistSnapshotWithFallback(snapshot, outputPath);
    if (!persisted.ok) {
      throw persisted.error;
    }
    finalOutputPath = persisted.outputPath;
    fallbackUsed = Boolean(persisted.fallbackUsed);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({
      outputPath: finalOutputPath,
      requestedOutputPath: outputPath,
      fallbackUsed,
      snapshot,
    }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${printHuman(snapshot, finalOutputPath, write)}\n`);
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
  persistSnapshotWithFallback,
};
