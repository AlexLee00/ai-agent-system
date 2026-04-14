#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runVectorBtGrid } from '../shared/vectorbt-runner.ts';
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');

const taOptimizationMemory = createAgentMemory({ agentId: 'investment.ta-optimization', team: 'investment' });

function parseArg(name, fallback = null) {
  return process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] || fallback;
}

function ensureOptimizationSchema() {
  return db.run(`
    CREATE TABLE IF NOT EXISTS ta_param_optimization (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      params JSONB NOT NULL,
      sharpe DOUBLE PRECISION,
      total_return DOUBLE PRECISION,
      mdd DOUBLE PRECISION,
      win_rate DOUBLE PRECISION,
      total_trades INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function persistTopResults(symbol, results = []) {
  const topResults = results.slice(0, 5);
  for (const item of topResults) {
    await db.run(`
      INSERT INTO ta_param_optimization (
        symbol, params, sharpe, total_return, mdd, win_rate, total_trades
      ) VALUES (?, ?::jsonb, ?, ?, ?, ?, ?)
    `, [
      symbol,
      JSON.stringify(item.params || {}),
      item.sharpe_ratio ?? null,
      item.total_return ?? null,
      item.max_drawdown ?? null,
      item.win_rate ?? null,
      item.total_trades ?? null,
    ]);
  }
  return topResults;
}

function buildOptimizationMessage(symbol, days, results = []) {
  const lines = [
    `📊 TA 파라미터 최적화`,
    `- 심볼: ${symbol}`,
    `- 기간: 최근 ${days}일`,
  ];
  results.slice(0, 3).forEach((item, index) => {
    lines.push(
      `- #${index + 1} 샤프=${Number(item.sharpe_ratio || 0).toFixed(2)} ` +
      `수익=${Number(item.total_return || 0).toFixed(1)}% ` +
      `MDD=${Number(item.max_drawdown || 0).toFixed(1)}% ` +
      `승률=${Number(item.win_rate || 0).toFixed(1)}%`,
    );
  });
  return lines.join('\n');
}

function buildOptimizationMemoryQuery(symbol, days, results = []) {
  return [
    'investment ta optimization',
    symbol,
    `${days}d`,
    results[0]?.params?.timeframe || null,
  ].filter(Boolean).join(' ');
}

export async function runOptimization(symbol = 'BTC/USDT', days = 90, { alert = true } = {}) {
  const results = runVectorBtGrid(symbol, days);
  if (!Array.isArray(results)) {
    return {
      symbol,
      days,
      status: results?.status || 'error',
      details: results,
      totalResults: 0,
      topResults: [],
    };
  }

  try {
    await db.initSchema();
    await ensureOptimizationSchema();
  } catch (error) {
    return {
      symbol,
      days,
      status: 'db_unavailable',
      details: { message: error?.message || String(error) },
      totalResults: results.length,
      topResults: results.slice(0, 5),
    };
  }

  const topResults = await persistTopResults(symbol, results);

  if (alert && topResults.length > 0) {
    const memoryQuery = buildOptimizationMemoryQuery(symbol, days, topResults);
    const episodicHint = await taOptimizationMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 최적화',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        optimization: '최적화',
      },
      order: ['optimization'],
    }).catch(() => '');
    const semanticHint = await taOptimizationMemory.recallHint(`${memoryQuery} consolidated optimization pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    const message = `${buildOptimizationMessage(symbol, days, topResults)}${episodicHint}${semanticHint}`;
    await publishAlert({
      from_bot: 'luna-optimize-ta',
      event_type: 'ta_optimization_report',
      alert_level: 1,
      message,
      payload: {
        symbol,
        days,
        topResults,
      },
    }).catch(() => {});
    await taOptimizationMemory.remember(message, 'episodic', {
      importance: 0.68,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind: 'optimization',
        symbol,
        days,
        topSharpe: topResults[0]?.sharpe_ratio ?? null,
      },
    }).catch(() => {});
    await taOptimizationMemory.consolidate({
      olderThanDays: 14,
      limit: 10,
    }).catch(() => {});
  }

  return {
    symbol,
    days,
    status: 'ok',
    totalResults: results.length,
    topResults,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const symbol = parseArg('symbol', 'BTC/USDT');
      const days = Number(parseArg('days', '90'));
      const noAlert = parseArg('no-alert', null) != null;
      return runOptimization(symbol, days, { alert: !noAlert });
    },
    onSuccess: async (result) => {
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ TA 파라미터 최적화 오류:',
  });
}
