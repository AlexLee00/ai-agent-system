#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');
const {
  hasPublicMarketBriefDisclaimer,
  validatePostQuality,
} = require('../lib/edux-runtime-support.ts');

const EDUX_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');

const SLOT_RUNS = [
  { script: 'runtime-edux-crypto-daily.ts', category: 'crypto', slot: '0600' },
  { script: 'runtime-edux-overseas-daily.ts', category: 'overseas', slot: '0630', env: { EDUX_TEST_NOW: '2026-06-12T21:30:00.000Z' } },
  { script: 'runtime-edux-kis-daily.ts', category: 'kis', slot: '0900' },
  { script: 'runtime-edux-crypto-daily.ts', category: 'crypto', slot: '1400' },
  { script: 'runtime-edux-kis-daily.ts', category: 'kis', slot: '1600', env: { EDUX_TEST_NOW: '2026-06-12T07:00:00.000Z' } },
  { script: 'runtime-edux-overseas-daily.ts', category: 'overseas', slot: '2200' },
  { script: 'runtime-edux-crypto-daily.ts', category: 'crypto', slot: '2230' },
];

const QUALITY_CONTRACTS = {
  crypto: {
    minContentLen: 1400,
    minNumericSignals: 20,
    requiredTerms: ['BTC/USDT', '지지', '저항', '상승 시나리오', '하락 시나리오', '커뮤니티·뉴스 이슈', '인공지능 추천안'],
  },
  kis: {
    minContentLen: 1250,
    minNumericSignals: 12,
    requiredTerms: ['코스피', '코스닥', '외국인', '기관', '오늘 볼 섹터', '인공지능 추천안'],
  },
  overseas: {
    minContentLen: 1350,
    minNumericSignals: 18,
    requiredTerms: ['S&P500', 'Nasdaq', 'VIX', 'DXY', 'Magnificent 7', '인공지능 추천안'],
  },
  kis_close: {
    minContentLen: 1000,
    minNumericSignals: 12,
    requiredTerms: ['■ 마감 확정치', '■ 수급 (확정)', '■ 섹터 승자/패자', '■ 09:00 예고 vs 실제', '■ 오늘의 핵심 이슈', '■ 내일 관찰 포인트', '💡 왜 중요한가:', '22:00 미국증시 장전'],
  },
  overseas_close: {
    minContentLen: 950,
    minNumericSignals: 14,
    requiredTerms: ['■ 3대 지수 종가', '■ Mag7 마감', '■ 섹터·금리·달러', '■ 헤드라인 회고', '■ 한국 시장 시사점', '■ 오늘 한국장 관찰 포인트', '💡 왜 중요한가:', '09:00 국내증시 장전'],
  },
};

function parseJsonFromStdout(stdout) {
  const starts = [];
  for (let i = 0; i < stdout.length; i += 1) {
    if (stdout[i] === '{') starts.push(i);
  }
  for (const start of starts) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {}
  }
  throw new Error(`JSON payload not found in stdout: ${stdout.slice(-800)}`);
}

function sectionContractKey(category, slot) {
  if (category === 'kis' && slot === '1600') return 'kis_close';
  if (category === 'overseas' && slot === '0630') return 'overseas_close';
  return category;
}

function runRuntime(run) {
  const stdout = execFileSync(process.execPath, [path.join(EDUX_ROOT, 'scripts', run.script), '--fixture', '--dry-run', '--json', `--slot=${run.slot}`], {
    cwd: EDUX_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      EDUX_SKIP_DB: 'true',
      EDUX_DRY_RUN: 'true',
      EDUX_FORMATTER_FIXTURE: 'true',
      EDUX_DISABLE_TRADINGVIEW_READONLY: 'true',
      EDUX_DISABLE_TELEGRAM: 'true',
      ...(run.env || {}),
    },
    maxBuffer: 1024 * 1024 * 8,
  });
  const result = parseJsonFromStdout(stdout);
  assert.equal(result.ok, true, `${run.category}:${run.slot} dry-run failed: ${stdout.slice(-800)}`);
  assert.equal(result.status, 'dry_run', `${run.category}:${run.slot} should be dry_run`);
  assert.equal(result.category, run.category, `${run.category}:${run.slot} category mismatch`);
  assert.equal(result.slot, run.slot, `${run.category}:${run.slot} slot mismatch`);
  assert.equal(Array.isArray(result.imagePaths) ? result.imagePaths.length : 0, 0, `${run.category}:${run.slot} should be text-only`);
  assert(result.artifact?.mdPath?.includes('/output/dry-run/fixture/'), `${run.category}:${run.slot} must use fixture dry-run artifact`);
  return result;
}

function numericSignalCount(text) {
  return (String(text || '').match(/[$₩]?\d+(?:,\d{3})*(?:\.\d+)?%?|\b\d+(?:\.\d+)?pt\b/g) || []).length;
}

function assertNoPositiveLoserLine(text) {
  const loserLine = String(text || '').split(/\r?\n/).find((line) => line.trim().startsWith('🔽'));
  assert(loserLine, 'kis:1600 missing loser line');
  assert(!/\+\d/.test(loserLine), `kis:1600 loser line includes positive sector: ${loserLine}`);
}

function assertContentQuality(run, result) {
  const mdPath = result.artifact.mdPath;
  const content = fs.readFileSync(mdPath, 'utf8');
  const contractKey = sectionContractKey(run.category, run.slot);
  const contract = QUALITY_CONTRACTS[contractKey];
  const baseQuality = validatePostQuality({ content, category: run.category, slot: run.slot });
  assert.equal(baseQuality.ok, true, `${run.category}:${run.slot} base quality failed: ${JSON.stringify(baseQuality)}`);
  assert.equal(hasPublicMarketBriefDisclaimer(content), true, `${run.category}:${run.slot} missing disclaimer`);
  assert(!/[①②③④⑤⑥⑦⑧⑨⑩]/.test(content), `${run.category}:${run.slot} should not use legacy section numbers`);
  assert(!/<think>|Okay, let's|N\/A|데이터 없음|\[이미지|좋아요|댓글|activity|Notion/i.test(content), `${run.category}:${run.slot} contains forbidden text`);
  assert(content.length >= contract.minContentLen, `${run.category}:${run.slot} content too short: ${content.length}/${contract.minContentLen}`);
  assert(numericSignalCount(content) >= contract.minNumericSignals, `${run.category}:${run.slot} numeric density too low`);
  for (const term of contract.requiredTerms) {
    assert(content.includes(term), `${run.category}:${run.slot} missing required term: ${term}`);
  }
  assert(/다음:/.test(content), `${run.category}:${run.slot} missing next-slot preview`);
  if (contractKey.endsWith('_close')) {
    assert(!content.includes('🤖 인공지능 추천안'), `${run.category}:${run.slot} close slot must not include AI recommendation block`);
  } else {
    assert(content.includes('🤖 인공지능 추천안'), `${run.category}:${run.slot} missing AI recommendation block`);
  }
  if (contractKey === 'kis_close') assertNoPositiveLoserLine(content);
  return {
    category: run.category,
    slot: run.slot,
    contract: contractKey,
    contentLen: content.length,
    numericSignals: numericSignalCount(content),
    sectionCount: baseQuality.sectionCount,
    artifact: mdPath,
  };
}

function main() {
  const results = SLOT_RUNS.map((run) => assertContentQuality(run, runRuntime(run)));
  console.log(JSON.stringify({
    ok: true,
    assertions: ['TS-EXQ-1 seven-slot dry-run', 'TS-EXQ-2 text-only artifacts', 'TS-EXQ-3 content density', 'TS-EXQ-4 close-slot review quality', 'TS-EXQ-5 no positive losers'],
    results,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
