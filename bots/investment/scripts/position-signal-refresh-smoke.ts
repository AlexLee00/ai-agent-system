#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { refreshPositionSignals } from '../shared/position-signal-refresh.ts';
import { assertSmokePass } from '../shared/smoke-assert.ts';

export async function runPositionSignalRefreshSmoke({ json = false, strict = true } = {}) {
  const savedEnv = process.env.LUNA_POSITION_SIGNAL_REFRESH_ENABLED;
  process.env.LUNA_POSITION_SIGNAL_REFRESH_ENABLED = 'true';

  const writes = [];
  try {
    const output = await refreshPositionSignals({
      exchange: 'binance',
      symbol: 'BTC/USDT',
      tradeMode: 'normal',
      source: 'smoke',
      limit: 1,
      deps: {
        getOpenPositions: async () => ([
          { exchange: 'binance', symbol: 'BTC/USDT', trade_mode: 'normal', amount: 0.1, avg_price: 60000 },
        ]),
        getRecentExternalEvidence: async () => ([
          { id: 'e1', source_type: 'reddit', score: -0.6, source_quality: 0.7, freshness_score: 1.0 },
          { id: 'e2', source_type: 'news', score: -0.2, source_quality: 0.6, freshness_score: 0.9 },
        ]),
        getPositionStrategyProfile: async () => null,
        insertPositionSignalHistory: async (payload) => {
          writes.push(payload);
          return { id: 'psh_1', created_at: new Date().toISOString() };
        },
        recordLifecycle: async () => 'evt_1',
      },
    });
    const carryoverWrites = [];
    const entryCreatedAt = new Date(Date.now() - (3 * 60 * 60 * 1000)).toISOString();
    const carryoverOutput = await refreshPositionSignals({
      exchange: 'kis_overseas',
      symbol: 'ABEV',
      tradeMode: 'normal',
      source: 'smoke',
      limit: 1,
      deps: {
        getOpenPositions: async () => ([
          {
            exchange: 'kis_overseas',
            symbol: 'ABEV',
            trade_mode: 'normal',
            amount: 11,
            avg_price: 4.5,
          },
        ]),
        getRecentExternalEvidence: async () => [],
        getPositionStrategyProfile: async () => ({
          strategy_context: {
            entryEvidenceSummary: {
              source: 'entry_signal_snapshot',
              evidenceCount: 3,
              sourceCount: 3,
              sources: [
                { source: 'entry_decision_confidence', count: 1, avgScore: 0.2, avgQuality: 0.72, weight: 0.5 },
                { source: 'entry_analyst_consensus', count: 1, avgScore: 0.2, avgQuality: 0.72, weight: 0.25 },
                { source: 'technical_strategy_route', count: 1, avgScore: 0.2, avgQuality: 0.72, weight: 0.65 },
              ],
              sentimentScore: 0.2,
              qualityScore: 0.72,
              carryoverMaxHours: 24,
              entryEvidence: true,
            },
            entryThesisSnapshot: {
              createdAt: entryCreatedAt,
              signalId: 'entry-signal-1',
            },
          },
        }),
        insertPositionSignalHistory: async (payload) => {
          carryoverWrites.push(payload);
          return { id: 'psh_2', created_at: new Date().toISOString() };
        },
        recordLifecycle: async () => 'evt_2',
      },
    });
    const row = output.rows?.[0] || null;
    const carryoverRow = carryoverOutput.rows?.[0] || null;
    const cases = [
      { name: 'refresh_ok', pass: output.ok === true },
      { name: 'one_row', pass: output.count === 1 },
      { name: 'attention_set', pass: typeof row?.attentionType === 'string' && row.attentionType.length > 0 },
      { name: 'history_written', pass: writes.length === 1 },
      { name: 'carryover_refresh_ok', pass: carryoverOutput.ok === true && carryoverOutput.count === 1 },
      { name: 'carryover_clears_low_evidence', pass: carryoverRow?.attentionType == null && !carryoverRow?.qualityFlags?.includes('low_evidence') },
      { name: 'carryover_marked', pass: carryoverRow?.carryover?.reason === 'external_evidence_empty_entry_snapshot_carryover' && Boolean(carryoverWrites[0]?.evidenceSnapshot?.carryover) },
      { name: 'carryover_uses_entry_thesis_age', pass: Number(carryoverRow?.carryover?.heldHours || 0) >= 2.9 },
    ];
    const passed = cases.filter((item) => item.pass).length;
    const total = cases.length;
    const summary = {
      pass: passed === total,
      passed,
      total,
      results: cases,
      output,
      writes,
    };
    if (strict) assertSmokePass(summary, '[position-signal-refresh-smoke]');
    if (json) return summary;
    return {
      ...summary,
      text: [
        `[position-signal-refresh-smoke] ${passed}/${total} 통과`,
        ...cases.map((item) => `${item.pass ? '✓' : '✗'} ${item.name}`),
      ].join('\n'),
    };
  } finally {
    if (savedEnv === undefined) delete process.env.LUNA_POSITION_SIGNAL_REFRESH_ENABLED;
    else process.env.LUNA_POSITION_SIGNAL_REFRESH_ENABLED = savedEnv;
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const json = process.argv.includes('--json');
      return runPositionSignalRefreshSmoke({ json, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[position-signal-refresh-smoke]',
  });
}
