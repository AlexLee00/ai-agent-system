#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runBacktest } from '../team/chronos.ts';
import * as db from '../shared/db.ts';
import { callViaHub } from '../shared/hub-llm-client.ts';

const require = createRequire(import.meta.url);
const {
  callLocalLLMJSON,
  LOCAL_MODEL_FAST,
  LOCAL_MODEL_DEEP,
} = require('../../../packages/core/lib/local-llm-client.js');

const DEFAULT_SYMBOL = 'BTC/USDT';
const DEFAULT_FROM = '2025-01-01';
const DEFAULT_TO = '2025-03-31';
const DEFAULT_SAMPLES = 6;

const DEFAULT_LAYER2_MODELS = [
  LOCAL_MODEL_FAST,
  'groq/qwen/qwen3-32b',
  'groq/openai/gpt-oss-20b',
];

const DEFAULT_LAYER3_MODELS = [
  LOCAL_MODEL_DEEP,
  'groq/qwen/qwen3-32b',
  'groq/openai/gpt-oss-20b',
];

function parseArgs(argv = []) {
  const args = {
    symbol: DEFAULT_SYMBOL,
    from: DEFAULT_FROM,
    to: DEFAULT_TO,
    samples: DEFAULT_SAMPLES,
    layer: 'both',
    json: false,
    persist: false,
    layer2Models: [],
    layer3Models: [],
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--persist') args.persist = true;
    else if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=');
    else if (raw.startsWith('--from=')) args.from = raw.split('=').slice(1).join('=');
    else if (raw.startsWith('--to=')) args.to = raw.split('=').slice(1).join('=');
    else if (raw.startsWith('--samples=')) args.samples = Math.max(1, Number(raw.split('=').slice(1).join('=') || DEFAULT_SAMPLES));
    else if (raw.startsWith('--layer=')) args.layer = raw.split('=').slice(1).join('=');
    else if (raw.startsWith('--layer2-model=')) args.layer2Models.push(raw.split('=').slice(1).join('='));
    else if (raw.startsWith('--layer3-model=')) args.layer3Models.push(raw.split('=').slice(1).join('='));
  }

  if (args.layer2Models.length === 0) args.layer2Models = [...DEFAULT_LAYER2_MODELS];
  if (args.layer3Models.length === 0) args.layer3Models = [...DEFAULT_LAYER3_MODELS];
  return args;
}

function normalizeSentimentScore(rawSentiment) {
  if (typeof rawSentiment === 'number' && Number.isFinite(rawSentiment)) {
    return Math.max(0, Math.min(1, rawSentiment));
  }
  const text = String(rawSentiment || '').trim().toUpperCase();
  if (text === 'BULLISH') return 0.75;
  if (text === 'BEARISH') return 0.25;
  if (text === 'NEUTRAL') return 0.5;
  return 0.5;
}

function passesLayer2SentimentGate(action, sentimentScore) {
  if (!Number.isFinite(sentimentScore)) return false;
  if (action === 'BUY') return sentimentScore >= 0.55;
  if (action === 'SELL') return sentimentScore <= 0.45;
  return sentimentScore >= 0.45 && sentimentScore <= 0.55;
}

function safeJsonParse(text) {
  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '```')
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const fence = cleaned.match(/```([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(String(fence[1] || '').trim());
      } catch {
        // continue
      }
    }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function splitProviderModel(spec) {
  if (String(spec).startsWith('groq/')) {
    return { provider: 'groq', model: spec.slice('groq/'.length) };
  }
  return { provider: 'local', model: spec };
}

async function callStructuredModel(spec, prompt, { maxTokens = 256, temperature = 0.1, timeoutMs = 30000 } = {}) {
  const startedAt = Date.now();
  const { provider, model } = splitProviderModel(spec);
  try {
    if (provider === 'local') {
      const value = await callLocalLLMJSON(model, prompt, { max_tokens: maxTokens, temperature, timeoutMs });
      return {
        ok: value != null,
        latencyMs: Date.now() - startedAt,
        provider,
        model,
        parsed: value,
        error: value == null ? 'json_parse_or_empty' : null,
      };
    }

    const systemPrompt = prompt.find((item) => item.role === 'system')?.content || '';
    const userPrompt = prompt.find((item) => item.role === 'user')?.content || '';
    const hubResult = await callViaHub('chronos', systemPrompt, userPrompt, {
      maxTokens,
      urgency: timeoutMs >= 60000 ? 'high' : 'normal',
    });
    if (!hubResult.ok) {
      throw new Error(`hub_llm_failed:${hubResult.error || 'unknown'}`);
    }
    const parsed = safeJsonParse(hubResult.text);
    return {
      ok: parsed != null,
      latencyMs: Date.now() - startedAt,
      provider: hubResult.provider || provider,
      model,
      parsed,
      error: parsed == null ? 'json_parse_failed' : null,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      provider,
      model,
      parsed: null,
      error: error?.message || String(error),
    };
  }
}

function buildLayer2Prompt(symbol, signal) {
  return [
    {
      role: 'system',
      content: '암호화폐 감성 분석가다. 반드시 JSON만 답한다. 형식: {"sentiment":0.65,"reason":"이유"} sentiment는 0~1 범위다.',
    },
    {
      role: 'user',
      content: `symbol=${symbol}, ts=${signal.ts}, RSI=${signal.indicators.rsi?.toFixed?.(2) || 'null'}, MACD_hist=${signal.indicators.macd?.histogram?.toFixed?.(4) || 'null'}, volume_ratio=${signal.indicators.volumeRatio?.toFixed?.(2) || 'null'}, action=${signal.action}`,
    },
  ];
}

function buildLayer3Prompt(symbol, signal) {
  return [
    {
      role: 'system',
      content: '당신은 루나 투자 팀장이다. 추론 설명이나 <think>, 마크다운 없이 JSON 객체 하나만 답한다. 형식: {"decision":"BUY|SELL|HOLD","confidence":0.75,"reason":"이유","riskLevel":"low|medium|high"}',
    },
    {
      role: 'user',
      content: `symbol=${symbol}, ts=${signal.ts}, 기술=${signal.action}, score=${signal.score}, RSI=${signal.indicators.rsi?.toFixed?.(2) || 'null'}, sentiment=${signal.sentiment?.score ?? 0.5}`,
    },
  ];
}

function summarizeCounts(items, key) {
  return items.reduce((acc, item) => {
    const value = String(item?.[key] || 'UNKNOWN').toUpperCase();
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function average(values = []) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

async function evaluateLayer2(symbol, layer1Signals, modelSpecs) {
  const results = [];

  for (const spec of modelSpecs) {
    const rows = [];
    for (const signal of layer1Signals) {
      const response = await callStructuredModel(spec, buildLayer2Prompt(symbol, signal), {
        maxTokens: 180,
        temperature: 0.1,
        timeoutMs: 30000,
      });
      const sentimentScore = normalizeSentimentScore(response.parsed?.sentiment);
      rows.push({
        ts: signal.ts,
        action: signal.action,
        ok: response.ok,
        latencyMs: response.latencyMs,
        sentimentScore,
        passed: response.ok ? passesLayer2SentimentGate(signal.action, sentimentScore) : false,
        error: response.error,
      });
    }

    const successful = rows.filter((row) => row.ok);
    results.push({
      spec,
      total: rows.length,
      successCount: successful.length,
      parseRate: rows.length > 0 ? successful.length / rows.length : 0,
      avgLatencyMs: Math.round(average(successful.map((row) => row.latencyMs))),
      avgSentiment: Number(average(successful.map((row) => row.sentimentScore)).toFixed(4)),
      passedCount: successful.filter((row) => row.passed).length,
      passRate: successful.length > 0 ? successful.filter((row) => row.passed).length / successful.length : 0,
      actionSummary: summarizeCounts(rows, 'action'),
      errors: rows.filter((row) => !row.ok).map((row) => row.error),
      rows,
    });
  }

  return results;
}

async function buildLayer3Baseline(symbol, layer1Signals) {
  const baselineSignals = [];
  for (const signal of layer1Signals) {
    const response = await callStructuredModel(LOCAL_MODEL_FAST, buildLayer2Prompt(symbol, signal), {
      maxTokens: 180,
      temperature: 0.1,
      timeoutMs: 30000,
    });
    const sentimentScore = normalizeSentimentScore(response.parsed?.sentiment);
    if (!response.ok) continue;
    if (!passesLayer2SentimentGate(signal.action, sentimentScore)) continue;
    baselineSignals.push({
      ...signal,
      sentiment: { score: sentimentScore },
    });
  }
  return baselineSignals;
}

async function evaluateLayer3(symbol, baselineSignals, modelSpecs) {
  const results = [];

  for (const spec of modelSpecs) {
    const rows = [];
    for (const signal of baselineSignals) {
      const response = await callStructuredModel(spec, buildLayer3Prompt(symbol, signal), {
        maxTokens: 512,
        temperature: 0.1,
        timeoutMs: String(spec).includes('deepseek') ? 180000 : 45000,
      });
      rows.push({
        ts: signal.ts,
        action: signal.action,
        ok: response.ok,
        latencyMs: response.latencyMs,
        decision: String(response.parsed?.decision || response.parsed?.action || 'UNKNOWN').toUpperCase(),
        confidence: Number(response.parsed?.confidence || 0),
        riskLevel: String(response.parsed?.riskLevel || response.parsed?.risk_level || 'unknown').toLowerCase(),
        error: response.error,
      });
    }

    const successful = rows.filter((row) => row.ok);
    results.push({
      spec,
      total: rows.length,
      successCount: successful.length,
      parseRate: rows.length > 0 ? successful.length / rows.length : 0,
      avgLatencyMs: Math.round(average(successful.map((row) => row.latencyMs))),
      avgConfidence: Number(average(successful.map((row) => row.confidence)).toFixed(4)),
      decisionSummary: summarizeCounts(successful, 'decision'),
      riskSummary: summarizeCounts(successful, 'riskLevel'),
      errors: rows.filter((row) => !row.ok).map((row) => row.error),
      rows,
    });
  }

  return results;
}

function renderText(report) {
  const lines = [
    '🧪 백테스트 LLM 품질 샘플 평가',
    `- symbol: ${report.symbol}`,
    `- period: ${report.from} ~ ${report.to}`,
    `- layer1 signals: ${report.layer1.signalCount}`,
  ];

  if (report.layer2) {
    lines.push('');
    lines.push('Layer 2');
    for (const item of report.layer2.results) {
      lines.push(`- ${item.spec}: parse ${(item.parseRate * 100).toFixed(0)}% | avg ${item.avgLatencyMs}ms | pass ${(item.passRate * 100).toFixed(0)}% | sentiment ${item.avgSentiment}`);
    }
  }

  if (report.layer3) {
    lines.push('');
    lines.push(`Layer 3 (baseline from ${report.layer3.baselineModel}, candidates=${report.layer3.baselineCount})`);
    for (const item of report.layer3.results) {
      lines.push(`- ${item.spec}: parse ${(item.parseRate * 100).toFixed(0)}% | avg ${item.avgLatencyMs}ms | confidence ${item.avgConfidence} | decisions ${JSON.stringify(item.decisionSummary)}`);
    }
  }

  return lines.join('\n');
}

async function persistReport(report) {
  await db.initSchema();
  const rows = [];

  if (report.layer2?.results?.length) {
    for (const item of report.layer2.results) {
      rows.push({
        model: item.spec,
        layer: 2,
        accuracy: item.parseRate,
        matchRate: item.passRate,
        sampleCount: item.total,
        summary: {
          type: 'quality_sample',
          baselineSignalCount: report.layer1.signalCount,
          avgLatencyMs: item.avgLatencyMs,
          avgSentiment: item.avgSentiment,
          successCount: item.successCount,
          passedCount: item.passedCount,
          actionSummary: item.actionSummary,
          errors: item.errors,
        },
      });
    }
  }

  if (report.layer3?.results?.length) {
    for (const item of report.layer3.results) {
      rows.push({
        model: item.spec,
        layer: 3,
        accuracy: item.parseRate,
        matchRate: item.parseRate,
        sampleCount: item.total,
        summary: {
          type: 'quality_sample',
          baselineSignalCount: report.layer1.signalCount,
          baselineCount: report.layer3.baselineCount,
          baselineModel: report.layer3.baselineModel,
          avgLatencyMs: item.avgLatencyMs,
          avgConfidence: item.avgConfidence,
          successCount: item.successCount,
          decisionSummary: item.decisionSummary,
          riskSummary: item.riskSummary,
          errors: item.errors,
        },
      });
    }
  }

  for (const row of rows) {
    await db.run(`
      INSERT INTO llm_backtest_quality (
        model, symbol, layer, accuracy, match_rate, sample_count, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)
    `, [
      row.model,
      report.symbol,
      row.layer,
      row.accuracy ?? null,
      row.matchRate ?? null,
      row.sampleCount ?? 0,
      JSON.stringify(row.summary || {}),
    ]);
  }

  return rows.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const layer1 = await runBacktest(args.symbol, args.from, args.to, '1', { maxSignals: args.samples });
  const layer1Signals = Array.isArray(layer1.filteredSignals) ? layer1.filteredSignals.slice(0, args.samples) : [];

  const report = {
    symbol: args.symbol,
    from: args.from,
    to: args.to,
    layer1: {
      signalCount: layer1Signals.length,
      actionSummary: summarizeCounts(layer1Signals, 'action'),
      status: layer1.status,
    },
    layer2: null,
    layer3: null,
  };

  if (args.layer === '2' || args.layer === 'both') {
    report.layer2 = {
      models: args.layer2Models,
      results: await evaluateLayer2(args.symbol, layer1Signals, args.layer2Models),
    };
  }

  if (args.layer === '3' || args.layer === 'both') {
    const baselineSignals = await buildLayer3Baseline(args.symbol, layer1Signals);
    report.layer3 = {
      baselineModel: LOCAL_MODEL_FAST,
      baselineCount: baselineSignals.length,
      models: args.layer3Models,
      results: await evaluateLayer3(args.symbol, baselineSignals, args.layer3Models),
    };
  }

  if (args.persist) {
    report.persistedRows = await persistReport(report);
  }

  if (args.json) return report;
  return renderText(report);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ backtest-llm-quality-sample 오류:',
  });
}
