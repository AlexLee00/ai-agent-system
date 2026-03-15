/**
 * team/reporter.js — 루나팀 투자 리포트 (일일 성과 요약)
 *
 * 역할: DB + 바이낸스 실시간 가격으로 성과 리포트 생성
 * 실행: node team/reporter.js [--telegram] [--days=N]
 *
 * 출력 항목:
 *   - 운영 모드 현황
 *   - 바이낸스 실잔고 (USDT + 코인)
 *   - 모의 포지션 현황 + 미실현 수익률
 *   - 신호 통계 (정확도)
 *   - 이번달 신호 일별 추이
 *   - LLM 비용
 */

import ccxt            from 'ccxt';
import { fileURLToPath } from 'url';
import { createRequire }  from 'module';
import * as db          from '../shared/db.js';
import { loadSecrets, isPaperMode } from '../shared/secrets.js';
import { publishToMainBot } from '../shared/mainbot-client.js';
import { tracker }      from '../shared/cost-tracker.js';
import { buildAccuracyReport } from '../shared/analyst-accuracy.js';

const _require = createRequire(import.meta.url);
const shadow   = _require('../../../packages/core/lib/shadow-mode.js');
const pgPool   = _require('../../../packages/core/lib/pg-pool.js');
const kst      = _require('../../../packages/core/lib/kst');
const {
  publishEventPipeline,
  buildNoticeEvent,
  renderNoticeEvent,
  buildReportEvent,
  renderReportEvent,
} = _require('../../../packages/core/lib/reporting-hub.js');

// ─── 바이낸스 현재가 일괄 조회 ──────────────────────────────────────

async function fetchPrices(symbols) {
  const prices = {};
  try {
    const s = loadSecrets();
    const ex = new ccxt.binance({ enableRateLimit: true });
    for (const sym of symbols) {
      try {
        const ticker = await ex.fetchTicker(sym);
        prices[sym] = ticker.last;
      } catch { prices[sym] = null; }
    }
  } catch { /* 가격 조회 실패 시 null */ }
  return prices;
}

function summarizeTradesByModeAndExchange(trades = []) {
  const inferExchange = (trade) => {
    if (trade.exchange) return trade.exchange;
    if (String(trade.symbol || '').includes('/')) return 'binance';
    if (/^\d{6}$/.test(String(trade.symbol || ''))) return 'kis';
    return 'kis_overseas';
  };
  const buckets = {};
  for (const trade of trades) {
    const mode = trade.paper ? 'paper' : 'live';
    const exchange = inferExchange(trade);
    const key = `${mode}:${exchange}`;
    if (!buckets[key]) {
      buckets[key] = { mode, exchange, count: 0, gross: 0 };
    }
    buckets[key].count += 1;
    buckets[key].gross += Number(trade.total_usdt || 0);
  }
  return Object.values(buckets).sort((a, b) => a.mode.localeCompare(b.mode) || a.exchange.localeCompare(b.exchange));
}

function summarizePositionsByModeAndExchange(positions = [], prices = {}) {
  const buckets = {};
  for (const pos of positions) {
    const mode = pos.paper ? 'paper' : 'live';
    const exchange = pos.exchange || 'unknown';
    const key = `${mode}:${exchange}`;
    if (!buckets[key]) {
      buckets[key] = { mode, exchange, positions: 0, costBasis: 0, marketValue: 0, unrealized: 0 };
    }
    const currentPrice = prices[pos.symbol] || pos.avg_price || 0;
    const costBasis = Number(pos.amount || 0) * Number(pos.avg_price || 0);
    const marketValue = Number(pos.amount || 0) * Number(currentPrice || 0);
    buckets[key].positions += 1;
    buckets[key].costBasis += costBasis;
    buckets[key].marketValue += marketValue;
    buckets[key].unrealized += marketValue - costBasis;
  }
  return Object.values(buckets).sort((a, b) => a.mode.localeCompare(b.mode) || a.exchange.localeCompare(b.exchange));
}

// ─── 바이낸스 실잔고 조회 ───────────────────────────────────────────

async function fetchBinanceBalance() {
  try {
    const s  = loadSecrets();
    const ex = new ccxt.binance({
      apiKey: s.binance_api_key,
      secret: s.binance_api_secret,
      enableRateLimit: true,
    });
    const bal = await ex.fetchBalance();
    const nonZero = Object.entries(bal.total || {})
      .filter(([, v]) => v > 0)
      .map(([coin, total]) => ({ coin, free: bal.free?.[coin] || 0, total }));
    return nonZero;
  } catch (e) {
    console.warn(`  ⚠️ 바이낸스 잔고 조회 실패: ${e.message}`);
    return [];
  }
}

// ─── 날짜 헬퍼 ──────────────────────────────────────────────────────

function kstStr() {
  return kst.datetimeStr() + ' KST';
}

function buildSection(title, lines) {
  return {
    title,
    lines: (lines || []).filter(Boolean),
  };
}

// ─── 리포트 생성 ─────────────────────────────────────────────────────

export async function generateReport({ days = 30, telegram = false } = {}) {
  await db.initSchema();

  const today = kst.today();

  // ── 1. 신호 통계 ───────────────────────────────────────────────────
  const sigStats = await db.query(`
    SELECT
      status,
      COUNT(*)::INTEGER  AS cnt,
      ROUND(AVG(confidence)::numeric * 100, 1) AS avg_conf
    FROM signals
    WHERE created_at > now() - INTERVAL '${days} days'
    GROUP BY status
    ORDER BY cnt DESC
  `);

  const sigTotal    = sigStats.reduce((s, r) => s + r.cnt, 0);
  const sigExec     = sigStats.find(r => r.status === 'executed')?.cnt  || 0;
  const sigApproved = sigStats.find(r => r.status === 'approved')?.cnt  || 0;
  const sigFailed   = sigStats.find(r => r.status === 'failed')?.cnt    || 0;
  const sigHold     = sigStats.find(r => r.status === 'hold')?.cnt      || 0;

  // ── 2. 심볼별 신호 분포 ────────────────────────────────────────────
  const symStats = await db.query(`
    SELECT
      symbol,
      action,
      COUNT(*)::INTEGER AS cnt
    FROM signals
    WHERE created_at > now() - INTERVAL '${days} days'
    GROUP BY symbol, action
    ORDER BY symbol, action
  `);

  // ── 3. 포지션 + 현재가 ─────────────────────────────────────────────
  const positions = await db.getAllPositions();
  const posPrices = positions.length > 0
    ? await fetchPrices(positions.map(p => p.symbol))
    : {};

  let totalUnrealizedPnl  = 0;
  let totalCostBasis      = 0;
  const posLines = [];

  for (const p of positions) {
    const currentPrice = posPrices[p.symbol];
    const costBasis    = p.amount * p.avg_price;
    totalCostBasis    += costBasis;

    if (currentPrice) {
      const value     = p.amount * currentPrice;
      const pnl       = value - costBasis;
      const pnlPct    = (pnl / costBasis * 100);
      totalUnrealizedPnl += pnl;
      const pnlSign   = pnl >= 0 ? '+' : '';
      posLines.push(
        `  ${p.symbol}: ${p.amount.toFixed(6)}개\n` +
        `    매수가 $${p.avg_price.toLocaleString()} → 현재가 $${currentPrice.toLocaleString()}\n` +
        `    평가금액 $${value.toFixed(2)} | 수익 ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)`
      );
    } else {
      posLines.push(
        `  ${p.symbol}: ${p.amount.toFixed(6)}개 @ $${p.avg_price.toLocaleString()} (현재가 조회 실패)`
      );
    }
  }

  // ── 4. 바이낸스 실잔고 ─────────────────────────────────────────────
  const balances = await fetchBinanceBalance();
  const usdtBal  = balances.find(b => b.coin === 'USDT');

  // LU-002: 실잔고 기반 equity 계산 (USDT free + 보유 코인 현재가 환산)
  const nonUsdtHoldings = balances.filter(b => b.coin !== 'USDT' && b.total > 0);
  const realCoinPrices  = nonUsdtHoldings.length > 0
    ? await fetchPrices(nonUsdtHoldings.map(b => `${b.coin}/USDT`))
    : {};
  const coinUsdValue = nonUsdtHoldings.reduce((s, b) => {
    const p = realCoinPrices[`${b.coin}/USDT`];
    return p ? s + b.total * p : s;
  }, 0);
  const equity = (usdtBal?.free || 0) + coinUsdValue;

  // 스냅샷 저장 후 히스토리 조회 (오늘 포함)
  try { await db.insertAssetSnapshot(equity, usdtBal?.free || 0); } catch {}
  const equityHistory = await db.getEquityHistory(7);

  // ── 5. LLM 비용 ────────────────────────────────────────────────────
  const cost = tracker.getToday();

  // ── 6. 거래 내역 요약 ──────────────────────────────────────────────
  const trades = await db.query(`
    SELECT
      symbol, side, amount, price, total_usdt, paper, executed_at
    FROM trades
    WHERE executed_at > now() - INTERVAL '${days} days'
    ORDER BY executed_at DESC
  `);

  const pnl = await db.getTodayPnl();
  const tradeBreakdown = summarizeTradesByModeAndExchange(trades);
  const positionBreakdown = summarizePositionsByModeAndExchange(positions, posPrices);

  // ── 7. 분석팀 정확도 ────────────────────────────────────────────────
  let accuracyReport = null;
  try {
    accuracyReport = await buildAccuracyReport();
  } catch (e) {
    console.warn(`  ⚠️ 분석팀 정확도 조회 실패: ${e.message}`);
  }

  // ─── 리포트 조립 ──────────────────────────────────────────────────
  const paperMode = isPaperMode();
  const modeTag   = paperMode ? '📄 PAPER' : '🔴 LIVE';

  const lines = [
    `📊 *루나팀 투자 리포트*`,
    `기준: ${kstStr()} | 최근 ${days}일`,
    ``,
    `━━━ 운영 모드 ━━━`,
    `  암호화폐: 🔴 LIVE (PAPER_MODE=false)`,
    `  국내주식:  📄 PAPER (모의투자)`,
    `  미국주식:  📄 PAPER (모의투자)`,
    ``,
  ];

  // 바이낸스 잔고
  lines.push(`━━━ 바이낸스 실잔고 ━━━`);
  if (balances.length === 0) {
    lines.push(`  조회 실패`);
  } else {
    for (const b of balances) {
      lines.push(`  ${b.coin}: ${b.total.toFixed(6)} (가용 ${b.free.toFixed(6)})`);
    }
    lines.push(`  USDT 가용: $${(usdtBal?.free || 0).toFixed(2)}`);
    lines.push(`  총 자산(추정): $${equity.toFixed(2)}`);
  }
  lines.push(``);

  // 자산 추이 (스냅샷 2개 이상일 때)
  if (equityHistory.length >= 2) {
    lines.push(`━━━ 자산 추이 ━━━`);
    for (const snap of equityHistory.slice(-5)) {
      const dt = new Date(snap.snapped_at).toLocaleDateString('ko-KR', {
        timeZone: 'Asia/Seoul', month: 'short', day: 'numeric',
      });
      lines.push(`  ${dt}: $${Number(snap.equity).toFixed(2)}`);
    }
    const oldest = Number(equityHistory[0].equity);
    const latest  = Number(equityHistory[equityHistory.length - 1].equity);
    const change  = latest - oldest;
    const pct     = oldest > 0 ? (change / oldest * 100).toFixed(1) : '0.0';
    const sign    = change >= 0 ? '+' : '';
    lines.push(`  기간 변화: ${sign}$${change.toFixed(2)} (${sign}${pct}%)`);
    lines.push(``);
  }

  // 모의 포지션
  lines.push(`━━━ 모의 포지션 현황 ━━━`);
  if (posLines.length === 0) {
    lines.push(`  포지션 없음`);
  } else {
    lines.push(...posLines);
    const pnlSign = totalUnrealizedPnl >= 0 ? '+' : '';
    const roiPct  = totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis * 100) : 0;
    lines.push(`  ─`);
    lines.push(`  총 매수원가: $${totalCostBasis.toFixed(2)}`);
    lines.push(`  미실현 PnL: ${pnlSign}$${totalUnrealizedPnl.toFixed(2)} (${pnlSign}${roiPct.toFixed(2)}%)`);
  }
  lines.push(``);

  // 신호 통계
  lines.push(`━━━ 신호 통계 (최근 ${days}일) ━━━`);
  lines.push(`  총 신호: ${sigTotal}개`);
  lines.push(`  실행(모의): ${sigExec}개 | 승인대기: ${sigApproved}개 | 잔고부족실패: ${sigFailed}개`);
  if (sigTotal > 0) {
    const execRate = ((sigExec / sigTotal) * 100).toFixed(1);
    lines.push(`  실행률: ${execRate}%`);
  }

  if (symStats.length > 0) {
    lines.push(`  심볼별:`);
    const grouped = {};
    for (const r of symStats) {
      if (!grouped[r.symbol]) grouped[r.symbol] = {};
      grouped[r.symbol][r.action] = r.cnt;
    }
    for (const [sym, actions] of Object.entries(grouped)) {
      const parts = Object.entries(actions).map(([a, c]) => `${a} ${c}`).join(' / ');
      lines.push(`    ${sym}: ${parts}`);
    }
  }
  lines.push(``);

  // 거래 내역
  lines.push(`━━━ 최근 거래 내역 ━━━`);
  if (trades.length === 0) {
    lines.push(`  거래 없음`);
  } else {
    for (const t of trades) {
      const dtStr = kst.toKST(new Date(t.executed_at));
      const paper = t.paper ? '📄' : '🔴';
      lines.push(`  ${paper} ${dtStr} | ${t.symbol} ${t.side.toUpperCase()} ${t.amount?.toFixed(6)}개 @ $${t.price?.toLocaleString()} (≈$${t.total_usdt?.toFixed(0)})`);
    }
  }
  lines.push(``);

  lines.push(`━━━ 실거래/모의거래 분리 ━━━`);
  if (tradeBreakdown.length === 0) {
    lines.push(`  거래 없음`);
  } else {
    for (const row of tradeBreakdown) {
      const modeLabel = row.mode === 'live' ? '실거래' : '모의거래';
      lines.push(`  ${modeLabel} [${row.exchange}]: ${row.count}건 | 총 거래금액 $${row.gross.toFixed(2)}`);
    }
  }
  if (positionBreakdown.length > 0) {
    lines.push(`  포지션:`);
    for (const row of positionBreakdown) {
      const modeLabel = row.mode === 'live' ? '실거래' : '모의거래';
      const pnlSign = row.unrealized >= 0 ? '+' : '';
      lines.push(`    ${modeLabel} [${row.exchange}]: ${row.positions}개 | 평가 $${row.marketValue.toFixed(2)} | 미실현 ${pnlSign}$${row.unrealized.toFixed(2)}`);
    }
  }
  lines.push(``);

  // LLM 비용
  lines.push(`━━━ LLM 비용 ━━━`);
  lines.push(`  오늘: $${cost.usage.toFixed(4)} / $${cost.dailyBudget.toFixed(2)}`);
  lines.push(`  이번달: $${cost.monthUsage.toFixed(4)} / $${cost.monthlyBudget.toFixed(2)}`);
  lines.push(`  (Groq 무료 — 실비용 $0)`);

  // 분석팀 정확도
  if (accuracyReport) {
    lines.push(``);
    lines.push(accuracyReport.text);
  }

  const report = lines.join('\n');
  console.log('\n' + report);

  // 가중치 조정 알림 (텔레그램, 조정 제안 있을 시)
  if (telegram && accuracyReport) {
    const needsAlert = accuracyReport.adjustments.some(
      a => (a.action !== 'maintain' && a.action !== 'insufficient_data') || a.needsReview
    );
    if (needsAlert) {
      const detailLines = [];
      for (const adj of accuracyReport.adjustments) {
        if (adj.action !== 'maintain' && adj.action !== 'insufficient_data') {
          detailLines.push(`${adj.botName}: ${adj.currentWeight} → ${adj.suggestedWeight} (${adj.reason})`);
        }
        if (adj.needsReview) {
          detailLines.push(`검토 필요: ${adj.botName} 3주 연속 50% 미만`);
        }
      }
      await publishEventPipeline({
        event: {
          from_bot: 'luna',
          team: 'investment',
          event_type: 'accuracy_alert',
          alert_level: 2,
          message: renderNoticeEvent(buildNoticeEvent({
            from_bot: 'luna',
            team: 'investment',
            event_type: 'accuracy_alert',
            alert_level: 2,
            title: '분석팀 가중치 조정 제안',
            summary: '최근 정확도 기준으로 검토가 필요한 변경안이 있습니다',
            details: detailLines,
            action: '자동 변경 없이 마스터 승인 후 반영',
          })),
        },
        targets: [
          { type: 'queue', pgPool, schema: 'claude' },
        ],
      });
      console.log('\n📊 가중치 조정 알림 발송 완료');
    }
  }

  if (telegram) {
    const reportMessage = renderReportEvent(buildReportEvent({
      from_bot: 'luna',
      team: 'investment',
      event_type: 'report',
      alert_level: 1,
      title: '📊 루나팀 투자 리포트',
      summary: `기준: ${kstStr()} | 최근 ${days}일`,
      sections: [
        buildSection('━━━ 운영 모드 ━━━', [
          '암호화폐: 🔴 LIVE (PAPER_MODE=false)',
          '국내주식: 📄 PAPER (모의투자)',
          '미국주식: 📄 PAPER (모의투자)',
        ]),
        buildSection('━━━ 실거래/모의거래 분리 ━━━', tradeBreakdown.length === 0
          ? ['거래 없음']
          : tradeBreakdown.map((row) => {
              const modeLabel = row.mode === 'live' ? '실거래' : '모의거래';
              return `${modeLabel} [${row.exchange}]: ${row.count}건 | 총 거래금액 $${row.gross.toFixed(2)}`;
            })),
        buildSection('━━━ 자산/비용 요약 ━━━', [
          `USDT 가용: $${(usdtBal?.free || 0).toFixed(2)}`,
          `총 자산(추정): $${equity.toFixed(2)}`,
          `오늘 LLM 비용: $${cost.usage.toFixed(4)} / $${cost.dailyBudget.toFixed(2)}`,
          `이번달 LLM 비용: $${cost.monthUsage.toFixed(4)} / $${cost.monthlyBudget.toFixed(2)}`,
        ]),
        buildSection(`━━━ 신호 통계 (최근 ${days}일) ━━━`, [
          `총 신호: ${sigTotal}개`,
          `실행(모의): ${sigExec}개 | 승인대기: ${sigApproved}개 | 잔고부족실패: ${sigFailed}개`,
          ...(sigTotal > 0 ? [`실행률: ${((sigExec / sigTotal) * 100).toFixed(1)}%`] : []),
        ]),
      ],
      footer: '상세 원문은 콘솔 출력 리포트를 참고하세요.',
    }));
    await publishEventPipeline({
      event: {
        from_bot: 'luna',
        team: 'investment',
        event_type: 'report',
        alert_level: 1,
        message: reportMessage,
      },
      targets: [
        { type: 'queue', pgPool, schema: 'claude' },
      ],
    });
    console.log('\n📱 제이 큐 발송 완료');
  }

  // 4주차 안정화 지표 (콘솔 로그)
  const week4Summary = await buildWeek4Summary();
  console.log('\n' + week4Summary);

  return report;
}

// ─── 4주차 종합 안정화 지표 ──────────────────────────────────────────

export async function buildWeek4Summary() {
  const lines = [
    `📊 4주차 안정화 지표`,
    `════════════════════════`,
  ];

  // 1. Shadow 일치율 (7일)
  try {
    const [lunaStats, skaStats, claudeStats] = await Promise.all([
      shadow.getMatchRate('luna',       null, 7),
      shadow.getMatchRate('ska',        null, 7),
      shadow.getMatchRate('claude-lead', null, 7),
    ]);
    lines.push(`━━ Shadow 일치율 (7일) ━━`);
    const fmtRate = (s) => s.total > 0 ? `${s.matchRate}% (${s.total}건)` : '데이터 없음';
    lines.push(`  루나:   ${fmtRate(lunaStats)}`);
    lines.push(`  스카:   ${fmtRate(skaStats)}`);
    lines.push(`  클로드: ${fmtRate(claudeStats)}`);
  } catch (e) {
    lines.push(`━━ Shadow 일치율 ━━\n  조회 실패: ${e.message}`);
  }
  lines.push(``);

  // 2. LLM 비용
  const cost = tracker.getToday();
  lines.push(`━━ LLM 비용 ━━`);
  lines.push(`  오늘: $${cost.usage.toFixed(4)} (Groq: $0.00)`);
  lines.push(`  이번달: $${cost.monthUsage.toFixed(4)} / $${cost.monthlyBudget.toFixed(2)}`);
  lines.push(``);

  // 3. LLM 졸업 후보 (claude.graduation_candidates)
  try {
    const candidates = await pgPool.query('claude', `
      SELECT team, context, predicted_decision, sample_count, match_rate
      FROM graduation_candidates
      WHERE status = 'candidate'
      ORDER BY match_rate DESC
      LIMIT 5
    `, []);
    lines.push(`━━ LLM 졸업 후보 ━━`);
    if (candidates.length === 0) {
      lines.push(`  없음 (90%+ 일치 패턴 미도달)`);
    } else {
      for (const c of candidates) {
        lines.push(`  [${c.team}] ${c.context} → ${c.predicted_decision}: ${(Number(c.match_rate) * 100).toFixed(1)}% (n=${c.sample_count})`);
      }
    }
  } catch (e) {
    lines.push(`━━ LLM 졸업 후보 ━━\n  조회 실패: ${e.message}`);
  }

  return lines.join('\n');
}

// ─── CLI 실행 ───────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args     = process.argv.slice(2);
  const telegram = args.includes('--telegram');
  const daysArg  = args.find(a => a.startsWith('--days='));
  const days     = daysArg ? parseInt(daysArg.split('=')[1]) : 30;

  await generateReport({ days, telegram });
  process.exit(0);
}
