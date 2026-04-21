#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

async function loadRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  return db.query(
    `SELECT
       id,
       symbol,
       status,
       created_at,
       approved_at,
       block_meta
     FROM investment.signals
     WHERE exchange = 'binance'
       AND status = 'executed'
       AND created_at > now() - INTERVAL '${safeDays} days'
       AND block_meta IS NOT NULL
       AND (block_meta->'executionMeta'->>'softGuardApplied')::boolean = true
     ORDER BY created_at DESC`
  );
}

function countBy(rows = [], keyFn = (row) => row) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function toReduction(row) {
  return Number(row?.block_meta?.executionMeta?.reducedAmountMultiplier || 1);
}

function summarize(rows = []) {
  const guardRows = rows.flatMap((row) => {
    const guards = row?.block_meta?.executionMeta?.softGuards || [];
    return guards.map((guard) => ({
      symbol: row.symbol,
      kind: guard.kind || 'unknown',
      reductionMultiplier: Number(guard.reductionMultiplier || row?.block_meta?.executionMeta?.reducedAmountMultiplier || 1),
      createdAt: row.created_at,
    }));
  });

  const byKind = countBy(guardRows, (row) => row.kind);
  const bySymbol = countBy(rows, (row) => row.symbol).slice(0, 8);
  const reductions = rows
    .map(toReduction)
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 1);

  const avgReductionMultiplier = reductions.length > 0
    ? reductions.reduce((sum, value) => sum + value, 0) / reductions.length
    : 1;

  return {
    total: rows.length,
    byKind,
    bySymbol,
    avgReductionMultiplier,
    strongestReductionMultiplier: reductions.length > 0 ? Math.min(...reductions) : 1,
  };
}

function buildDecision(summary) {
  const total = Number(summary.total || 0);
  const topKind = summary.byKind[0] || null;
  const topSymbol = summary.bySymbol[0] || null;
  const avgReductionMultiplier = Number(summary.avgReductionMultiplier || 1);

  let status = 'crypto_soft_guard_idle';
  let headline = '최근 soft guard 실행 표본이 없습니다.';
  const reasons = [
    `soft guard 실행 ${total}건`,
    `가드 분포: ${(summary.byKind || []).map((item) => `${item.key} ${item.count}`).join(' | ') || '없음'}`,
    `평균 감산 배율: x${avgReductionMultiplier.toFixed(2)}`,
  ];
  const actionItems = [];

  if (total >= 5) {
    status = 'crypto_soft_guard_active';
    headline = 'soft guard가 실제 실행으로 이어지며 개발 단계 학습 기회를 만들고 있습니다.';
  } else if (total > 0) {
    status = 'crypto_soft_guard_watch';
    headline = 'soft guard가 일부 실행을 살렸지만 표본은 아직 많지 않습니다.';
  }

  if (topKind) actionItems.push(`${topKind.key}가 가장 자주 완화되는지 계속 추적합니다.`);
  if (topSymbol) actionItems.push(`${topSymbol.key}가 soft guard 빈도가 높은 심볼인지 함께 복기합니다.`);
  if (avgReductionMultiplier < 0.65) {
    actionItems.push('감산 폭이 큰 편이라 실제 체결 유지 여부를 같이 확인합니다.');
  }
  if (actionItems.length === 0) {
    actionItems.push('soft guard가 실제 실행으로 이어지는지 계속 누적 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total,
      avgReductionMultiplier,
      strongestReductionMultiplier: Number(summary.strongestReductionMultiplier || 1),
      topKind: topKind?.key || null,
      topKindCount: Number(topKind?.count || 0),
      topSymbol: topSymbol?.key || null,
      topSymbolCount: Number(topSymbol?.count || 0),
    },
  };
}

function renderText(payload) {
  const lines = [
    '🛟 Runtime Crypto Soft Guard',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((item) => `- ${item}`),
    '',
    '주요 심볼:',
    ...(payload.summary.bySymbol.length > 0
      ? payload.summary.bySymbol.slice(0, 5).map((item) => `- ${item.key}: ${item.count}건`)
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  if (decision.status === 'crypto_soft_guard_active') {
    return 'soft guard가 실제 실행으로 이어지고 있어, 개발 단계에서는 차단보다 감산 허용이 작동하는 흐름입니다.';
  }
  if (decision.status === 'crypto_soft_guard_watch') {
    return 'soft guard가 일부 실행을 살렸지만 표본은 아직 적어 조금 더 관찰이 필요합니다.';
  }
  return '최근 soft guard 실행 표본이 없어 아직 관찰 중심으로 보면 됩니다.';
}

export async function buildRuntimeCryptoSoftGuardReport({ days = 14, json = false } = {}) {
  const rows = await loadRows(days);
  const summary = summarize(rows);
  const decision = buildDecision(summary);
  const payload = {
    ok: true,
    days,
    count: rows.length,
    rows,
    summary,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-crypto-soft-guard-report',
    requestType: 'runtime-crypto-soft-guard-report',
    title: '투자 암호화폐 soft guard 리포트 요약',
    data: { days, summary, decision },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeCryptoSoftGuardReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-crypto-soft-guard-report 오류:',
  });
}
