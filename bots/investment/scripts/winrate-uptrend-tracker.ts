#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/winrate-uptrend-tracker.ts — 수익 확률 우상향 추세 측정
 *
 * 매일 09:00 KST (가드 추적 이후)
 * launchd: ai.luna.winrate-tracker-daily-0900.plist
 *
 * 마스터 비전: "이길 확률을 계속 높이겠다!"
 *
 * 측정 지표:
 *   1. 일별 승률 + 손익비 (v_winrate_uptrend 뷰)
 *   2. 7일/30일 이동평균 승률
 *   3. 우상향 추세 여부 (MA7 > MA30)
 *   4. 7일 기울기 (trend_slope_7d)
 *   5. 체제별 가중치 학습 진행 (luna_regime_weight_snapshots)
 *   6. 텔레그램 마스터 보고
 */

import { query } from '../shared/db/core.ts';

const TODAY = new Date().toISOString().split('T')[0];
const ENABLED_ENV = 'LUNA_WINRATE_UPTREND_TRACKER_ENABLED';

function boolEnv(name, fallback = false, env = process.env) {
  const raw = String(env?.[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false;
  return fallback;
}

// ─── DB 조회 함수 ─────────────────────────────────────────────────────────────

async function fetchWinrateUptrend(days = 30) {
  const rows = await query(
    `SELECT
       trade_date,
       market,
       win_rate,
       profit_factor,
       profit_probability,
       win_rate_ma7,
       win_rate_ma30,
       profit_factor_ma7,
       trades_last7d,
       is_uptrend,
       trend_slope_7d,
       total_trades
     FROM investment.v_winrate_uptrend
     WHERE trade_date >= CURRENT_DATE - ($1 || ' days')::interval
     ORDER BY trade_date DESC, market`,
    [days],
  ).catch(() => []);
  return rows || [];
}

async function fetchLatestRegimeWeights() {
  const rows = await query(
    `SELECT DISTINCT ON (regime)
       regime,
       win_rate,
       profit_factor,
       total_trades,
       fusion_weights,
       created_at
     FROM investment.luna_regime_weight_snapshots
     ORDER BY regime, created_at DESC`,
    [],
  ).catch(() => []);
  return rows || [];
}

async function fetchTotalTrades() {
  const row = await query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE COALESCE(pnl, 0) > 0) AS wins,
       AVG(COALESCE(pnl_pct, 0)) AS avg_pnl_pct
     FROM investment.trade_journal
     WHERE exit_time IS NOT NULL
       AND NOT COALESCE(is_paper, false)
       AND to_timestamp(exit_time / 1000.0) >= CURRENT_DATE - INTERVAL '30 days'`,
    [],
  ).catch(() => [{}]);
  return row?.[0] || {};
}

// ─── 수익 확률 추세 분석 ──────────────────────────────────────────────────────

function analyzeUptrend(rows) {
  if (!rows.length) return { hasData: false };

  // 시장별 최신 데이터
  const byMarket = {};
  for (const row of rows) {
    const mkt = row.market || 'crypto';
    if (!byMarket[mkt]) byMarket[mkt] = [];
    byMarket[mkt].push(row);
  }

  const marketStats = {};
  for (const [market, mktRows] of Object.entries(byMarket)) {
    const sorted = mktRows.sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
    const latest = sorted[0];
    const last7 = sorted.slice(0, 7);

    // 7일 평균 승률
    const avg7WinRate = last7.length > 0
      ? last7.reduce((s, r) => s + Number(r.win_rate || 0), 0) / last7.length
      : 0;

    // 선형 회귀 기울기 (7일)
    const slopes = last7.map((r) => Number(r.trend_slope_7d || 0)).filter((v) => v !== 0);
    const avgSlope = slopes.length > 0 ? slopes.reduce((s, v) => s + v, 0) / slopes.length : 0;

    marketStats[market] = {
      latestDate: latest?.trade_date,
      winRate: Number(latest?.win_rate || 0),
      profitFactor: Number(latest?.profit_factor || 0),
      winRateMa7: Number(latest?.win_rate_ma7 || 0),
      winRateMa30: Number(latest?.win_rate_ma30 || 0),
      isUptrend: latest?.is_uptrend === true || latest?.is_uptrend === 't',
      trendSlope: Number(latest?.trend_slope_7d || avgSlope || 0),
      trades7d: Number(latest?.trades_last7d || 0),
      totalTrades: last7.reduce((s, r) => s + Number(r.total_trades || 0), 0),
    };
  }

  return { hasData: true, byMarket: marketStats };
}

// ─── 텔레그램 메시지 빌더 ────────────────────────────────────────────────────

function buildTelegramMessage(winrateData, regimeWeights, totalStats) {
  const { hasData, byMarket } = winrateData;

  let msg = `📈 *루나 수익 확률 우상향 추적 — ${TODAY}*\n\n`;

  if (!hasData || !byMarket || Object.keys(byMarket).length === 0) {
    msg += '⚠️ 데이터 없음 (거래 이력 부족)\n';
    msg += '_최소 3일 이상 실거래 데이터 필요_';
    return msg;
  }

  // 전체 30일 요약
  const total30 = Number(totalStats?.total || 0);
  const wins30 = Number(totalStats?.wins || 0);
  const winRate30 = total30 > 0 ? (wins30 / total30 * 100).toFixed(1) : '-';
  const avgPnl30 = Number(totalStats?.avg_pnl_pct || 0);

  msg += `*📊 30일 종합*\n`;
  msg += `  • 총 거래: ${total30}건 | 승률: ${winRate30}%\n`;
  msg += `  • 평균 손익률: ${(avgPnl30 * 100).toFixed(2)}%\n\n`;

  // 시장별 상세
  const marketEmojis = { crypto: '₿', domestic: '🇰🇷', overseas: '🌍' };
  for (const [market, stats] of Object.entries(byMarket)) {
    const emoji = marketEmojis[market] || '📊';
    const trendEmoji = stats.isUptrend ? '📈' : (stats.trendSlope > 0 ? '↗️' : '📉');
    const trendText = stats.isUptrend ? '우상향' : (stats.trendSlope > 0 ? '상승 중' : '하락');

    msg += `*${emoji} ${market.toUpperCase()}*\n`;
    msg += `  • 승률: ${(stats.winRate * 100).toFixed(1)}% (MA7: ${(stats.winRateMa7 * 100).toFixed(1)}% | MA30: ${(stats.winRateMa30 * 100).toFixed(1)}%)\n`;
    msg += `  • 손익비: ${stats.profitFactor.toFixed(2)}\n`;
    msg += `  • 7일 거래: ${stats.trades7d}건\n`;
    msg += `  • 추세: ${trendEmoji} ${trendText} (기울기: ${stats.trendSlope > 0 ? '+' : ''}${stats.trendSlope.toFixed(4)})\n\n`;
  }

  // 체제별 가중치 학습 요약
  if (regimeWeights.length > 0) {
    msg += `*🧠 체제별 가중치 학습 현황*\n`;
    for (const rw of regimeWeights) {
      const regime = String(rw.regime || '').replace('TRENDING_', '');
      const winPct = (Number(rw.win_rate || 0) * 100).toFixed(1);
      const pf = Number(rw.profit_factor || 0).toFixed(2);
      const trades = Number(rw.total_trades || 0);
      msg += `  • ${regime}: 승률=${winPct}% PF=${pf} (${trades}건)\n`;
    }
    msg += '\n';
  }

  msg += `_수집 → 분석 → 가중치 → 수익 확률 우상향 ♻️_`;
  return msg;
}

// ─── 텔레그램 전송 ────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  try {
    const hubUrl = process.env.HUB_URL || 'http://localhost:7788';
    const hubToken = process.env.HUB_AUTH_TOKEN;
    if (!hubToken) return;
    await fetch(`${hubUrl}/hub/notifications/telegram`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ message, source: 'winrate-uptrend-tracker', parseMode: 'Markdown' }),
    }).catch(() => null);
  } catch {
    // ignore
  }
}

// ─── 결과 콘솔 출력 ──────────────────────────────────────────────────────────

function printSummary(winrateData) {
  if (!winrateData.hasData) {
    console.log('[WinrateTracker] 데이터 없음');
    return;
  }
  for (const [market, stats] of Object.entries(winrateData.byMarket || {})) {
    const trendDir = stats.isUptrend ? '↑우상향' : (stats.trendSlope > 0 ? '↗상승' : '↓하락');
    console.log(`[WinrateTracker] ${market}: 승률=${(stats.winRate * 100).toFixed(1)}% MA7=${(stats.winRateMa7 * 100).toFixed(1)}% MA30=${(stats.winRateMa30 * 100).toFixed(1)}% ${trendDir}`);
  }
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const json = process.argv.includes('--json');
  const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || 30);
  const enabled = boolEnv(ENABLED_ENV, true);

  console.log(`[WinrateTracker] ${new Date().toISOString()} 수익 확률 추적 시작`);
  if (!enabled && !dryRun) {
    console.log(`[WinrateTracker] 비활성화 (${ENABLED_ENV}=false/미설정)`);
    if (json) console.log(JSON.stringify({ ok: true, skipped: true, reason: 'disabled', enabled, dryRun }, null, 2));
    process.exit(0);
  }
  if (!enabled && dryRun) {
    console.log(`[WinrateTracker] ${ENABLED_ENV}=false/미설정 — dry-run 검증만 수행`);
  }

  const [winrateRows, regimeWeights, totalStats] = await Promise.allSettled([
    fetchWinrateUptrend(days),
    fetchLatestRegimeWeights(),
    fetchTotalTrades(),
  ]);

  const rows = winrateRows.status === 'fulfilled' ? winrateRows.value : [];
  const weights = regimeWeights.status === 'fulfilled' ? regimeWeights.value : [];
  const total = totalStats.status === 'fulfilled' ? totalStats.value : {};

  const winrateData = analyzeUptrend(rows);
  const message = buildTelegramMessage(winrateData, weights, total);

  printSummary(winrateData);

  if (json) {
    console.log(JSON.stringify({ ok: true, enabled, dryRun, winrateData, regimeWeights: weights, totalStats: total }, null, 2));
  }

  if (!dryRun) {
    await sendTelegram(message);
  }

  console.log(`[WinrateTracker] 완료`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[WinrateTracker] 오류:`, err);
  process.exit(1);
});
