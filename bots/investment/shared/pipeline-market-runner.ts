// @ts-nocheck
import { createPipelineSession, runNode } from './node-runner.ts';
import { finishPipelineRun } from './pipeline-db.ts';
import { publishToMainBot } from './mainbot-client.ts';
import { getInvestmentNode } from '../nodes/index.ts';

const COLLECT_NODE_SETS = {
  binance: ['L06', 'L02', 'L03', 'L05'],
  kis: ['L06', 'L02', 'L03'],
  kis_overseas: ['L06', 'L02', 'L03'],
};

const COLLECT_CONCURRENCY_LIMIT = {
  binance: 6,
  kis: 4,
  kis_overseas: 4,
};

const ENRICHMENT_NODE_IDS = new Set(['L03', 'L05']);

const COLLECT_WARNING_THRESHOLDS = {
  overloadTasks: 60,
  guardedTasks: 45,
  wideUniverseSymbols: 20,
};

function buildCollectOverloadProfile(metrics = {}) {
  const screeningCount = Number(metrics.screeningSymbolCount || 0);
  const heldCount = Number(metrics.heldAddedCount || metrics.heldSymbolCount || 0);
  const perSymbolNodeCount = Number(metrics.perSymbolNodeCount || 0);
  const totalTasks = Number(metrics.totalTasks || 0);
  const screeningTaskShare = screeningCount * perSymbolNodeCount;
  const heldTaskShare = heldCount * perSymbolNodeCount;

  let dominantSource = 'mixed';
  const diff = Math.abs(screeningTaskShare - heldTaskShare);
  const mixedTolerance = Math.max(perSymbolNodeCount, 4);
  if (diff > mixedTolerance) {
    if (heldTaskShare > screeningTaskShare) dominantSource = 'held';
    else if (screeningTaskShare > heldTaskShare) dominantSource = 'screening';
  }

  return {
    screeningCount,
    heldCount,
    perSymbolNodeCount,
    totalTasks,
    screeningTaskShare,
    heldTaskShare,
    dominantSource,
  };
}

function isDataSparsityError(message = '') {
  const text = String(message || '');
  return text.includes('데이터 부족') || text.toLowerCase().includes('insufficient candle');
}

export async function runMarketCollectPipeline({
  market,
  symbols,
  triggerType = 'cycle',
  triggerRef = null,
  meta = {},
  universeMeta = {},
} = {}) {
  const startedAt = Date.now();
  const nodeIds = COLLECT_NODE_SETS[market];
  if (!nodeIds) throw new Error(`지원하지 않는 market: ${market}`);

  const sessionId = await createPipelineSession({
    pipeline: 'luna_pipeline',
    market,
    symbols,
    triggerType,
    triggerRef,
    meta,
  });

  try {
    const summaries = [];
    const portfolioNode = getInvestmentNode('L06');
    if (portfolioNode) {
      try {
        const result = await runNode(portfolioNode, {
          sessionId,
          market,
          meta: { stage: 'collect', ...meta },
        });
        summaries.push({ nodeId: 'L06', status: 'completed', symbol: null, outputRef: result.outputRef });
      } catch (err) {
        summaries.push({ nodeId: 'L06', status: 'failed', symbol: null, error: err.message });
      }
    }

    const perSymbolNodes = nodeIds.filter(nodeId => nodeId !== 'L06');
    const tasks = [];
    for (const symbol of symbols) {
      for (const nodeId of perSymbolNodes) {
        const node = getInvestmentNode(nodeId);
        if (!node) continue;
        tasks.push(async () => (
          runNode(node, {
            sessionId,
            market,
            symbol,
            meta: { stage: 'collect', ...meta },
            // Collect nodes already persist their real analysis into DB.
            // Skip RAG artifacts here to avoid search/store storms on wide universes.
            storeArtifact: false,
          }).then(result => ({
            nodeId,
            status: 'completed',
            symbol,
            outputRef: result.outputRef,
          })).catch(err => ({
            nodeId,
            status: 'failed',
            symbol,
            error: err.message,
          }))
        ));
      }
    }

    summaries.push(...await runWithConcurrencyLimit(tasks, COLLECT_CONCURRENCY_LIMIT[market] || 4));

    const totalTasks = tasks.length + (portfolioNode ? 1 : 0);
    const failedTasks = summaries.filter(item => item.status === 'failed').length;
    const failedSummaries = summaries.filter(item => item.status === 'failed');
    const dataSparsityFailures = failedSummaries.filter(item => isDataSparsityError(item.error)).length;
    const failedCoreTasks = failedSummaries.filter(item => !ENRICHMENT_NODE_IDS.has(item.nodeId)).length;
    const failedHardCoreTasks = failedSummaries.filter(item => !ENRICHMENT_NODE_IDS.has(item.nodeId) && !isDataSparsityError(item.error)).length;
    const failedEnrichmentTasks = failedSummaries.filter(item => ENRICHMENT_NODE_IDS.has(item.nodeId)).length;
    const totalEnrichmentTasks = summaries.filter(item => ENRICHMENT_NODE_IDS.has(item.nodeId)).length;
    const totalCoreTasks = Math.max(totalTasks - totalEnrichmentTasks, 0);
    const llmGuardFailedTasks = failedSummaries.filter(item =>
      String(item.error || '').includes('LLM 긴급 차단 중')
    ).length;
    const failedNodeCounts = failedSummaries.reduce((acc, item) => {
      acc[item.nodeId] = (acc[item.nodeId] || 0) + 1;
      return acc;
    }, {});
    const metrics = {
      durationMs: Date.now() - startedAt,
      symbolCount: symbols.length,
      screeningSymbolCount: Number(universeMeta.screeningSymbolCount || 0),
      heldSymbolCount: Number(universeMeta.heldSymbolCount || 0),
      heldAddedCount: Number(universeMeta.heldAddedCount || 0),
      perSymbolNodeCount: perSymbolNodes.length,
      totalTasks,
      failedTasks,
      failureRate: totalTasks > 0 ? failedTasks / totalTasks : 0,
      totalCoreTasks,
      failedCoreTasks,
      failedHardCoreTasks,
      coreFailureRate: totalCoreTasks > 0 ? failedCoreTasks / totalCoreTasks : 0,
      hardCoreFailureRate: totalCoreTasks > 0 ? failedHardCoreTasks / totalCoreTasks : 0,
      totalEnrichmentTasks,
      failedEnrichmentTasks,
      enrichmentFailureRate: totalEnrichmentTasks > 0 ? failedEnrichmentTasks / totalEnrichmentTasks : 0,
      dataSparsityFailures,
      llmGuardFailedTasks,
      failedNodeCounts,
      concurrencyLimit: COLLECT_CONCURRENCY_LIMIT[market] || 4,
      ragArtifactsSkipped: tasks.length,
      overloadDetected: tasks.length >= COLLECT_WARNING_THRESHOLDS.overloadTasks,
      overloadProfile: buildCollectOverloadProfile({
        screeningSymbolCount: Number(universeMeta.screeningSymbolCount || 0),
        heldSymbolCount: Number(universeMeta.heldSymbolCount || 0),
        heldAddedCount: Number(universeMeta.heldAddedCount || 0),
        perSymbolNodeCount: perSymbolNodes.length,
        totalTasks,
      }),
      warnings: buildCollectWarnings({
        tasks,
        symbols,
        failedTasks,
        totalTasks,
        limit: COLLECT_CONCURRENCY_LIMIT[market] || 4,
        totalCoreTasks,
        failedCoreTasks,
        totalEnrichmentTasks,
        failedEnrichmentTasks,
        llmGuardFailedTasks,
      }),
    };

    return { sessionId, market, symbols, summaries, metrics };
  } catch (err) {
    await finishPipelineRun(sessionId, {
      status: 'failed',
      meta: {
        bridge_status: 'collect_failed',
        collect_error: err.message,
        market,
        market_script: meta?.market_script || null,
        research_only: Boolean(meta?.research_only),
      },
    }).catch(() => {});
    throw err;
  }
}

export function summarizeNodeStatuses(summaries = []) {
  const counts = new Map();
  for (const item of summaries) {
    const key = `${item.nodeId}:${item.status}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key}=${count}`).join(' | ');
}

export function summarizeCollectWarnings(warnings = [], metrics = {}) {
  if (!Array.isArray(warnings) || warnings.length === 0) return [];

  const lines = [];
  const coreFailed = Number(metrics.failedCoreTasks || 0);
  const enrichFailed = Number(metrics.failedEnrichmentTasks || 0);
  const llmGuardFailed = Number(metrics.llmGuardFailedTasks || 0);

  if (warnings.includes('collect_blocked_by_llm_guard')) {
    if (coreFailed === 0 && enrichFailed > 0) {
      lines.push(`LLM guard 발동으로 보조 분석 수집 ${enrichFailed}건이 차단됐습니다. 핵심 수집은 정상입니다.`);
    } else {
      lines.push(`LLM guard 발동으로 수집 노드 ${llmGuardFailed || (coreFailed + enrichFailed)}건이 차단됐습니다.`);
    }
  }

  if (warnings.includes('enrichment_collect_failure_rate_high')) {
    lines.push(`뉴스·감성·온체인 등 보조 분석 실패율이 높습니다 (실패 ${enrichFailed}건).`);
  }

  if (warnings.includes('core_collect_failure_rate_high')) {
    lines.push(`핵심 수집 실패율이 높습니다 (실패 ${coreFailed}건). 즉시 원천 API 점검이 필요합니다.`);
  }

  if (warnings.includes('data_sparsity_watch')) {
    lines.push(`신규/희소 심볼의 이력 부족으로 수집 스킵이 누적되고 있습니다 (data_sparsity=${metrics.dataSparsityFailures || 0}).`);
  }

  if (warnings.includes('collect_overload_detected')) {
    const overload = buildCollectOverloadProfile(metrics);
    const screeningCount = overload.screeningCount;
    const heldCount = overload.heldCount;
    if (screeningCount > 0 || heldCount > 0) {
      lines.push(`수집 대상이 과도하게 넓어 부하가 높습니다 (tasks=${metrics.totalTasks || 0}, screening=${screeningCount}, held=${heldCount}).`);
    } else {
      lines.push(`수집 대상이 과도하게 넓어 부하가 높습니다 (tasks=${metrics.totalTasks || 0}).`);
    }
    if (overload.dominantSource === 'held' && heldCount > 0) {
      lines.push(`현재 과부하는 신규 스크리닝 확대보다 보유 포지션 carry 관찰 부담 영향이 더 큽니다.`);
    } else if (overload.dominantSource === 'screening' && screeningCount > 0) {
      lines.push(`현재 과부하는 보유 포지션보다 동적 스크리닝 universe 폭 영향이 더 큽니다.`);
    } else if (screeningCount > 0 && heldCount > 0) {
      lines.push(`현재 과부하는 동적 스크리닝과 보유 포지션 관찰이 함께 겹친 혼합 상태입니다.`);
    }
  }

  if (warnings.includes('concurrency_guard_active')) {
    lines.push(`동시성 guard가 활성화된 상태입니다 (limit=${metrics.concurrencyLimit || 0}).`);
  }

  if (warnings.includes('collect_failure_rate_high') && lines.length === 0) {
    lines.push(`수집 실패율이 높습니다 (failed=${metrics.failedTasks || 0}/${metrics.totalTasks || 0}).`);
  }

  return lines;
}

export function buildCollectAlertMessage(label, warnings = [], metrics = {}) {
  const detailLines = summarizeCollectWarnings(warnings, metrics);
  const compactLabel = String(label || '')
    .replace(/국내주식 수집/gu, '국내 수집')
    .replace(/해외주식 수집/gu, '해외 수집')
    .replace(/암호화폐 수집/gu, '암호화폐 수집')
    .trim();
  if (detailLines.length === 0) {
    return `📈 루나 경고 — ${compactLabel}\n${warnings.join(', ')}`;
  }
  return [
    `📈 루나 경고 — ${compactLabel}`,
    ...detailLines.map((line) => `- ${line}`),
  ].join('\n');
}

export async function logMarketPipelineMetrics(label, metrics = {}) {
  if (!metrics || typeof metrics !== 'object') return;
  const parts = [
    `duration=${((metrics.durationMs || 0) / 1000).toFixed(1)}s`,
    metrics.symbolCount != null ? `symbols=${metrics.symbolCount}` : null,
    metrics.screeningSymbolCount != null && metrics.screeningSymbolCount > 0 ? `screening=${metrics.screeningSymbolCount}` : null,
    metrics.heldAddedCount != null && metrics.heldAddedCount > 0 ? `heldAdded=${metrics.heldAddedCount}` : null,
    metrics.totalTasks != null ? `tasks=${metrics.totalTasks}` : null,
    metrics.concurrencyLimit != null ? `concurrency=${metrics.concurrencyLimit}` : null,
    metrics.failedTasks != null ? `failed=${metrics.failedTasks}` : null,
    metrics.failedCoreTasks != null ? `coreFailed=${metrics.failedCoreTasks}` : null,
    metrics.failedEnrichmentTasks != null ? `enrichFailed=${metrics.failedEnrichmentTasks}` : null,
    metrics.debateCount != null ? `debate=${metrics.debateCount}/${metrics.debateLimit}` : null,
    metrics.weakSignalSkipped != null ? `weakSkipped=${metrics.weakSignalSkipped}` : null,
    metrics.riskRejected != null ? `riskRejected=${metrics.riskRejected}` : null,
    metrics.savedExecutionWork != null ? `savedNodes=${metrics.savedExecutionWork}` : null,
  ].filter(Boolean);
  console.log(`  📈 [메트릭] ${label} | ${parts.join(' | ')}`);
  if (!metrics.warnings?.length) return;

  console.warn(`  ⚠️ [경고] ${label} | ${metrics.warnings.join(', ')}`);
  const escalated = metrics.warnings.filter((warning) =>
    [
      'collect_overload_detected',
      'collect_failure_rate_high',
      'core_collect_failure_rate_high',
      'enrichment_collect_failure_rate_high',
      'collect_blocked_by_llm_guard',
      'debate_capacity_hot',
      'weak_signal_pressure',
    ].includes(warning),
  );
  if (!escalated.length) return;

  await publishToMainBot({
    from_bot: 'argos',
    event_type: 'alert',
    alert_level: 2,
    message: buildCollectAlertMessage(label, escalated, metrics),
    payload: metrics,
  });
}

export default {
  runMarketCollectPipeline,
  summarizeNodeStatuses,
  summarizeCollectWarnings,
  buildCollectAlertMessage,
  logMarketPipelineMetrics,
};

async function runWithConcurrencyLimit(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function buildCollectWarnings({
  tasks,
  symbols,
  failedTasks,
  totalTasks,
  limit,
  totalCoreTasks,
  failedCoreTasks,
  failedHardCoreTasks,
  totalEnrichmentTasks,
  failedEnrichmentTasks,
  dataSparsityFailures,
  llmGuardFailedTasks,
}) {
  const warnings = [];
  if (symbols.length >= COLLECT_WARNING_THRESHOLDS.wideUniverseSymbols) warnings.push('wide_universe');
  if (tasks.length >= COLLECT_WARNING_THRESHOLDS.overloadTasks) warnings.push('collect_overload_detected');
  if (limit <= 4 && tasks.length >= COLLECT_WARNING_THRESHOLDS.guardedTasks) warnings.push('concurrency_guard_active');
  if (llmGuardFailedTasks > 0) warnings.push('collect_blocked_by_llm_guard');
  if (failedHardCoreTasks > 0 && totalCoreTasks > 0 && failedHardCoreTasks / totalCoreTasks >= 0.2) {
    warnings.push('core_collect_failure_rate_high');
  }
  if (failedEnrichmentTasks > 0 && totalEnrichmentTasks > 0 && failedEnrichmentTasks / totalEnrichmentTasks >= 0.2) {
    warnings.push('enrichment_collect_failure_rate_high');
  }
  if (dataSparsityFailures >= 3) warnings.push('data_sparsity_watch');
  if (
    warnings.length === 0
    && failedTasks > 0
    && totalTasks > 0
    && failedTasks / totalTasks >= 0.2
  ) {
    warnings.push('collect_failure_rate_high');
  }
  return warnings;
}
