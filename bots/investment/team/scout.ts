// @ts-nocheck
/**
 * team/scout.js — 스카우트 (토스 시장 스캔 에이전트)
 *
 * 역할:
 *   - 토스 계열 시장 화면에서 스카우트 시그널 후보를 수집
 *   - RAG market_data 저장
 *   - event_lake 기록
 *   - 텔레그램 요약 발송
 *   - 아르고스와 교차 검증용 겹치는 심볼 요약
 *
 * 실행:
 *   node team/scout.js --dry-run --json
 */

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { callLLM, parseJSON } from '../shared/llm-client.ts';
import { callLLMWithHub } from '../shared/hub-llm-client.ts';
import { initSchema as initRagSchema, store as storeRag } from '../shared/rag-client.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { initHubSecrets, isKisPaper } from '../shared/secrets.ts';
import { getDomesticPrice } from '../shared/kis-client.ts';
import { recordScoutEvidence } from '../shared/external-evidence-ledger.ts';
import { collectTossMarketIntel } from './toss-market-intel.ts';

const logger = {
  info(message, data = null) {
    if (data && Object.keys(data).length > 0) console.log(`[scout][INFO] ${message}`, data);
    else console.log(`[scout][INFO] ${message}`);
  },
  warn(message, data = null) {
    if (data && Object.keys(data).length > 0) console.warn(`[scout][WARN] ${message}`, data);
    else console.warn(`[scout][WARN] ${message}`);
  },
  error(message, data = null) {
    if (data && Object.keys(data).length > 0) console.error(`[scout][ERROR] ${message}`, data);
    else console.error(`[scout][ERROR] ${message}`);
  },
};

let eventLakeModulePromise = null;

async function getEventLake() {
  if (!eventLakeModulePromise) {
    eventLakeModulePromise = import('../../../packages/core/lib/event-lake.legacy.js');
  }
  return eventLakeModulePromise;
}

/**
 * @typedef {Object} ScoutSignal
 * @property {string} symbol
 * @property {string} market
 * @property {string} source
 * @property {number} [score]
 */

/**
 * @typedef {Object} ScoutResult
 * @property {boolean} dryRun
 * @property {string} source
 * @property {string} fetchedAt
 * @property {{ summary: string, focusSymbols?: string[], overlapSymbols?: string[], rationale?: string }} summary
 * @property {ScoutSignal[]} signals
 * @property {Record<string, number>} sectionCounts
 */

function topUniqueSignals(signals = [], limit = 5) {
  const seen = new Set();
  const result = [];
  for (const signal of signals) {
    const key = `${signal.market}:${signal.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(signal);
    if (result.length >= limit) break;
  }
  return result;
}

async function loadRecentArgosSymbols({ dryRun = false } = {}) {
  if (dryRun) return new Map();
  try {
    const rows = await db.getRecentScreeningMarkets(6);
    const byMarket = new Map();
    for (const row of rows) {
      const market = row.market;
      const list = Array.isArray(row.dynamic_symbols) ? row.dynamic_symbols : [];
      if (!byMarket.has(market)) byMarket.set(market, new Set());
      const bucket = byMarket.get(market);
      for (const symbol of list) {
        if (symbol) bucket.add(String(symbol).trim().toUpperCase());
      }
    }
    return byMarket;
  } catch (error) {
    logger.warn('최근 아르고스 심볼 로드 실패', { error: error.message });
    return new Map();
  }
}

function summarizeOverlap(signals = [], byMarket = new Map()) {
  const overlaps = [];
  for (const signal of signals) {
    const bucket = byMarket.get(signal.market) || byMarket.get('all');
    if (!bucket) continue;
    const normalized = String(signal.symbol || '').trim().toUpperCase();
    if (bucket.has(normalized)) overlaps.push(normalized);
  }
  return [...new Set(overlaps)];
}

function heuristicSummary(payload, overlaps = []) {
  const topSignals = topUniqueSignals(payload.signals || [], 4);
  const focusSymbols = topSignals.map((item) => item.symbol);
  const sectionHits = Object.entries(payload.sections || {})
    .filter(([, values]) => Array.isArray(values) && values.length > 0)
    .map(([key, values]) => `${key}:${values.length}`)
    .slice(0, 4);
  return {
    summary: `토스 스카우트 수집 ${topSignals.length}건, 섹션 ${sectionHits.join(', ') || '없음'}`,
    focusSymbols,
    overlapSymbols: overlaps,
    rationale: overlaps.length > 0
      ? `아르고스와 겹치는 심볼 ${overlaps.join(', ')} 확인`
      : '새로운 스카우트 후보 중심으로 관찰 필요',
  };
}

async function analyzeScoutPayload(payload, overlaps = []) {
  const topSignals = topUniqueSignals(payload.signals || [], 6);
  if (topSignals.length === 0) {
    return {
      summary: '수집은 성공했지만 구조화된 후보 심볼은 없었습니다.',
      focusSymbols: [],
      overlapSymbols: overlaps,
      rationale: '섹션 기반 시장 메모만 저장합니다.',
    };
  }

  const userMsg = [
    `source: ${payload.source}`,
    `signals: ${topSignals.map((item) => `${item.symbol}/${item.market}/${item.source}/${item.score}`).join(', ')}`,
    `overlap: ${overlaps.join(', ') || '없음'}`,
    `sections: ${JSON.stringify(payload.sections || {}).slice(0, 2000)}`,
  ].join('\n');

  try {
    const raw = await callLLMWithHub(
      'scout',
      `당신은 루나팀 스카우트 요약가입니다.
토스증권 스캔 결과를 짧게 요약하고, 루나가 우선 볼 심볼을 추립니다.
JSON만 응답:
{"summary":"한 줄 요약","focusSymbols":["심볼"],"overlapSymbols":["심볼"],"rationale":"근거"}`,
      userMsg,
      callLLM,
      300,
      {
        symbol: topSignals[0]?.symbol || 'SCOUT',
        market: 'kis',
        taskType: 'screening',
        incidentKey: `scout:kis:${payload.source}:${payload.fetchedAt}`,
      },
    );
    const parsed = parseJSON(raw);
    if (parsed?.summary) {
      return {
        summary: String(parsed.summary),
        focusSymbols: Array.isArray(parsed.focusSymbols) ? parsed.focusSymbols.slice(0, 5) : topSignals.map((item) => item.symbol).slice(0, 5),
        overlapSymbols: Array.isArray(parsed.overlapSymbols) ? parsed.overlapSymbols.slice(0, 5) : overlaps,
        rationale: String(parsed.rationale || '').trim() || heuristicSummary(payload, overlaps).rationale,
      };
    }
  } catch (error) {
    logger.warn('스카우트 LLM 요약 실패 — 휴리스틱으로 폴백', { error: error.message });
  }

  return heuristicSummary(payload, overlaps);
}

async function recordScoutArtifacts(payload, summary) {
  const topSignals = topUniqueSignals(payload.signals || [], 6);
  const sectionCounts = Object.fromEntries(
    Object.entries(payload.sections || {}).map(([key, values]) => [key, Array.isArray(values) ? values.length : 0]),
  );
  const sectionHighlights = Object.fromEntries(
    Object.entries(payload.sections || {}).map(([key, values]) => [
      key,
      (Array.isArray(values) ? values : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 5),
    ]),
  );
  const baselineQuotes = {};
  const domesticSignals = topSignals.filter((item) => item.market === 'domestic').slice(0, 5);

  try {
    await initHubSecrets();
  } catch {
    // 허브 접근 실패 시 로컬 config 기반으로 계속 진행한다.
  }

  for (const signal of domesticSignals) {
    try {
      const price = Number(await getDomesticPrice(signal.symbol, isKisPaper()));
      if (price > 0) {
        baselineQuotes[signal.symbol] = {
          price,
          captured_at: new Date().toISOString(),
        };
      }
    } catch (error) {
      logger.warn('스카우트 기준가 저장 실패', {
        symbol: signal.symbol,
        error: error.message,
      });
    }
  }

  const content = [
    `[스카우트 ${payload.source}] ${summary.summary}`,
    `focus: ${summary.focusSymbols.join(', ') || '없음'}`,
    `overlap: ${summary.overlapSymbols.join(', ') || '없음'}`,
    `rationale: ${summary.rationale}`,
  ].join(' | ');

  await storeRag('market_data', content, {
    source: 'scout',
    fetched_at: payload.fetchedAt,
    target_url: payload.targetUrl,
    focus_symbols: summary.focusSymbols,
    overlap_symbols: summary.overlapSymbols,
    signals: topSignals,
    sections: payload.sections,
  }, 'scout');

  await eventLake.record({
    eventType: 'scout_collect',
    team: 'luna',
    botName: 'scout',
    severity: 'info',
    title: summary.summary.slice(0, 140),
    message: content,
    tags: [
      'scout',
      'luna',
      `source:${payload.source}`,
      'trigger:scheduled',
      `errors:0`,
      ...Object.entries(sectionCounts)
        .filter(([, count]) => Number(count || 0) > 0)
        .map(([key]) => `type:${key}`),
    ],
    metadata: {
      focusSymbols: summary.focusSymbols,
      overlapSymbols: summary.overlapSymbols,
      signalCount: topSignals.length,
      source: payload.source,
      signals: topSignals,
      sectionCounts,
      sectionHighlights,
      sections: payload.sections || {},
      baselineQuotes,
      targetUrl: payload.targetUrl,
      urls: payload.urls || {},
    },
  });

  await Promise.allSettled(
    topSignals.slice(0, 8).map((signal, idx) => {
      const score = Number(signal?.score ?? 0.5);
      const boundedScore = Number.isFinite(score) ? Math.max(0, Math.min(score, 1)) : 0.5;
      const signalDirection = boundedScore >= 0.6 ? 'bullish' : boundedScore <= 0.4 ? 'bearish' : 'neutral';
      return recordScoutEvidence({
        symbol: signal.symbol,
        market: signal.market,
        score: boundedScore,
        signalDirection,
        strategyFamily: null,
        summary: `scout ${payload.source} rank ${idx + 1}/${topSignals.length} (${signal.source})`,
        rawRef: {
          source: payload.source,
          signalSource: signal.source,
          overlapSymbols: summary.overlapSymbols || [],
          focusSymbols: summary.focusSymbols || [],
          sectionCounts,
          baselineQuote: baselineQuotes[signal.symbol] || null,
        },
      });
    }),
  );
}

function buildTelegramMessage(payload, summary) {
  const topSignals = topUniqueSignals(payload.signals || [], 4);
  const lines = [
    `🔎 토스 스카우트 스캔`,
    `source: ${payload.source} | signals: ${topSignals.length}`,
    `핵심: ${summary.summary}`,
  ];
  if (topSignals.length > 0) {
    lines.push(`후보: ${topSignals.map((item) => `${item.symbol}(${item.source})`).join(', ')}`);
  }
  if (summary.overlapSymbols?.length > 0) {
    lines.push(`아르고스 겹침: ${summary.overlapSymbols.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * @param {{ dryRun?: boolean, json?: boolean, limit?: number }} [input]
 * @returns {Promise<ScoutResult>}
 */
export async function runScout({ dryRun = false, json = false, limit = 10 } = {}) {
  if (!dryRun) {
    await db.initSchema();
    await initRagSchema();
    const eventLake = await getEventLake();
    await eventLake.initSchema();
  }

  const payload = await collectTossMarketIntel({ dryRun, limit });
  const argosByMarket = await loadRecentArgosSymbols({ dryRun });
  const overlaps = summarizeOverlap(payload.signals || [], argosByMarket);
  const summary = dryRun
    ? heuristicSummary(payload, overlaps)
    : await analyzeScoutPayload(payload, overlaps);

  if (!dryRun) {
    await recordScoutArtifacts(payload, summary);
    const message = buildTelegramMessage(payload, summary);
    await publishAlert({
      from_bot: 'scout',
      team: 'investment',
      event_type: 'report',
      alert_level: 1,
      message,
      payload: {
        summary,
        signals: topUniqueSignals(payload.signals || [], 6),
        sections: payload.sections,
      },
    });
  }

  const result = {
    dryRun,
    source: payload.source,
    fetchedAt: payload.fetchedAt,
    summary,
    signals: topUniqueSignals(payload.signals || [], 6),
    sectionCounts: Object.fromEntries(
      Object.entries(payload.sections || {}).map(([key, values]) => [key, Array.isArray(values) ? values.length : 0]),
    ),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    logger.info(`스카우트 스캔 완료 (${payload.source})`, {
      dryRun,
      signals: result.signals.length,
      overlaps: summary.overlapSymbols?.length || 0,
    });
    console.log(`[scout] source=${result.source} signals=${result.signals.length} summary=${summary.summary}`);
  }

  return result;
}

if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = Number(limitArg?.split('=')[1] || 10);

  await runCliMain({
    run: () => runScout({ dryRun, json, limit }),
    onError: async (error) => {
      if (!dryRun) {
        getEventLake()
          .then((eventLake) => eventLake.record({
            eventType: 'scout_error',
            team: 'luna',
            botName: 'scout',
            severity: 'error',
            title: '스카우트 실행 실패',
            message: error?.message || String(error || 'unknown'),
            tags: ['scout', 'luna', 'source:tossinvest', 'trigger:manual', 'errors:1'],
            metadata: {
              dryRun,
              json,
              limit,
              stack: error?.stack || '',
            },
          }))
          .catch(() => {});
      }
      logger.error('스카우트 실행 실패', {
        error: error?.message || String(error || 'unknown'),
        stack: error?.stack ? String(error.stack).split('\n').slice(0, 3).join(' | ') : '',
      });
    },
  });
}
