// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getAiAgentHome() {
  return process.env.AI_AGENT_HOME || process.env.JAY_HOME || path.join(os.homedir(), '.ai-agent-system');
}

function getAiAgentWorkspace() {
  return process.env.AI_AGENT_WORKSPACE || process.env.JAY_WORKSPACE || path.join(getAiAgentHome(), 'workspace');
}

const HISTORY_FILE = path.join(getAiAgentWorkspace(), 'llm-speed-test-history.jsonl');

function parseArgs(argv = process.argv.slice(2)) {
  const days = Math.max(1, Number(argv.find((arg) => arg.startsWith('--days='))?.split('=')[1] || 7));
  const input = argv.find((arg) => arg.startsWith('--input='))?.split('=')[1] || HISTORY_FILE;
  return {
    days,
    input,
    json: argv.includes('--json'),
  };
}

function readHistory(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildModelStats(entries) {
  const stats = new Map();
  for (const snapshot of entries) {
    for (const result of snapshot.results || []) {
      if (!result?.modelId) continue;
      if (!stats.has(result.modelId)) {
        stats.set(result.modelId, {
          modelId: result.modelId,
          provider: result.provider || 'unknown',
          okRuns: 0,
          failedRuns: 0,
          ttftTotal: 0,
          totalTotal: 0,
          lastSeenAt: snapshot.capturedAt || null,
        });
      }
      const item = stats.get(result.modelId);
      if (result.ok === true) {
        item.okRuns += 1;
        item.ttftTotal += Number(result.ttft || 0);
        item.totalTotal += Number(result.total || 0);
      } else {
        item.failedRuns += 1;
      }
      if (!item.lastSeenAt || new Date(snapshot.capturedAt) > new Date(item.lastSeenAt)) {
        item.lastSeenAt = snapshot.capturedAt;
      }
    }
  }
  return Array.from(stats.values())
    .map((item) => ({
      ...item,
      avgTtft: item.okRuns ? Math.round(item.ttftTotal / item.okRuns) : null,
      avgTotal: item.okRuns ? Math.round(item.totalTotal / item.okRuns) : null,
      successRatePct: item.okRuns + item.failedRuns
        ? Number(((item.okRuns / (item.okRuns + item.failedRuns)) * 100).toFixed(1))
        : 0,
    }))
    .sort((a, b) => {
      if (a.avgTtft == null && b.avgTtft == null) return 0;
      if (a.avgTtft == null) return 1;
      if (b.avgTtft == null) return -1;
      return a.avgTtft - b.avgTtft;
    });
}

function inferPrimaryFallbackCandidate(latest, modelStats, latestPrimaryResult) {
  const currentPrimary = latest?.current || null;
  if (!currentPrimary || !latestPrimaryResult || latestPrimaryResult.ok === true) return null;

  const [provider] = currentPrimary.split('/');
  const latestResults = latest?.results || [];
  const providerCandidates = latestResults
    .filter((result) => result?.provider === provider && result?.ok === true)
    .map((result) => {
      const stat = modelStats.find((item) => item.modelId === result.modelId) || null;
      return {
        modelId: result.modelId,
        provider,
        ttft: result.ttft ?? stat?.avgTtft ?? null,
        total: result.total ?? stat?.avgTotal ?? null,
        successRatePct: stat?.successRatePct ?? 100,
      };
    })
    .sort((a, b) => {
      if (a.ttft == null && b.ttft == null) return 0;
      if (a.ttft == null) return 1;
      if (b.ttft == null) return -1;
      return a.ttft - b.ttft;
    });

  const sameFamilyFlashLite = providerCandidates.find((item) => item.modelId.includes('flash-lite'));
  return sameFamilyFlashLite || providerCandidates[0] || null;
}

function buildRecentPrimaryHealthHistory(filtered, currentPrimary, latestCapturedAt) {
  if (!currentPrimary) return [];
  return filtered
    .slice(-5)
    .map((snapshot) => {
      const result = (snapshot.results || []).find((item) => item?.modelId === currentPrimary) || null;
      const health = result?.ok === true
        ? 'healthy'
        : result?.errorClass === 'rate_limited'
          ? 'rate_limited'
          : result
            ? 'degraded'
            : 'unavailable';
      return {
        capturedAt: snapshot.capturedAt || null,
        isLatest: snapshot.capturedAt === latestCapturedAt,
        health,
        errorClass: result?.errorClass || null,
      };
    });
}

function inferPrimaryFallbackPolicy(primaryHealthHistory, primaryFallbackCandidate) {
  if (!primaryFallbackCandidate || primaryHealthHistory.length === 0) {
    return {
      decision: 'hold',
      reason: 'fallback_candidate_absent',
      consecutivePrimaryIssues: 0,
    };
  }

  let consecutivePrimaryIssues = 0;
  for (let i = primaryHealthHistory.length - 1; i >= 0; i -= 1) {
    if (primaryHealthHistory[i].health === 'healthy') break;
    consecutivePrimaryIssues += 1;
  }

  if (consecutivePrimaryIssues >= 2 && primaryHealthHistory[primaryHealthHistory.length - 1]?.health === 'rate_limited') {
    return {
      decision: 'temporary_fallback_candidate',
      reason: 'primary_rate_limited_consecutive',
      consecutivePrimaryIssues,
    };
  }

  if (consecutivePrimaryIssues >= 1) {
    return {
      decision: 'observe',
      reason: 'primary_issue_recent',
      consecutivePrimaryIssues,
    };
  }

  return {
    decision: 'hold',
    reason: 'primary_healthy',
    consecutivePrimaryIssues,
  };
}

function buildReview(entries, days, inputPath = HISTORY_FILE) {
  const rows = Array.isArray(entries) ? entries : readHistory(inputPath);
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  const filtered = rows.filter((entry) => {
    const captured = new Date(entry.capturedAt || 0).getTime();
    return Number.isFinite(captured) && captured >= cutoff;
  });
  const latest = filtered[filtered.length - 1] || null;
  const modelStats = buildModelStats(filtered);
  const top = modelStats.slice(0, 5);
  const latestFailures = (latest?.results || [])
    .filter((result) => result?.ok === false)
    .map((result) => ({
      modelId: result.modelId,
      provider: result.provider || 'unknown',
      errorClass: result.errorClass || null,
      error: result.error || null,
    }));
  const latestPrimaryResult = (latest?.results || [])
    .find((result) => result?.modelId === (latest?.current || null)) || null;
  const primaryHealth = !latest?.current
    ? 'unknown'
    : latestPrimaryResult?.ok === true
      ? 'healthy'
      : latestPrimaryResult?.errorClass === 'rate_limited'
        ? 'rate_limited'
        : latestPrimaryResult
          ? 'degraded'
          : 'unavailable';
  const primaryFallbackCandidate = inferPrimaryFallbackCandidate(latest, modelStats, latestPrimaryResult);
  const recentPrimaryHealthHistory = buildRecentPrimaryHealthHistory(filtered, latest?.current || null, latest?.capturedAt || null);
  const primaryFallbackPolicy = inferPrimaryFallbackPolicy(recentPrimaryHealthHistory, primaryFallbackCandidate);

  return {
    days,
    historyFile: inputPath,
    snapshotCount: filtered.length,
    latestCapturedAt: latest?.capturedAt || null,
    currentPrimary: latest?.current || null,
    latestRecommended: latest?.recommended || null,
    latestPrimaryResult: latestPrimaryResult ? {
      modelId: latestPrimaryResult.modelId,
      ok: latestPrimaryResult.ok === true,
      ttft: latestPrimaryResult.ttft ?? null,
      total: latestPrimaryResult.total ?? null,
      errorClass: latestPrimaryResult.errorClass || null,
      error: latestPrimaryResult.error || null,
    } : null,
    primaryHealth,
    primaryFallbackCandidate,
    recentPrimaryHealthHistory,
    primaryFallbackPolicy,
    latestFailures,
    topModels: top,
    recommendation: latest?.recommended && latest?.current && latest.recommended !== latest.current
      ? 'compare'
      : latest?.current
        ? 'hold'
        : 'observe',
  };
}

function printReview(review) {
  if (!review.snapshotCount) {
    process.stdout.write('LLM speed review\n- 최근 speed-test 히스토리가 없습니다.\n');
    return;
  }
  const lines = [
    'LLM speed review',
    `- 기간: 최근 ${review.days}일`,
    `- 스냅샷: ${review.snapshotCount}건`,
    `- latest: ${review.latestCapturedAt || '-'}`,
    `- current: ${review.currentPrimary || '-'}`,
    `- primary health: ${review.primaryHealth}`,
    ...(review.primaryFallbackCandidate ? [`- primary fallback candidate: ${review.primaryFallbackCandidate.modelId}`] : []),
    ...(review.primaryFallbackPolicy ? [`- primary fallback policy: ${review.primaryFallbackPolicy.decision}`] : []),
    `- latest recommended: ${review.latestRecommended || '-'}`,
    `- recommendation: ${review.recommendation}`,
    ...(review.latestFailures?.length ? [`- latest failures: ${review.latestFailures.length}건`] : []),
    '',
    '상위 속도 모델',
    ...review.topModels.map((item, index) =>
      `${index + 1}. ${item.modelId} | avg ttft ${item.avgTtft ?? '-'}ms | avg total ${item.avgTotal ?? '-'}ms | success ${item.successRatePct}%`),
  ];
  if (review.latestFailures?.length) {
    lines.push('');
    lines.push('최신 실패 모델');
    for (const item of review.latestFailures.slice(0, 5)) {
      lines.push(`- ${item.modelId} | ${item.errorClass || 'request_failed'} | ${(item.error || '-').slice(0, 120)}`);
    }
  }
  if (review.latestPrimaryResult && review.latestPrimaryResult.ok !== true) {
    lines.push('');
    lines.push('현재 primary 상태');
    lines.push(`- ${review.latestPrimaryResult.modelId} | ${review.latestPrimaryResult.errorClass || 'request_failed'} | ${(review.latestPrimaryResult.error || '-').slice(0, 120)}`);
    if (review.primaryFallbackCandidate) {
      lines.push(`- safe fallback: ${review.primaryFallbackCandidate.modelId} | ttft ${review.primaryFallbackCandidate.ttft ?? '-'}ms | total ${review.primaryFallbackCandidate.total ?? '-'}ms`);
    }
    if (review.primaryFallbackPolicy) {
      lines.push(`- policy: ${review.primaryFallbackPolicy.decision} | reason ${review.primaryFallbackPolicy.reason} | consecutive issues ${review.primaryFallbackPolicy.consecutivePrimaryIssues}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const { days, input, json } = parseArgs();
  const entries = readHistory(input);
  const review = buildReview(entries, days, input);
  if (json) {
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
    return;
  }
  printReview(review);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  readHistory,
  buildReview,
  printReview,
};
