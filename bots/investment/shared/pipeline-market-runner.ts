// @ts-nocheck
import { createPipelineSession, runNode } from './node-runner.ts';
import { finishPipelineRun } from './pipeline-db.ts';
import { publishAlert } from './alert-publisher.ts';
import { getInvestmentNode } from '../nodes/index.ts';
import { buildPreScreenPlannerContext } from './pre-screen-planner-bridge.ts';
import { recordLifecyclePhaseSnapshot } from './lifecycle-contract.ts';

const COLLECT_NODE_SETS = {
  binance: ['L06', 'L02', 'L03', 'L05'],
  kis: ['L06', 'L02', 'L03', 'L04'],
  kis_overseas: ['L06', 'L02', 'L03', 'L04'],
};

const COLLECT_CONCURRENCY_LIMIT = {
  binance: 6,
  kis: 5,
  kis_overseas: 5,
};

const ENRICHMENT_NODE_IDS = new Set(['L03', 'L04', 'L05']);
const ENRICHMENT_NODE_LABELS = {
  L03: '센티널(뉴스·감성)',
  L04: '주식 flow/event',
  L05: '온체인',
};

const COLLECT_WARNING_THRESHOLDS = {
  overloadTasks: 60,
  guardedTasks: 45,
  wideUniverseSymbols: 20,
};

function buildCollectQualityGate({
  collectMode = 'screening',
  totalCoreTasks = 0,
  failedCoreTasks = 0,
  failedHardCoreTasks = 0,
  totalEnrichmentTasks = 0,
  failedEnrichmentTasks = 0,
  partialFallbackTasks = 0,
  llmGuardFailedTasks = 0,
} = {}) {
  const coreFailureRate = totalCoreTasks > 0 ? failedCoreTasks / totalCoreTasks : 0;
  const enrichmentFailureRate = totalEnrichmentTasks > 0 ? failedEnrichmentTasks / totalEnrichmentTasks : 0;

  let status = 'ready';
  const reasons = [];

  if (failedHardCoreTasks > 0 || (collectMode === 'screening' && totalCoreTasks > 0 && coreFailureRate >= 0.5)) {
    status = 'insufficient';
    if (failedHardCoreTasks > 0) reasons.push(`core_hard_fail ${failedHardCoreTasks}`);
    if (collectMode === 'screening' && coreFailureRate >= 0.5) reasons.push(`core_failure_rate ${(coreFailureRate * 100).toFixed(0)}%`);
  } else if (failedCoreTasks > 0 || failedEnrichmentTasks > 0 || partialFallbackTasks > 0 || llmGuardFailedTasks > 0) {
    status = 'degraded';
    if (failedCoreTasks > 0) reasons.push(`core_fail ${failedCoreTasks}`);
    if (failedEnrichmentTasks > 0) reasons.push(`enrichment_fail ${failedEnrichmentTasks}`);
    if (partialFallbackTasks > 0) reasons.push(`partial_fallback ${partialFallbackTasks}`);
    if (llmGuardFailedTasks > 0) reasons.push(`llm_guard ${llmGuardFailedTasks}`);
  }

  const readinessScore = Math.max(
    0,
    Math.min(
      1,
      Number(
        (
          1
          - Math.min(coreFailureRate * 0.7, 0.7)
          - Math.min(enrichmentFailureRate * 0.2, 0.2)
          - Math.min(partialFallbackTasks * 0.03, 0.1)
        ).toFixed(2),
      ),
    ),
  );

  return {
    status,
    collectMode,
    readinessScore,
    coreFailureRate,
    enrichmentFailureRate,
    reasons,
  };
}

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

function buildRuntimePlannerPayload({ market, symbols = [], meta = {} } = {}) {
  return {
    market,
    symbols: Array.isArray(symbols) ? symbols : [],
    source: 'market_collect',
    planner_context: buildPreScreenPlannerContext({
      market,
      researchOnly: Boolean(meta?.research_only),
      tradeMode: meta?.trade_mode || null,
    }),
  };
}

function summarizeSymbolCollectState(symbol, summaries = []) {
  const symbolRows = summaries.filter((item) => item.symbol === symbol);
  const total = symbolRows.length;
  const failedRows = symbolRows.filter((item) => item.status === 'failed');
  const completedRows = symbolRows.filter((item) => item.status === 'completed');
  const failedCore = failedRows.filter((item) => !ENRICHMENT_NODE_IDS.has(item.nodeId));
  const failedEnrichment = failedRows.filter((item) => ENRICHMENT_NODE_IDS.has(item.nodeId));
  const partialFallbackRows = completedRows.filter((item) => item.partialFallback);
  const partialFallbackSources = {};
  for (const row of partialFallbackRows) {
    for (const err of Array.isArray(row.errors) ? row.errors : []) {
      const key = String(err?.source || 'unknown');
      partialFallbackSources[key] = (partialFallbackSources[key] || 0) + 1;
    }
  }

  return {
    symbolRows,
    total,
    failedRows,
    completedRows,
    failedCore,
    failedEnrichment,
    partialFallbackRows,
    partialFallbackSources,
  };
}

async function emitPhase1CollectStarted({
  sessionId,
  market,
  symbols = [],
  triggerType = 'cycle',
  meta = {},
  perSymbolNodes = [],
}) {
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  const tradeMode = String(meta?.trade_mode || 'normal');
  await Promise.allSettled(
    symbols.map((symbol) => (
      recordLifecyclePhaseSnapshot({
        symbol,
        exchange: market,
        tradeMode,
        phase: 'phase1_collect',
        ownerAgent: 'argos_collect_pipeline',
        eventType: 'started',
        inputSnapshot: {
          triggerType,
          collectMode: String(meta?.collect_mode || 'screening'),
          nodeSet: perSymbolNodes,
        },
        policySnapshot: {
          collectMode: String(meta?.collect_mode || 'screening'),
          researchOnly: Boolean(meta?.research_only),
        },
        idempotencyKey: `phase1:start:${sessionId}:${symbol}`,
      })
    )),
  );
}

async function emitPhase1CollectCompleted({
  sessionId,
  market,
  symbols = [],
  summaries = [],
  metrics = {},
  meta = {},
}) {
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  const tradeMode = String(meta?.trade_mode || 'normal');
  await Promise.allSettled(
    symbols.map((symbol) => {
      const status = summarizeSymbolCollectState(symbol, summaries);
      let eventType = 'completed';
      if (status.total <= 0) eventType = 'skipped';
      else if (status.failedCore.length > 0) eventType = 'failed';
      else if (status.failedEnrichment.length > 0) eventType = 'blocked';

      return recordLifecyclePhaseSnapshot({
        symbol,
        exchange: market,
        tradeMode,
        phase: 'phase1_collect',
        ownerAgent: 'argos_collect_pipeline',
        eventType,
        outputSnapshot: {
          collectStatus:
            status.total <= 0 ? 'skipped'
              : status.failedCore.length > 0 ? 'core_failed'
                : status.failedEnrichment.length > 0 ? 'enrichment_degraded'
                  : status.partialFallbackRows.length > 0 ? 'partial_fallback'
                    : 'ready',
          nodeCount: status.total,
          completedCount: status.completedRows.length,
          failedCount: status.failedRows.length,
          failedCoreCount: status.failedCore.length,
          failedEnrichmentCount: status.failedEnrichment.length,
          partialFallbackCount: status.partialFallbackRows.length,
          collectQuality: metrics.collectQuality || null,
        },
        policySnapshot: {
          collectMode: String(meta?.collect_mode || 'screening'),
          concurrencyLimit: Number(metrics.concurrencyLimit || 0),
          warningCount: Array.isArray(metrics.warnings) ? metrics.warnings.length : 0,
        },
        evidenceSnapshot: {
          failedNodes: status.failedRows.map((row) => ({ nodeId: row.nodeId, error: row.error || null })),
          partialFallbackSources: status.partialFallbackSources,
        },
        idempotencyKey: `phase1:result:${sessionId}:${symbol}`,
      });
    }),
  );
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
    meta: {
      ...(meta || {}),
      planner_payload: buildRuntimePlannerPayload({ market, symbols, meta }),
    },
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
    await emitPhase1CollectStarted({
      sessionId,
      market,
      symbols,
      triggerType,
      meta,
      perSymbolNodes,
    }).catch(() => {});

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
            partialFallback: Boolean(result?.result?.partialFallback),
            errors: Array.isArray(result?.result?.errors) ? result.result.errors : [],
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
    const partialFallbackSummaries = summaries.filter(item => item.status === 'completed' && item.partialFallback);
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
    const partialFallbackNodeCounts = partialFallbackSummaries.reduce((acc, item) => {
      acc[item.nodeId] = (acc[item.nodeId] || 0) + 1;
      return acc;
    }, {});
    const partialFallbackErrorSources = partialFallbackSummaries.reduce((acc, item) => {
      for (const err of Array.isArray(item.errors) ? item.errors : []) {
        const key = String(err?.source || 'unknown');
        acc[key] = (acc[key] || 0) + 1;
      }
      return acc;
    }, {});
    const metrics = {
      durationMs: Date.now() - startedAt,
      symbolCount: symbols.length,
      screeningSymbolCount: Number(universeMeta.screeningSymbolCount || 0),
      heldSymbolCount: Number(universeMeta.heldSymbolCount || 0),
      heldAddedCount: Number(universeMeta.heldAddedCount || 0),
      maintenanceSymbolCount: Number(universeMeta.maintenanceSymbolCount || 0),
      maintenanceProfiledCount: Number(universeMeta.maintenanceProfiledCount || 0),
      maintenanceDustSkippedCount: Number(universeMeta.maintenanceDustSkippedCount || 0),
      maintenanceLifecycleCounts: universeMeta.maintenanceLifecycleCounts || {},
      collectMode: String(meta?.collect_mode || 'screening'),
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
      partialFallbackTasks: partialFallbackSummaries.length,
      partialFallbackNodeCounts,
      partialFallbackErrorSources,
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
        dataSparsityFailures,
        llmGuardFailedTasks,
      }),
    };
    metrics.collectQuality = buildCollectQualityGate({
      collectMode: metrics.collectMode,
      totalCoreTasks,
      failedCoreTasks,
      failedHardCoreTasks,
      totalEnrichmentTasks,
      failedEnrichmentTasks,
      partialFallbackTasks: metrics.partialFallbackTasks,
      llmGuardFailedTasks,
    });
    if (metrics.collectQuality.status === 'degraded') metrics.warnings.push('collect_quality_degraded');
    if (metrics.collectQuality.status === 'insufficient') metrics.warnings.push('collect_quality_insufficient');

    await emitPhase1CollectCompleted({
      sessionId,
      market,
      symbols,
      summaries,
      metrics,
      meta,
    }).catch(() => {});

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
  const partialFallbackTasks = Number(metrics.partialFallbackTasks || 0);
  const failedNodeCounts = metrics.failedNodeCounts && typeof metrics.failedNodeCounts === 'object'
    ? metrics.failedNodeCounts
    : {};
  const partialFallbackNodeCounts = metrics.partialFallbackNodeCounts && typeof metrics.partialFallbackNodeCounts === 'object'
    ? metrics.partialFallbackNodeCounts
    : {};
  const partialFallbackErrorSources = metrics.partialFallbackErrorSources && typeof metrics.partialFallbackErrorSources === 'object'
    ? metrics.partialFallbackErrorSources
    : {};
  const enrichmentBreakdown = Object.entries(ENRICHMENT_NODE_LABELS)
    .map(([nodeId, label]) => {
      const count = Number(failedNodeCounts[nodeId] || 0);
      return count > 0 ? `${label} ${count}건` : null;
    })
    .filter(Boolean)
    .join(', ');
  const partialBreakdown = Object.entries(ENRICHMENT_NODE_LABELS)
    .map(([nodeId, label]) => {
      const count = Number(partialFallbackNodeCounts[nodeId] || 0);
      return count > 0 ? `${label} ${count}건` : null;
    })
    .filter(Boolean)
    .join(', ');
  const partialSources = Object.entries(partialFallbackErrorSources)
    .map(([source, count]) => `${source} ${count}건`)
    .join(', ');

  if (warnings.includes('collect_blocked_by_llm_guard')) {
    if (coreFailed === 0 && enrichFailed > 0) {
      lines.push(`LLM guard 발동으로 보조 분석 수집 ${enrichFailed}건이 차단됐습니다.${enrichmentBreakdown ? ` (${enrichmentBreakdown})` : ''} 핵심 수집은 정상입니다.`);
    } else {
      lines.push(`LLM guard 발동으로 수집 노드 ${llmGuardFailed || (coreFailed + enrichFailed)}건이 차단됐습니다.`);
    }
  }

  if (warnings.includes('enrichment_collect_failure_rate_high')) {
    lines.push(`뉴스·감성·온체인 등 보조 분석 실패율이 높습니다 (실패 ${enrichFailed}건${enrichmentBreakdown ? `, ${enrichmentBreakdown}` : ''}).`);
  }

  if (partialFallbackTasks > 0) {
    lines.push(`보조 분석이 부분 폴백으로 완료된 건이 있습니다 (${partialFallbackTasks}건${partialBreakdown ? `, ${partialBreakdown}` : ''}${partialSources ? `, 원인 ${partialSources}` : ''}).`);
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

  const qualityStatus = String(metrics.collectQuality?.status || '').trim();
  if (qualityStatus === 'degraded') {
    lines.push(`수집 품질은 degraded 상태입니다 (readiness=${Number(metrics.collectQuality?.readinessScore || 0).toFixed(2)}).`);
  } else if (qualityStatus === 'insufficient') {
    lines.push(`수집 품질이 insufficient 상태라 신규 진입용 판단 신뢰가 낮습니다.`);
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

function normalizeCollectAlertLabel(label = '') {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9가-힣_:-]/g, '')
    .slice(0, 80) || 'unknown';
}

export function classifyCollectAlertRoute(label, warnings = [], metrics = {}) {
  const warningSet = new Set(Array.isArray(warnings) ? warnings : []);
  const qualityStatus = String(metrics.collectQuality?.status || '').trim().toLowerCase();
  const coreFailed = Number(metrics.failedCoreTasks || 0);
  const hardCoreFailed = Number(metrics.failedHardCoreTasks || 0);
  const enrichmentFailed = Number(metrics.failedEnrichmentTasks || 0);
  const llmGuardFailed = Number(metrics.llmGuardFailedTasks || 0);
  const operationalOnlyWarnings = new Set([
    'collect_overload_detected',
    'debate_capacity_hot',
    'weak_signal_pressure',
    'concurrency_guard_active',
    'wide_universe',
    'data_sparsity_watch',
  ]);
  const allOperationalOnly = Array.from(warningSet).every((warning) => operationalOnlyWarnings.has(warning));
  const labelKey = normalizeCollectAlertLabel(label);

  if (
    hardCoreFailed > 0
    || warningSet.has('core_collect_failure_rate_high')
    || (warningSet.has('collect_failure_rate_high') && coreFailed > 0)
    || qualityStatus === 'insufficient'
  ) {
    return {
      visibility: 'notify',
      alarm_type: 'error',
      actionability: 'none',
      incident_key: `investment:argos:collect:${labelKey}:core_failure`,
      title: 'investment argos collect error',
    };
  }

  if (
    warningSet.has('collect_blocked_by_llm_guard')
    || warningSet.has('enrichment_collect_failure_rate_high')
    || (qualityStatus === 'degraded' && (enrichmentFailed > 0 || llmGuardFailed > 0))
  ) {
    return {
      visibility: 'digest',
      alarm_type: 'report',
      actionability: 'none',
      incident_key: `investment:argos:collect:${labelKey}:degraded_enrichment`,
      title: 'investment argos collect digest',
    };
  }

  if (
    allOperationalOnly
    || qualityStatus === 'degraded'
    || warningSet.has('collect_overload_detected')
    || warningSet.has('debate_capacity_hot')
    || warningSet.has('weak_signal_pressure')
  ) {
    return {
      visibility: 'digest',
      alarm_type: 'report',
      actionability: 'none',
      incident_key: `investment:argos:collect:${labelKey}:capacity_watch`,
      title: 'investment argos capacity digest',
    };
  }

  return {
    visibility: 'notify',
    alarm_type: 'work',
    actionability: 'none',
    incident_key: `investment:argos:collect:${labelKey}:generic_watch`,
    title: 'investment argos collect watch',
  };
}

export async function logMarketPipelineMetrics(label, metrics = {}) {
  if (!metrics || typeof metrics !== 'object') return;
  const parts = [
    `duration=${((metrics.durationMs || 0) / 1000).toFixed(1)}s`,
    metrics.symbolCount != null ? `symbols=${metrics.symbolCount}` : null,
    metrics.screeningSymbolCount != null && metrics.screeningSymbolCount > 0 ? `screening=${metrics.screeningSymbolCount}` : null,
    metrics.heldAddedCount != null && metrics.heldAddedCount > 0 ? `heldAdded=${metrics.heldAddedCount}` : null,
    metrics.maintenanceSymbolCount != null && metrics.maintenanceSymbolCount > 0 ? `maintenance=${metrics.maintenanceSymbolCount}` : null,
    metrics.maintenanceDustSkippedCount != null && metrics.maintenanceDustSkippedCount > 0 ? `dustSkipped=${metrics.maintenanceDustSkippedCount}` : null,
    metrics.totalTasks != null ? `tasks=${metrics.totalTasks}` : null,
    metrics.concurrencyLimit != null ? `concurrency=${metrics.concurrencyLimit}` : null,
    metrics.failedTasks != null ? `failed=${metrics.failedTasks}` : null,
    metrics.failedCoreTasks != null ? `coreFailed=${metrics.failedCoreTasks}` : null,
    metrics.failedEnrichmentTasks != null ? `enrichFailed=${metrics.failedEnrichmentTasks}` : null,
    metrics.partialFallbackTasks != null && metrics.partialFallbackTasks > 0 ? `partial=${metrics.partialFallbackTasks}` : null,
    metrics.failedNodeCounts?.L03 ? `L03=${metrics.failedNodeCounts.L03}` : null,
    metrics.failedNodeCounts?.L05 ? `L05=${metrics.failedNodeCounts.L05}` : null,
    metrics.partialFallbackNodeCounts?.L03 ? `L03_partial=${metrics.partialFallbackNodeCounts.L03}` : null,
    metrics.partialFallbackNodeCounts?.L05 ? `L05_partial=${metrics.partialFallbackNodeCounts.L05}` : null,
    metrics.collectQuality?.status ? `quality=${metrics.collectQuality.status}` : null,
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

  const route = classifyCollectAlertRoute(label, metrics.warnings, metrics);

  await publishAlert({
    from_bot: 'argos',
    event_type: 'alert',
    alert_level: 2,
    message: buildCollectAlertMessage(label, escalated, metrics),
    payload: metrics,
    visibility: route.visibility,
    alarm_type: route.alarm_type,
    actionability: route.actionability,
    incident_key: route.incident_key,
    title: route.title,
  });
}

export default {
  runMarketCollectPipeline,
  summarizeNodeStatuses,
  summarizeCollectWarnings,
  buildCollectAlertMessage,
  classifyCollectAlertRoute,
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
