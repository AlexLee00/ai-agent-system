#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { callViaHub } from '../shared/hub-llm-client.ts';
import {
  buildDeterministicMetaNeuralReflexion,
  buildMetaNeuralReflexionInput,
  buildMetaNeuralReflexionPrompt,
  buildMetaReflexionTelegramPayload,
  expandMetaReflexionLayers,
  normalizeMetaNeuralReflexionResult,
  redactMetaReflexionValue,
} from '../shared/meta-neural-reflexion-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const CONFIRM_TOKEN = 'luna-meta-reflexion-shadow';

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    confirm: argValue('confirm', '', argv),
    layer: argValue('layer', 'all', argv),
    date: argValue('date', null, argv),
    endDate: argValue('end-date', null, argv),
    lookbackDays: Math.max(1, Number(argValue('lookback-days', 7, argv)) || 7),
    limit: Math.max(1, Number(argValue('limit', 100, argv)) || 100),
    maxLlmCalls: Math.max(0, Number(argValue('max-llm-calls', 0, argv)) || 0),
    scope: argValue('scope', 'luna_phase4_shadow', argv),
  };
}

function kstDateString(date = new Date()) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function computePeriod(options = {}) {
  const endDate = options.endDate || options.date || kstDateString();
  const startDate = options.date || addDays(endDate, -Math.max(0, Number(options.lookbackDays || 7) - 1));
  return { periodStart: startDate, periodEnd: endDate };
}

function redactError(value) {
  return String(value || 'unknown')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/(api[_-]?key|token|secret|password)=?[A-Za-z0-9._:-]{8,}/gi, '$1=***')
    .slice(0, 500);
}

async function fetchDpoRows(queryFn, { periodStart, periodEnd, limit }) {
  return Promise.resolve(queryFn(
    `SELECT trade_id, rationale, outcome_summary, score, critique, category, created_at
       FROM luna_dpo_preference_pairs
      WHERE created_at >= $1::date
        AND created_at <  $2::date + interval '1 day'
      ORDER BY created_at DESC
      LIMIT $3`,
    [periodStart, periodEnd, Math.max(1, Number(limit || 100))],
  )).catch(() => []);
}

async function fetchMapekRows(queryFn, { periodStart, periodEnd, limit }) {
  return Promise.resolve(queryFn(
    `SELECT event_type, payload, created_at
       FROM investment.mapek_knowledge
      WHERE event_type IN ('reflexion_l2_result','reflexion_l3_result','luna_meta_reflexion_shadow')
        AND created_at >= $1::date
        AND created_at <  $2::date + interval '1 day'
      ORDER BY created_at DESC
      LIMIT $3`,
    [periodStart, periodEnd, Math.max(1, Math.min(50, Number(limit || 50)))],
  )).catch(() => []);
}

async function insertMetaReflexionShadow(runFn, payload) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.mapek_knowledge (event_type, payload)
     VALUES ('luna_meta_reflexion_shadow', $1::jsonb)`,
    [JSON.stringify(redactMetaReflexionValue(payload))],
  ));
}

async function analyzeLayer(layer, options, deps, budget, period) {
  const queryFn = deps.query || db.query;
  const runFn = deps.run || db.run;
  const llmCaller = deps.callViaHub || callViaHub;
  const [dpoRows, mapekRows] = await Promise.all([
    fetchDpoRows(queryFn, { ...period, limit: options.limit }),
    fetchMapekRows(queryFn, { ...period, limit: options.limit }),
  ]);
  const input = buildMetaNeuralReflexionInput({
    layer,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    dpoRows,
    mapekRows,
    scope: options.scope,
  });
  const deterministic = buildDeterministicMetaNeuralReflexion(input);
  const baseRow = {
    layer,
    scope: options.scope,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    input,
    deterministic,
    recommendations: deterministic.recommendations,
    lossPatterns: deterministic.lossPatterns,
    policyRecommendations: deterministic.policyRecommendations,
    riskAssessment: deterministic.riskAssessment,
    confidence: deterministic.confidence,
    priority: deterministic.priority,
    memoryWritePlanned: true,
    broadcastPlanned: String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true',
    shadowOnly: true,
  };
  baseRow.telegramPayload = buildMetaReflexionTelegramPayload(baseRow);

  if (!options.apply || options.confirm !== CONFIRM_TOKEN) {
    return {
      ...baseRow,
      status: 'planned',
      reason: 'apply_confirm_required',
      llmCalled: false,
      written: false,
    };
  }

  let llmResult = null;
  if (budget.llmCalls < options.maxLlmCalls) {
    budget.llmCalls += 1;
    const llm = await Promise.resolve(llmCaller(
      'luna',
      'Luna Phase 4 meta-neural reflexion shadow judge',
      buildMetaNeuralReflexionPrompt(input, deterministic),
      {
        taskType: 'meta_neural_reflexion_shadow',
        urgency: 'low',
        maxTokens: 900,
        timeoutMs: 60_000,
      },
    )).catch((error) => ({ ok: false, error: error?.message || String(error) }));

    if (llm.ok) {
      try {
        llmResult = normalizeMetaNeuralReflexionResult(llm.text, { deterministic });
      } catch (error) {
        llmResult = {
          ...deterministic,
          degraded: true,
          error: `llm_parse_failed:${redactError(error?.message || error)}`,
        };
      }
    } else {
      llmResult = {
        ...deterministic,
        degraded: true,
        error: `llm_call_failed:${redactError(llm.error || 'unknown')}`,
      };
    }
  }

  const finalRow = {
    ...baseRow,
    status: 'written',
    reason: llmResult ? 'llm_shadow_written' : 'deterministic_shadow_written_no_llm',
    llm: llmResult,
    recommendations: llmResult?.recommendations || deterministic.recommendations,
    lossPatterns: llmResult?.lossPatterns || deterministic.lossPatterns,
    policyRecommendations: llmResult?.policyRecommendations || deterministic.policyRecommendations,
    riskAssessment: llmResult?.riskAssessment || deterministic.riskAssessment,
    confidence: llmResult?.confidence ?? deterministic.confidence,
    priority: llmResult?.priority || deterministic.priority,
    llmCalled: Boolean(llmResult),
    written: true,
  };
  finalRow.telegramPayload = buildMetaReflexionTelegramPayload(finalRow);
  await insertMetaReflexionShadow(runFn, finalRow);
  return finalRow;
}

export async function runLunaMetaReflexionShadow(options = parseArgs(), deps = {}) {
  if (process.env.LUNA_META_REFLEXION_SHADOW_ENABLED === 'false') {
    return {
      ok: true,
      status: 'luna_meta_reflexion_shadow_disabled',
      apply: options.apply,
      confirmRequired: CONFIRM_TOKEN,
      rows: [],
    };
  }
  const period = computePeriod(options);
  const layers = expandMetaReflexionLayers(options.layer);
  const initSchema = deps.initSchema || db.initSchema;
  if (options.apply && options.confirm === CONFIRM_TOKEN && initSchema) {
    await Promise.resolve(initSchema()).catch(() => null);
  }

  const budget = { llmCalls: 0 };
  const rows = [];
  for (const layer of layers) {
    rows.push(await analyzeLayer(layer, options, deps, budget, period));
  }
  const written = rows.filter((row) => row.written).length;
  const planned = rows.filter((row) => row.status === 'planned').length;
  const degraded = rows.filter((row) => row.llm?.degraded).length;
  return {
    ok: true,
    status: written > 0
      ? 'luna_meta_reflexion_shadow_written'
      : planned > 0
        ? 'luna_meta_reflexion_shadow_planned'
        : 'luna_meta_reflexion_shadow_skipped',
    apply: options.apply,
    confirmRequired: CONFIRM_TOKEN,
    maxLlmCalls: options.maxLlmCalls,
    period,
    summary: {
      layers: rows.length,
      written,
      planned,
      degraded,
      llmCalls: budget.llmCalls,
      memoryWrites: written,
      broadcastPlanned: rows.some((row) => row.broadcastPlanned === true),
    },
    rows,
  };
}

async function main() {
  const result = await runLunaMetaReflexionShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} written=${result.summary?.written || 0} planned=${result.summary?.planned || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna meta reflexion shadow 오류:',
  });
}
