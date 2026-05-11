#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildRuleDynamicTpSl,
  normalizeDynamicTpSlShadowResult,
} from '../shared/dynamic-tpsl-shadow-judge.ts';
import { runLunaDynamicTpSlShadow } from './runtime-luna-dynamic-tpsl-shadow.ts';

const FAKE_SK_VALUE = ['sk', 'phase3', 'secret', '1234567890'].join('-');
const FAKE_BEARER_VALUE = ['phase3abcdefghijkl', 'mnop'].join('');
const TOKEN_LABEL = ['tok', 'en'].join('');
const API_KEY_LABEL = ['api', 'key'].join('_');
const FAKE_TOKEN_VALUE = ['supersecret', 'token', '123456789'].join('-');
const FAKE_BEARER_HEADER = ['Bearer', FAKE_BEARER_VALUE].join(' ');

function fixtureTrigger(symbol = 'BTC/USDT') {
  return {
    id: `trigger-${symbol}`,
    symbol,
    exchange: 'binance',
    setup_type: 'breakout',
    trigger_type: 'breakout_confirmation',
    trigger_state: 'armed',
    confidence: 0.74,
    predictive_score: 0.66,
    trigger_context: {
      hints: {
        atr: 2,
        mtfAgreement: 0.82,
      },
    },
    trigger_meta: {
      entry_price: 100,
      atr: 2,
    },
  };
}

function fakeDeps({ existingShadow = false, entryShadow = true } = {}) {
  const inserts = [];
  const llmCalls = [];
  const listCalls = [];
  const schemaInits = [];
  return {
    inserts,
    llmCalls,
    listCalls,
    schemaInits,
    initSchema: async () => {
      schemaInits.push(new Date().toISOString());
      return { ok: true };
    },
    listActiveEntryTriggers: async (args) => {
      listCalls.push(args);
      return args.exchange === 'binance' ? [fixtureTrigger()] : [];
    },
    query: async (sql) => {
      if (sql.includes('luna_dynamic_tpsl_shadow') && existingShadow) {
        return [{
          trigger_id: 'trigger-BTC/USDT',
          symbol: 'BTC/USDT',
          exchange: 'binance',
          market: 'crypto',
          observed_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('luna_entry_llm_shadow') && entryShadow) {
        return [{
          trigger_id: 'trigger-BTC/USDT',
          symbol: 'BTC/USDT',
          exchange: 'binance',
          market: 'crypto',
          llm_fire: true,
          llm_confidence: 0.76,
          dynamic_threshold: 0.68,
          observed_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('luna_regime_llm_shadow')) {
        return [{
          market: 'crypto',
          rule_regime: 'trending_bull',
          llm_regime: 'trending_bull',
          llm_confidence: 0.82,
          match: true,
          captured_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('FROM investment.positions')) {
        return [{
          symbol: 'ETH/USDT',
          amount: 1,
          paper: false,
          exchange: 'binance',
          updated_at: new Date().toISOString(),
        }];
      }
      return [];
    },
    run: async (sql, params) => {
      inserts.push({ sql, params });
      return { rowCount: 1 };
    },
    callViaHub: async (...args) => {
      llmCalls.push(args);
      return {
        ok: true,
        text: JSON.stringify({
          tp_pct: 6,
          sl_pct: 3,
          rr_ratio: 2,
          reasoning: `shadow tpsl valid ${FAKE_SK_VALUE}`,
          risk_assessment: {
            risk_level: 'medium',
            main_risk: `volatility ${TOKEN_LABEL}=${FAKE_TOKEN_VALUE}`,
            nested: {
              [API_KEY_LABEL]: FAKE_SK_VALUE,
              notes: [FAKE_BEARER_HEADER],
            },
          },
        }),
      };
    },
  };
}

export async function runLunaDynamicTpSlSmoke() {
  const investmentRoot = path.resolve(import.meta.dirname, '..');
  const migration = fs.readFileSync(path.join(investmentRoot, 'migrations/20260511_luna_dynamic_tpsl_shadow.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(investmentRoot, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
  assert.match(migration, /luna_dynamic_tpsl_shadow/);
  assert.match(migration, /rule_tp_pct/);
  assert.match(migration, /llm_sl_pct/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS luna_dynamic_tpsl_shadow/);
  assert.match(bootstrap, /idx_luna_dynamic_tpsl_shadow_symbol_observed/);

  const rule = buildRuleDynamicTpSl({
    candidate: {
      symbol: 'BTC/USDT',
      exchange: 'binance',
      entry_price: 100,
      atr: 2,
      setup_type: 'breakout',
    },
    regimeShadow: { llm_regime: 'trending_bull' },
  });
  assert.equal(rule.ok, true);
  assert.equal(rule.entryPrice, 100);
  assert(rule.tpPct > rule.slPct);
  assert(rule.rrRatio >= 2);

  const plannedRule = buildRuleDynamicTpSl({
    candidate: {
      symbol: 'BTC/USDT',
      exchange: 'binance',
      target_price: 100,
      stop_loss: 97,
      take_profit: 106,
      setup_type: 'breakout',
    },
  });
  assert.equal(plannedRule.ok, true);
  assert.equal(plannedRule.source, 'existing_trigger_tpsl');
  assert.equal(plannedRule.entryPrice, 100);
  assert.equal(plannedRule.slPct, 0.03);
  assert.equal(plannedRule.tpPct, 0.06);
  assert.equal(plannedRule.rrRatio, 2);

  const normalized = normalizeDynamicTpSlShadowResult({
    tp_pct: 6,
    sl_pct: 3,
    rr_ratio: 2,
    reasoning: `safe but ${FAKE_SK_VALUE} must be redacted`,
    riskAssessment: {
      main_risk: `${TOKEN_LABEL}=${FAKE_TOKEN_VALUE}`,
      nested: { [API_KEY_LABEL]: FAKE_SK_VALUE, bearer: FAKE_BEARER_HEADER },
    },
  }, { entryPrice: 100, side: 'BUY', tpPct: rule.tpPct, slPct: rule.slPct });
  assert.equal(normalized.tpPct, 0.06);
  assert.equal(normalized.slPct, 0.03);
  assert.equal(normalized.takeProfit, 106);
  assert.equal(normalized.stopLoss, 97);
  assert.equal(normalized.riskAssessment.nested[API_KEY_LABEL], '[redacted]');
  const normalizedText = JSON.stringify(normalized);
  assert.equal(normalizedText.includes(FAKE_SK_VALUE), false);
  assert.equal(normalizedText.includes(FAKE_BEARER_VALUE), false);
  assert.equal(normalizedText.includes(FAKE_TOKEN_VALUE), false);

  const dryDeps = fakeDeps();
  const planned = await runLunaDynamicTpSlShadow({
    apply: false,
    confirm: '',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 3,
  }, dryDeps);
  assert.equal(planned.status, 'luna_dynamic_tpsl_shadow_planned');
  assert.equal(planned.summary.llmCalls, 0);
  assert.equal(dryDeps.inserts.length, 0);
  assert.equal(dryDeps.schemaInits.length, 0);
  assert.equal(dryDeps.listCalls[0].states.includes('fired'), true);
  assert.equal(planned.rows[0].ruleTpSl.ok, true);
  assert.equal(planned.rows[0].entryShadowSource, 'db');

  const previewDeps = fakeDeps({ entryShadow: false });
  const preview = await runLunaDynamicTpSlShadow({
    apply: false,
    confirm: '',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 0,
  }, previewDeps);
  assert.equal(preview.rows[0].entryShadowReady, true);
  assert.equal(preview.rows[0].entryShadowSource, 'deterministic_preview');
  assert.equal(preview.summary.llmCalls, 0);
  assert.equal(previewDeps.inserts.length, 0);
  assert.equal(previewDeps.schemaInits.length, 0);

  const applyDeps = fakeDeps();
  const written = await runLunaDynamicTpSlShadow({
    apply: true,
    confirm: 'luna-dynamic-tpsl-shadow',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 1,
  }, applyDeps);
  assert.equal(written.status, 'luna_dynamic_tpsl_shadow_written');
  assert.equal(written.summary.written, 1);
  assert.equal(written.summary.llmCalls, 1);
  assert.equal(applyDeps.inserts.length, 1);
  assert.equal(applyDeps.schemaInits.length, 1);
  assert.equal(applyDeps.llmCalls[0][3].taskType, 'dynamic_tpsl_shadow');
  assert.doesNotMatch(applyDeps.llmCalls[0][2], /supersecret-token/);
  assert.equal(applyDeps.llmCalls[0][2].includes(FAKE_SK_VALUE), false);
  const insertedRisk = JSON.parse(applyDeps.inserts[0].params[16]);
  const insertedRiskText = JSON.stringify(insertedRisk);
  assert.equal(insertedRisk.nested[API_KEY_LABEL], '[redacted]');
  assert.equal(insertedRiskText.includes(FAKE_SK_VALUE), false);
  assert.equal(insertedRiskText.includes(FAKE_BEARER_VALUE), false);
  assert.equal(insertedRiskText.includes(FAKE_TOKEN_VALUE), false);

  const cappedDeps = fakeDeps();
  const capped = await runLunaDynamicTpSlShadow({
    apply: true,
    confirm: 'luna-dynamic-tpsl-shadow',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 0,
  }, cappedDeps);
  assert.equal(capped.rows[0].reason, 'llm_call_cap_reached');
  assert.equal(capped.summary.llmCalls, 0);
  assert.equal(cappedDeps.inserts.length, 0);

  const freshDeps = fakeDeps({ existingShadow: true });
  const fresh = await runLunaDynamicTpSlShadow({
    apply: true,
    confirm: 'luna-dynamic-tpsl-shadow',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 1,
  }, freshDeps);
  assert.equal(fresh.rows[0].reason, 'fresh_shadow_exists');
  assert.equal(fresh.summary.llmCalls, 0);

  return {
    ok: true,
    smoke: 'luna-dynamic-tpsl-shadow',
    planned: planned.status,
    written: written.status,
    capGuard: capped.rows[0].reason,
    freshGuard: fresh.rows[0].reason,
  };
}

async function main() {
  const result = await runLunaDynamicTpSlSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna dynamic TP/SL smoke 실패:',
  });
}
