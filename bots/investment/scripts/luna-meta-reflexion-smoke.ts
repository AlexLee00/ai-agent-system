#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { runLunaMetaReflexionShadow } from './runtime-luna-meta-reflexion-shadow.ts';
import {
  buildDeterministicMetaNeuralReflexion,
  buildMetaNeuralReflexionInput,
  normalizeMetaNeuralReflexionResult,
} from '../shared/meta-neural-reflexion-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const FAKE_SK_VALUE = ['sk', 'phase4', 'secret', '1234567890'].join('-');
const FAKE_BEARER_VALUE = ['phase4abcdefghijkl', 'mnop'].join('');
const FAKE_BEARER_HEADER = ['Bearer', FAKE_BEARER_VALUE].join(' ');

function dpoRows() {
  return [
    {
      trade_id: 1,
      outcome_summary: { symbol: 'BTC/USDT', pnl_pct: -1.2 },
      score: 0.32,
      critique: 'entry timing failed and stop loss was too loose',
      category: 'rejected',
      created_at: '2026-05-11T00:00:00.000Z',
    },
    {
      trade_id: 2,
      outcome_summary: { symbol: 'ETH/USDT', pnl_pct: 0.8 },
      score: 0.76,
      critique: 'trend alignment worked',
      category: 'preferred',
      created_at: '2026-05-11T01:00:00.000Z',
    },
    {
      trade_id: 3,
      outcome_summary: { symbol: 'SOL/USDT', pnl_pct: -0.2 },
      score: 0.52,
      critique: 'neutral result',
      category: 'neutral',
      created_at: '2026-05-11T02:00:00.000Z',
    },
  ];
}

function fakeDeps() {
  const writes = [];
  const llmCalls = [];
  const schemaInits = [];
  return {
    writes,
    llmCalls,
    schemaInits,
    initSchema: async () => {
      schemaInits.push(new Date().toISOString());
      return { ok: true };
    },
    query: async (sql) => {
      if (sql.includes('luna_dpo_preference_pairs')) return dpoRows();
      if (sql.includes('mapek_knowledge')) {
        return [{
          event_type: 'reflexion_l2_result',
          payload: {
            date: '2026-05-11',
            suggestions: { suggestions: ['keep shadow evidence'] },
          },
          created_at: '2026-05-11T03:00:00.000Z',
        }];
      }
      return [];
    },
    run: async (sql, params) => {
      writes.push({ sql, params });
      return { rowCount: 1 };
    },
    callViaHub: async (...args) => {
      llmCalls.push(args);
      return {
        ok: true,
        text: JSON.stringify({
          recommendations: [`tighten entry timing ${FAKE_SK_VALUE}`],
          lossPatterns: [{ pattern: 'entry_timing_quality', count: 1 }],
          policyRecommendations: {
            layer2: ['dynamic threshold candidate only'],
            layer3: ['compare TP/SL shadow'],
            layer4: ['write memory shadow'],
            promotionAllowed: false,
            liveConfigMutationAllowed: false,
          },
          riskAssessment: {
            riskLevel: 'low',
            mainRisk: `token=${FAKE_BEARER_HEADER}`,
            nested: { api_key: FAKE_SK_VALUE },
          },
          confidence: 0.67,
          priority: 'MEDIUM',
        }),
      };
    },
  };
}

export async function runLunaMetaReflexionSmoke() {
  const input = buildMetaNeuralReflexionInput({
    layer: 'l2',
    periodStart: '2026-05-11',
    periodEnd: '2026-05-11',
    dpoRows: dpoRows(),
    mapekRows: [],
  });
  assert.equal(input.tradeSummary.totalTrades, 3);
  assert.equal(input.tradeSummary.rejectedCount, 1);
  assert.equal(input.tradeSummary.lossPatterns[0].pattern, 'exit_or_stop_loss_quality');

  const deterministic = buildDeterministicMetaNeuralReflexion(input);
  assert.equal(deterministic.shadowOnly, true);
  assert.equal(deterministic.policyRecommendations.liveConfigMutationAllowed, false);
  assert.equal(deterministic.memoryWritePlan.target, 'investment.mapek_knowledge');

  const normalized = normalizeMetaNeuralReflexionResult({
    recommendations: [`use safe routing ${FAKE_SK_VALUE}`],
    risk_assessment: { bearer: FAKE_BEARER_HEADER, nested: { secret: FAKE_SK_VALUE } },
    confidence: 0.9,
    priority: 'HIGH',
  }, { deterministic });
  const normalizedText = JSON.stringify(normalized);
  assert.equal(normalizedText.includes(FAKE_SK_VALUE), false);
  assert.equal(normalizedText.includes(FAKE_BEARER_VALUE), false);

  const dryDeps = fakeDeps();
  const planned = await runLunaMetaReflexionShadow({
    apply: false,
    confirm: '',
    layer: 'all',
    date: '2026-05-11',
    lookbackDays: 1,
    limit: 10,
    maxLlmCalls: 3,
    scope: 'smoke',
  }, dryDeps);
  assert.equal(planned.status, 'luna_meta_reflexion_shadow_planned');
  assert.equal(planned.summary.planned, 3);
  assert.equal(planned.summary.llmCalls, 0);
  assert.equal(dryDeps.writes.length, 0);
  assert.equal(dryDeps.schemaInits.length, 0);
  assert.equal(planned.rows[0].telegramPayload.shadowOnly, true);

  const wrongConfirmDeps = fakeDeps();
  const wrongConfirm = await runLunaMetaReflexionShadow({
    apply: true,
    confirm: 'wrong',
    layer: 'l2',
    date: '2026-05-11',
    lookbackDays: 1,
    limit: 10,
    maxLlmCalls: 1,
    scope: 'smoke',
  }, wrongConfirmDeps);
  assert.equal(wrongConfirm.status, 'luna_meta_reflexion_shadow_planned');
  assert.equal(wrongConfirmDeps.writes.length, 0);
  assert.equal(wrongConfirmDeps.schemaInits.length, 0);

  const applyDeps = fakeDeps();
  const written = await runLunaMetaReflexionShadow({
    apply: true,
    confirm: 'luna-meta-reflexion-shadow',
    layer: 'l2',
    date: '2026-05-11',
    lookbackDays: 1,
    limit: 10,
    maxLlmCalls: 1,
    scope: 'smoke',
  }, applyDeps);
  assert.equal(written.status, 'luna_meta_reflexion_shadow_written');
  assert.equal(written.summary.written, 1);
  assert.equal(written.summary.llmCalls, 1);
  assert.equal(applyDeps.schemaInits.length, 1);
  assert.equal(applyDeps.writes.length, 1);
  assert.equal(applyDeps.llmCalls[0][3].taskType, 'meta_neural_reflexion_shadow');
  const payloadText = applyDeps.writes[0].params[0];
  assert.equal(payloadText.includes(FAKE_SK_VALUE), false);
  assert.equal(payloadText.includes(FAKE_BEARER_VALUE), false);
  assert.equal(JSON.parse(payloadText).shadowOnly, true);

  const cappedDeps = fakeDeps();
  const capped = await runLunaMetaReflexionShadow({
    apply: true,
    confirm: 'luna-meta-reflexion-shadow',
    layer: 'l3',
    date: '2026-05-11',
    lookbackDays: 1,
    limit: 10,
    maxLlmCalls: 0,
    scope: 'smoke',
  }, cappedDeps);
  assert.equal(capped.summary.llmCalls, 0);
  assert.equal(capped.summary.written, 1);
  assert.equal(capped.rows[0].reason, 'deterministic_shadow_written_no_llm');

  return {
    ok: true,
    smoke: 'luna-meta-reflexion-shadow',
    plannedLayers: planned.summary.planned,
    applyWritten: written.summary.written,
    llmCapChecked: true,
    redactionChecked: true,
  };
}

async function main() {
  const result = await runLunaMetaReflexionSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna meta reflexion smoke 실패:',
  });
}
