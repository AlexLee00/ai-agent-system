#!/usr/bin/env node
// @ts-nocheck

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEPHAESTOS_PATH = join(__dirname, '..', 'team', 'hephaestos.ts');
const HEPHAESTOS_MODULE_DIR = join(__dirname, '..', 'team', 'hephaestos');
const ACTIVE_CANDIDATE_THRESHOLD = 25;

const CANDIDATE_RULES = [
  { module: 'binance-order-reconcile.ts', pattern: /pending[_-]?reconcile|manual_reconcile|clientOrderId|fetchBinanceOrder/gi, reason: '주문 조회/정산/수동정산 경로 분리' },
  { module: 'binance-execution-normalized.ts', pattern: /normalizeBinanceMarketOrderExecution|order_fill_unverified|createOrder|executionStatus/gi, reason: '주문 실행 정규화와 체결 검증 분리' },
  { module: 'btc-pair-direct-buy.ts', pattern: /BTC pair|BTC\/USDT|_tryBuyWithBtcPair|btcReferencePrice/gi, reason: 'BTC quote 직접 매수와 환산 계약 분리' },
  { module: 'market-signal-persistence.ts', pattern: /insertSignal|markSignal|updateSignal|signal_id|signals/gi, reason: '신호 저장/idempotency 경로 분리' },
  { module: 'portfolio-position-delta.ts', pattern: /upsertPosition|positions|trade_journal|avg_price|unrealized/gi, reason: '포지션/거래 장부 변경 경로 분리' },
  { module: 'risk-and-capital-gates.ts', pattern: /capital|buyingPower|risk|guard|backpressure/gi, reason: '리스크/자본 게이트 분리' },
  { module: 'protective-exit.ts', pattern: /protective|TP\/SL|OCO|stop_loss|take_profit|tpSl/gi, reason: '보호주문 가격 정규화와 OCO/SL-only 정책 분리' },
  { module: 'untracked-capital.ts', pattern: /untracked|미추적|liquidate|dust|convert|잔고 흡수/gi, reason: '미추적 잔고 흡수/청산과 dust convert 경로 분리' },
  { module: 'mcp-binance-bridge.ts', pattern: /MCP|mcp|market_buy|market_sell|binance-market-mcp/gi, reason: 'MCP 브리지와 direct CCXT fallback 분리' },
  { module: 'telegram-trade-alerts.ts', pattern: /publishAlert|telegram|alert|notify/gi, reason: '거래 알림과 운영 알림 분리' },
];

function countMatches(source = '', pattern) {
  return (source.match(pattern) || []).length;
}

export async function buildHephaestosRefactorReport({ maxCandidates = 8 } = {}) {
  const source = readFileSync(HEPHAESTOS_PATH, 'utf8');
  const lines = source.split(/\r?\n/);
  const candidates = CANDIDATE_RULES
    .map((rule) => {
      const score = countMatches(source, rule.pattern);
      const extracted = existsSync(join(HEPHAESTOS_MODULE_DIR, rule.module));
      return {
        module: rule.module,
        score,
        activeScore: extracted ? 0 : score,
        extracted,
        status: extracted ? 'extracted' : (score >= ACTIVE_CANDIDATE_THRESHOLD ? 'candidate' : 'low_score_candidate'),
        reason: rule.reason,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.activeScore - a.activeScore) || (b.score - a.score))
    .slice(0, Math.max(1, Number(maxCandidates || 8)));
  const activeCandidates = candidates.filter((item) => !item.extracted && item.score >= ACTIVE_CANDIDATE_THRESHOLD);
  const warnings = [];
  if (lines.length > 4000) warnings.push(`hephaestos_large_file:${lines.length}_lines`);
  if (activeCandidates.length > 0) warnings.push('hephaestos_refactor_candidates_available');
  return {
    ok: true,
    status: activeCandidates.length > 0 ? 'hephaestos_refactor_candidates_ready' : 'hephaestos_refactor_tranche_clear',
    file: HEPHAESTOS_PATH,
    lineCount: lines.length,
    candidates,
    activeCandidates,
    warnings,
    nextAction: activeCandidates.length > 0
      ? `extract_${activeCandidates[0].module}`
      : 'monitor_remaining_low_score_candidates',
  };
}

function renderText(report = {}) {
  const lines = [
    '🛠 Hephaestos refactor candidate report',
    `status: ${report.status || 'unknown'}`,
    `lines: ${report.lineCount || 0}`,
    `next: ${report.nextAction || 'unknown'}`,
  ];
  for (const candidate of report.candidates || []) {
    lines.push(`- ${candidate.module}: score=${candidate.score} / ${candidate.reason}`);
  }
  return lines.join('\n');
}

async function main() {
  const json = process.argv.includes('--json');
  const report = await buildHephaestosRefactorReport();
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ hephaestos-refactor-candidate-report 실패:',
  });
}
