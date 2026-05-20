#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  EDUX_POST_SHADOW_SOURCE_TYPE,
  buildEduxPostEvidenceRecords,
  inferEduxSymbols,
  marketFromEduxCategory,
  summarizeEduxEvidenceRecords,
} from '../shared/luna-edux-post-evidence.ts';
import { runLunaEduxPostEvidenceBridge } from './runtime-luna-edux-post-evidence-bridge.ts';

export async function runLunaEduxPostEvidenceBridgeSmoke() {
  const posts = [
    {
      id: 'smoke-crypto',
      category: 'crypto',
      slot: '0600',
      title: '05/20 BTC/USDT 시황 카드 | $106,500 +1.8%',
      content: '⚡ 핵심 3줄\n- BTC/USDT는 $104,200 지지와 $108,900 저항 사이의 결정 구간입니다.\n\n🤖 인공지능 추천안\n- 관찰 우선입니다.',
      generatedAt: new Date().toISOString(),
    },
    {
      id: 'smoke-kis',
      category: 'kis',
      slot: '0900',
      title: '05/20 국내주식 시황 카드 | 코스피 2,920 +0.7%',
      content: '⚡ 핵심 3줄\n- 외국인 수급을 먼저 확인합니다.',
      generatedAt: new Date().toISOString(),
    },
    {
      id: 'smoke-overseas',
      category: 'overseas',
      slot: '2200',
      title: '05/20 해외주식 시황 카드 | S&P500 6,250 +0.5%',
      content: '⚡ 핵심 3줄\n- NVDA와 Nasdaq 동조를 먼저 확인합니다.',
      generatedAt: new Date().toISOString(),
    },
  ];

  assert.equal(marketFromEduxCategory('crypto'), 'crypto');
  assert.equal(marketFromEduxCategory('kis'), 'domestic');
  assert.equal(marketFromEduxCategory('overseas'), 'overseas');
  assert.deepEqual(inferEduxSymbols(posts[0]), ['BTC/USDT']);

  const records = buildEduxPostEvidenceRecords(posts, { now: new Date().toISOString() });
  const summary = summarizeEduxEvidenceRecords(records);

  assert.equal(records.every((record) => record.sourceType === EDUX_POST_SHADOW_SOURCE_TYPE), true);
  assert.equal(records.every((record) => record.sourceType !== 'community'), true);
  assert.equal(records.every((record) => record.signalDirection === 'neutral'), true);
  assert.equal(records.every((record) => Number(record.score) === 0), true);
  assert.equal(records.every((record) => record.rawRef?.shadowOnly === true), true);
  assert.equal(records.every((record) => record.rawRef?.liveMutation === false), true);
  assert.equal(records.every((record) => record.rawRef?.decisionAuthority === 'none'), true);
  assert.equal(summary.byMarket.crypto, 1);
  assert.equal(summary.byMarket.domestic, 1);
  assert.equal(summary.byMarket.overseas, 1);
  assert.ok(summary.symbols.includes('BTC/USDT'));

  const runtime = await runLunaEduxPostEvidenceBridge({
    fixture: true,
    dryRun: true,
    json: true,
    noWrite: true,
    limit: 10,
  });
  assert.equal(runtime.status, 'edux_shadow_evidence_planned');
  assert.equal(runtime.evidenceInserted, 0);
  assert.equal(runtime.safety.shadowOnly, true);
  assert.equal(runtime.safety.liveMutation, false);
  assert.equal(runtime.safety.tradingDecisionPriorityChanged, false);
  assert.equal(runtime.summary.sourceType, EDUX_POST_SHADOW_SOURCE_TYPE);

  const filteredRuntime = await runLunaEduxPostEvidenceBridge({
    dryRun: true,
    json: true,
    noWrite: true,
    limit: 10,
    source: 'artifacts',
    includeTestPosts: false,
  });
  assert.equal(
    filteredRuntime.sample.every((record) => !String(record.evidenceSummary || '').includes('[TEST]')),
    true,
    'test posts must be excluded from Luna shadow evidence by default',
  );

  return {
    ok: true,
    smoke: 'luna-edux-post-evidence-bridge',
    checks: {
      records: records.length,
      markets: summary.byMarket,
      symbols: summary.symbols,
      runtimeStatus: runtime.status,
      liveMutation: false,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaEduxPostEvidenceBridgeSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-edux-post-evidence-bridge-smoke error:',
  });
}
