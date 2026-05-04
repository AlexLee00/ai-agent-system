// @ts-nocheck
/**
 * shared/luna-constitution.ts
 *
 * Luna posttrade Phase F — constitution rules as executable policy.
 * The markdown file remains the human-readable source; this module turns the
 * high-risk rules into deterministic guards and audit metadata.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONSTITUTION_PATH = path.resolve(__dirname, '..', 'team', 'luna.constitution.md');

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMarket(market) {
  const raw = String(market || '').trim().toLowerCase();
  if (raw === 'kis') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  if (raw === 'binance') return 'crypto';
  if (['domestic', 'overseas', 'crypto'].includes(raw)) return raw;
  return raw || 'unknown';
}

function readConstitution(pathname = DEFAULT_CONSTITUTION_PATH) {
  try {
    return fs.readFileSync(pathname, 'utf8');
  } catch {
    return '';
  }
}

export function loadLunaConstitution(pathname = process.env.LUNA_CONSTITUTION_PATH || DEFAULT_CONSTITUTION_PATH) {
  const content = readConstitution(pathname);
  const ruleLines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line) || /^-\s+/.test(line));
  return {
    ok: content.trim().length > 0,
    path: pathname,
    content,
    ruleCount: ruleLines.length,
    ruleLines,
  };
}

export function evaluateLunaConstitutionForEntry(candidate = {}, context = {}) {
  const market = normalizeMarket(candidate.market || context.market || candidate.exchange || context.exchange);
  const confidence = finiteNumber(candidate.confidence, 0);
  const analystAgreement = finiteNumber(
    candidate.analystAgreement
      ?? candidate.analyst_agreement
      ?? candidate.block_meta?.analystAgreement
      ?? candidate.block_meta?.analyst_agreement
      ?? context.analystAgreement
      ?? context.analyst_agreement,
    NaN,
  );
  const nemesisRisk = String(
    candidate.nemesisRiskLevel
      ?? candidate.nemesis_risk_level
      ?? candidate.block_meta?.nemesisRiskLevel
      ?? candidate.block_meta?.nemesis_risk_level
      ?? context.nemesisRiskLevel
      ?? context.nemesis_risk_level
      ?? '',
  ).trim().toUpperCase();
  const backtestWinRate = finiteNumber(
    candidate.backtestWinRate
      ?? candidate.backtest_win_rate
      ?? candidate.block_meta?.backtestWinRate
      ?? candidate.block_meta?.backtest_win_rate
      ?? context.backtestWinRate
      ?? context.backtest_win_rate,
    NaN,
  );
  const dailyLossPct = Math.abs(finiteNumber(
    candidate.dailyLossPct
      ?? candidate.daily_loss_pct
      ?? candidate.block_meta?.dailyLossPct
      ?? candidate.block_meta?.daily_loss_pct
      ?? context.dailyLossPct
      ?? context.daily_loss_pct,
    0,
  ));
  const tpSlSet = candidate.tp_sl_set === true
    || candidate.block_meta?.tp_sl_set === true
    || candidate.block_meta?.tpSlSet === true
    || candidate.stop_loss != null
    || candidate.stopLoss != null
    || candidate.take_profit != null
    || candidate.takeProfit != null;
  const isNewPattern = candidate.newPattern === true
    || candidate.new_pattern === true
    || candidate.block_meta?.newPattern === true
    || context.newPattern === true
    || context.new_pattern === true;
  const now = context.now ? new Date(context.now) : new Date();
  const kstHour = Number.isFinite(now.getTime())
    ? Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(now).replace(':', '.'))
    : 0;

  // ── 추가 컨텍스트 추출 ────────────────────────────────────
  const regime = String(
    candidate.market_regime
      ?? candidate.marketRegime
      ?? candidate.block_meta?.market_regime
      ?? context.market_regime
      ?? context.regime
      ?? '',
  ).trim().toLowerCase();

  const violations = [];
  if (Number.isFinite(analystAgreement) && analystAgreement < 3) {
    violations.push({ code: 'multi_signal_agreement_missing', severity: 'hard', detail: `analystAgreement=${analystAgreement}` });
  }
  if (nemesisRisk === 'CRITICAL') {
    violations.push({ code: 'nemesis_critical_veto', severity: 'hard', detail: 'nemesis risk level is CRITICAL' });
  }
  if (isNewPattern && Number.isFinite(backtestWinRate) && backtestWinRate < 0.5) {
    violations.push({ code: 'new_pattern_backtest_weak', severity: 'hard', detail: `backtestWinRate=${backtestWinRate}` });
  }
  if (dailyLossPct > 0.02) {
    violations.push({ code: 'daily_loss_limit_exceeded', severity: 'hard', detail: `dailyLossPct=${dailyLossPct}` });
  }
  // 보강 1: TP/SL 전수 강제 — BUY 신호는 모두 SL 계획 필요 (활성 포지션 한정 해제)
  if (candidate.action === 'BUY' && !tpSlSet) {
    violations.push({ code: 'tp_sl_required_for_all_entries', severity: 'hard', detail: 'BUY entry missing tp/sl plan (tp_sl_set=false)' });
  }
  if (confidence < 0.5) {
    violations.push({ code: 'confidence_below_constitution_minimum', severity: 'hard', detail: `confidence=${confidence}` });
  }
  // 보강 2: trending_bull regime 진입 기준 강화 — FOMO 방지
  // 분석: trending_bull 219건 / 승률 20.5% (과잉 진입 의심)
  if (candidate.action === 'BUY' && regime === 'trending_bull' && confidence < 0.65) {
    violations.push({ code: 'trending_bull_confidence_gate', severity: 'hard', detail: `trending_bull requires confidence>=0.65, got ${confidence}` });
  }
  if (market === 'domestic' && candidate.action === 'BUY' && kstHour >= 15.20) {
    violations.push({ code: 'domestic_closing_auction_buy_block', severity: 'hard', detail: `kst=${kstHour}` });
  }
  // 보강 7: domestic trending_bear 진입 차단 — 손실 Top 10 모두 국내 trending_bear
  if (market === 'domestic' && candidate.action === 'BUY' && regime === 'trending_bear') {
    violations.push({ code: 'domestic_trending_bear_entry_block', severity: 'hard', detail: 'domestic BUY blocked in trending_bear regime (data: 28건 손실)' });
  }

  return {
    ok: violations.length === 0,
    blocked: violations.some((item) => item.severity === 'hard'),
    violationCount: violations.length,
    violations,
  };
}

export function evaluateLunaConstitutionForTrade({ trade = {}, reviewData = {}, backtestData = {} } = {}) {
  const violations = [];
  const constitutionFromReview = finiteNumber(reviewData?.constitution_violations, 0);
  if (constitutionFromReview > 0) {
    violations.push({ code: 'review_recorded_constitution_violation', count: Math.round(constitutionFromReview) });
  }
  const arr = backtestData?.constitution_violations;
  if (Array.isArray(arr)) {
    for (const item of arr) {
      violations.push({
        code: String(item?.code || item || 'backtest_constitution_violation'),
        source: 'backtest',
      });
    }
  }
  const pnlPct = finiteNumber(trade?.pnl_percent ?? trade?.pnlPercent, NaN);
  if (Number.isFinite(pnlPct) && pnlPct <= -3) {
    violations.push({ code: 'single_trade_loss_over_3pct', source: 'trade', pnlPct });
  }
  return {
    ok: violations.length === 0,
    violationCount: violations.reduce((sum, item) => sum + Math.max(1, Number(item.count || 1)), 0),
    violations,
  };
}

