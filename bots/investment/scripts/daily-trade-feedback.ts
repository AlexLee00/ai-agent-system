#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/daily-trade-feedback.ts — 루나팀 일일 피드백 루프
 *
 * 기능:
 *   - 당일 종료 거래 조회
 *   - 간단한 LLM 일일 회고 생성
 *   - 분석팀 정확도 요약
 *   - RAG 저장 (best-effort)
 *   - 텔레그램 간략 리포트 (best-effort)
 *
 * 실행:
 *   node scripts/daily-trade-feedback.ts
 *   node scripts/daily-trade-feedback.ts --date=2026-04-11
 *   node scripts/daily-trade-feedback.ts --dry-run
 *   node scripts/daily-trade-feedback.ts --json
 */

import { callLLM, parseJSON } from '../shared/llm-client.ts';
import { publishToMainBot } from '../shared/mainbot-client.ts';
import * as db from '../shared/db.ts';
import * as rag from '../shared/rag-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArg(name, fallback = null) {
  return process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] || fallback;
}

const DAILY_REVIEW_SYSTEM = `
당신은 루나팀 일일 매매 피드백 분석가다.
반드시 JSON 하나만 반환한다.
형식:
{
  "summary": "한 줄 요약",
  "wins": ["잘한 점"],
  "losses": ["아쉬운 점"],
  "nextActions": ["다음 액션"]
}
`;

async function fetchDailyTrades(dateKst) {
  try {
    return await db.query(`
      SELECT
        trade_id, symbol, exchange, direction, is_paper,
        COALESCE(trade_mode, 'normal') AS trade_mode,
        pnl_net, pnl_percent, exit_reason, reviewed_at
      FROM trade_journal
      WHERE CAST(to_timestamp(exit_time / 1000.0) AT TIME ZONE 'Asia/Seoul' AS DATE) = $1::date
        AND status IN ('closed', 'tp_hit', 'sl_hit', 'force_exit')
      ORDER BY exit_time DESC
      LIMIT 200
    `, [dateKst]);
  } catch (error) {
    console.warn(`  ⚠️ [daily-feedback] 거래 조회 실패: ${error?.message || error}`);
    return [];
  }
}

async function fetchDailyAnalystAccuracy(dateKst) {
  try {
    const rows = await db.query(`
      SELECT
        COUNT(*) AS total,
        AVG(CASE WHEN COALESCE((analyst_accuracy->>'aria')::boolean, aria_accurate) = true THEN 1.0 ELSE 0.0 END) AS aria_accuracy,
        AVG(CASE WHEN COALESCE((analyst_accuracy->>'sentinel')::boolean, sophia_accurate) = true THEN 1.0 ELSE 0.0 END) AS sophia_accuracy,
        AVG(CASE WHEN COALESCE((analyst_accuracy->>'oracle')::boolean, oracle_accurate) = true THEN 1.0 ELSE 0.0 END) AS oracle_accuracy,
        AVG(CASE WHEN COALESCE((analyst_accuracy->>'sentinel')::boolean, hermes_accurate) = true THEN 1.0 ELSE 0.0 END) AS hermes_accuracy
      FROM trade_review
      WHERE CAST(reviewed_at AT TIME ZONE 'Asia/Seoul' AS DATE) = $1::date
    `, [dateKst]);
    return rows[0] || null;
  } catch (error) {
    console.warn(`  ⚠️ [daily-feedback] analyst_accuracy 조회 실패: ${error?.message || error}`);
    return null;
  }
}

function buildDailyStats(trades = []) {
  const total = trades.length;
  const wins = trades.filter((trade) => Number(trade.pnl_net || 0) > 0).length;
  const losses = total - wins;
  const totalPnl = trades.reduce((sum, trade) => sum + Number(trade.pnl_net || 0), 0);
  const winRate = total > 0 ? wins / total : 0;
  const byExchange = {};
  for (const trade of trades) {
    const key = String(trade.exchange || 'unknown');
    byExchange[key] = byExchange[key] || { total: 0, pnl: 0 };
    byExchange[key].total += 1;
    byExchange[key].pnl += Number(trade.pnl_net || 0);
  }
  return { total, wins, losses, totalPnl, winRate, byExchange };
}

function formatAccuracy(value) {
  if (value == null || Number.isNaN(Number(value))) return 'N/A';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

async function buildDailyFeedback(dateKst, trades, analystAccuracy) {
  const stats = buildDailyStats(trades);
  if (trades.length === 0) {
    return {
      summary: '당일 종료 거래가 없어 운영 관찰 중심으로 마감합니다.',
      wins: ['종료 거래 없음'],
      losses: [],
      nextActions: ['다음 거래일에 신호 품질과 체결 효율을 계속 관찰합니다.'],
      stats,
    };
  }

  const userPrompt = [
    `date=${dateKst}`,
    `totalTrades=${stats.total}`,
    `wins=${stats.wins}`,
    `losses=${stats.losses}`,
    `totalPnl=${stats.totalPnl.toFixed(2)}`,
    `winRate=${(stats.winRate * 100).toFixed(1)}%`,
    `analystAccuracy=${JSON.stringify(analystAccuracy || {})}`,
    `trades=${JSON.stringify(trades.slice(0, 30))}`,
  ].join('\n');

  try {
    const raw = await callLLM('hermes', DAILY_REVIEW_SYSTEM, userPrompt, 400);
    const parsed = parseJSON(raw);
    if (parsed?.summary) {
      return { ...parsed, stats };
    }
  } catch (error) {
    console.warn(`  ⚠️ [daily-feedback] LLM 요약 실패: ${error?.message || error}`);
  }

  return {
    summary: `총 ${stats.total}건, 승률 ${(stats.winRate * 100).toFixed(1)}%, 손익 $${stats.totalPnl.toFixed(2)}로 마감했습니다.`,
    wins: stats.wins > 0 ? [`수익 거래 ${stats.wins}건이 있었습니다.`] : [],
    losses: stats.losses > 0 ? [`손실 거래 ${stats.losses}건을 복기해야 합니다.`] : [],
    nextActions: ['종료 사유와 analyst_accuracy를 기준으로 다음 거래일 진입 기준을 점검합니다.'],
    stats,
  };
}

function buildTelegramMessage(dateKst, feedback, analystAccuracy) {
  const lines = [
    `🌓 루나 일일 피드백 (${dateKst})`,
    `📌 ${feedback.summary}`,
    `📊 거래 ${feedback.stats.total}건 | 승률 ${(feedback.stats.winRate * 100).toFixed(1)}% | 손익 $${feedback.stats.totalPnl.toFixed(2)}`,
    `🧠 분석팀 정확도: aria ${formatAccuracy(analystAccuracy?.aria_accuracy)}, sophia ${formatAccuracy(analystAccuracy?.sophia_accuracy)}, oracle ${formatAccuracy(analystAccuracy?.oracle_accuracy)}, hermes ${formatAccuracy(analystAccuracy?.hermes_accuracy)}`,
  ];
  if (Array.isArray(feedback.nextActions) && feedback.nextActions.length > 0) {
    lines.push(`➡️ 다음 액션: ${feedback.nextActions.join(' / ')}`);
  }
  return lines.join('\n');
}

async function storeDailyFeedbackRag(dateKst, feedback, analystAccuracy) {
  const content = [
    `[일일 피드백 ${dateKst}] ${feedback.summary}`,
    `거래 ${feedback.stats.total}건 / 승률 ${(feedback.stats.winRate * 100).toFixed(1)}% / 손익 $${feedback.stats.totalPnl.toFixed(2)}`,
    `다음 액션: ${(feedback.nextActions || []).join(' / ') || '없음'}`,
  ].join('\n');
  await rag.initSchema();
  await rag.store('trades', content, {
    type: 'daily_trade_feedback',
    date: dateKst,
    total_trades: feedback.stats.total,
    win_rate: feedback.stats.winRate,
    total_pnl: feedback.stats.totalPnl,
    analyst_accuracy: analystAccuracy || {},
  }, 'luna');
}

async function runDailyTradeFeedback({ dateKst, dryRun = false }) {
  const trades = await fetchDailyTrades(dateKst);
  const analystAccuracy = await fetchDailyAnalystAccuracy(dateKst);
  const feedback = await buildDailyFeedback(dateKst, trades, analystAccuracy);
  const message = buildTelegramMessage(dateKst, feedback, analystAccuracy);

  try {
    await storeDailyFeedbackRag(dateKst, feedback, analystAccuracy);
  } catch (error) {
    console.warn(`  ⚠️ [daily-feedback] RAG 저장 실패(무시): ${error?.message || error}`);
  }

  if (!dryRun) {
    try {
      await publishToMainBot({
        from_bot: 'luna',
        event_type: 'daily_feedback',
        alert_level: 1,
        message,
        payload: { dateKst, feedback, analystAccuracy },
      });
    } catch (error) {
      console.warn(`  ⚠️ [daily-feedback] 메인봇 발행 실패(무시): ${error?.message || error}`);
    }
  }

  return {
    status: 'ok',
    date: dateKst,
    dryRun,
    tradeCount: trades.length,
    analystAccuracy,
    feedback,
    message,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const dateKst = parseArg('date', new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }));
      const dryRun = process.argv.includes('--dry-run');
      return runDailyTradeFeedback({ dateKst, dryRun });
    },
    onSuccess: async (result) => {
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
      }
    },
    errorPrefix: '❌ 일일 피드백 오류:',
  });
}

export {
  buildDailyFeedback,
  buildDailyStats,
  buildTelegramMessage,
  fetchDailyAnalystAccuracy,
  fetchDailyTrades,
  runDailyTradeFeedback,
};
