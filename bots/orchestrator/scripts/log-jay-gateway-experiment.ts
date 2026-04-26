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
const FALLBACK_OUTPUT = path.join(REPO_ROOT, 'tmp', 'jay-selector-experiments.jsonl');

function getAiAgentHome() {
  return process.env.AI_AGENT_HOME || process.env.JAY_HOME || path.join(os.homedir(), '.ai-agent-system');
}

function getAiAgentWorkspace() {
  return process.env.AI_AGENT_WORKSPACE || process.env.JAY_WORKSPACE || path.join(getAiAgentHome(), 'workspace');
}

const DEFAULT_WORKSPACE_OUTPUT = path.join(getAiAgentWorkspace(), 'jay-selector-experiments.jsonl');

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

function summarizeGatewayLogs(hours) {
  return {
    retiredGateway: true,
    observedHours: hours,
    paths: {
      errorLog: null,
      outputLog: null,
    },
    windowLabel: 'hub_selector',
    lineCount: 0,
    rateLimitCount: 0,
    uniqueRateLimitIncidentCount: 0,
    failoverErrorCount: 0,
    nonAuthFailoverErrorCount: 0,
    providerAuthMissingCount: 0,
    embeddedRateLimitRuns: {
      uniqueRunCount: 0,
      retryBurstCount: 0,
      maxAttemptsPerRun: 0,
      topBurstRuns: [],
    },
    activeEmbeddedRateLimitRuns: {
      uniqueRunCount: 0,
      retryBurstCount: 0,
      maxAttemptsPerRun: 0,
      topBurstRuns: [],
    },
    staleSocketRestartCount: 0,
    schemaSnapshotCount: 0,
    activeRateLimitCount: 0,
    activeUniqueRateLimitIncidentCount: 0,
    lastRateLimitAt: null,
    lastStaleSocketRestartAt: null,
    postRestart: null,
    note: 'retired gateway 로그는 더 이상 운영 판단에 사용하지 않습니다. Hub selector usage/cooldown 지표를 기준으로 전환합니다.',
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
  const resolvedScriptPath = fs.existsSync(scriptPath)
    ? scriptPath
    : scriptPath.replace(/\.js$/, '.ts');
  const command = resolvedScriptPath.endsWith('.ts') ? 'npx' : process.execPath;
  const commandArgs = resolvedScriptPath.endsWith('.ts')
    ? ['tsx', resolvedScriptPath, ...args]
    : [resolvedScriptPath, ...args];
  try {
    const raw = execFileSync(command, commandArgs, {
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

  return {
    capturedAt: new Date().toISOString(),
    observedHours: hours,
    experimentStage: deriveExperimentStage({
      gatewayMetrics,
      primaryCheck,
      orchestratorHealth: healthReport.ok ? healthReport.data : null,
    }),
    primaryCheck: {
      retiredGateway: true,
      runtimePrimary: primaryCheck.runtimePrimary,
      selectorPrimary: primaryCheck.selectorPrimary,
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
  lines.push('🤖 제이 Hub selector 전환 실험 로그');
  lines.push('');
  lines.push(`기록 시각: ${snapshot.capturedAt}`);
  lines.push(`관찰 구간: 최근 ${snapshot.observedHours}시간`);
  lines.push(`현재 단계: ${snapshot.experimentStage}`);
  lines.push(`정합성: ${snapshot.primaryCheck.aligned ? '표준 경로 사용' : '확인 필요'}`);
  lines.push(`runtime/selector primary: ${snapshot.primaryCheck.runtimePrimary} / ${snapshot.primaryCheck.selectorPrimary || '확인 불가'}`);
  lines.push('');
  lines.push('retired gateway 지표:');
  lines.push(`- ${snapshot.gatewayMetrics.note}`);
  lines.push(`- legacy rate limit: ${snapshot.gatewayMetrics.rateLimitCount}건 (활성 ${snapshot.gatewayMetrics.activeRateLimitCount}건)`);
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
