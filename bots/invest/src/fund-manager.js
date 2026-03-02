'use strict';

/**
 * src/fund-manager.js — 루나 펀드매니저 (LU-030)
 *
 * claude-haiku-4-5 기반 포트폴리오 레벨 최종 투자 판단
 *
 * 흐름:
 *  1. signal-aggregator → 심볼별 신호 생성 (haiku, 기존)
 *  2. fund-manager → 포지션 + 잔고 + 신호 종합 → 최종 판단 (haiku)
 *  3. 승인된 신호 → binance-executor / kis-executor 실행
 *
 * 실행: node src/fund-manager.js [--dry-run] [--skip-pipeline]
 */

const https = require('https');
const { logUsage } = require('../lib/api-usage');
const db = require('../lib/db');
const binance = require('../lib/binance');
const { loadSecrets, isDryRun, getSymbols, getKisSymbols, hasKisApiKey } = require('../lib/secrets');
const { notifyTrade, notifyError, sendTelegram } = require('../lib/telegram');
const { executeSignal } = require('./binance-executor');
const { guardRealOrder, printModeBanner, getMode } = require('../lib/mode');
const { ACTIONS } = require('../lib/signal');

const MODEL        = 'claude-haiku-4-5-20251001';
const MIN_CONF     = 0.6;  // 펀드매니저 최소 확신도 (signal-aggregator의 0.5보다 엄격)
const MAX_POSITION = 0.20; // 단일 포지션 최대 20%
const MAX_POS_COUNT = 5;   // 최대 동시 포지션 수

// ─── 시스템 프롬프트 ────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 루나팀의 수석 펀드매니저(Fund Manager)입니다.
여러 전문 분석가(TA·온체인·뉴스·감성)와 강세/약세 리서처의 토론 결과를 종합하여
포트폴리오 레벨에서 최적의 투자 결정을 내립니다.

판단 원칙:
- 개별 신호가 아닌 포트폴리오 전체 리스크를 고려합니다
- 여러 심볼이 동시에 BUY 신호면 확신도 순으로 선별합니다
- 이미 보유 중인 포지션의 미실현 손익도 반영합니다
- USDT 잔고 내에서만 매수를 허용합니다
- 강세/약세 리서처 토론이 있으면 반드시 균형 있게 검토합니다

응답: JSON만 (마크다운 코드블록 없음):
{
  "decisions": [
    {
      "symbol": "BTC/USDT",
      "action": "BUY"|"SELL"|"HOLD",
      "amount_usdt": 100,
      "confidence": 0.75,
      "reasoning": "판단 근거 (한국어 1~2문장, 60자 이내)"
    }
  ],
  "portfolio_view": "포트폴리오 전체 시황 평가 (한국어 1~2문장, 80자 이내)",
  "risk_level": "LOW"|"MEDIUM"|"HIGH"
}

리스크 제약:
- 단일 포지션: 총자산 20% 이하
- 동시 포지션: 최대 5개
- 일손실 한도: 5%
- confidence 0.6 미만: 반드시 HOLD
- USDT 잔고 초과 매수 금지
- 단일 주문 최대 금액: $1000 (리스크 매니저 하드 규칙, 초과 시 자동 거부)
- 단일 주문 최소 금액: $10`;

// ─── Haiku API 호출 ────────────────────────────────────────────────

function callHaikuAPI(userMessage) {
  const secrets = loadSecrets();
  const apiKey  = secrets.anthropic_api_key || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ API 키 없음 — 펀드매니저 스킵');
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model:       MODEL,
      max_tokens:  2048,
      temperature: 0.1,
      system:      SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userMessage }],
    }));

    const start = Date.now();
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        try {
          const parsed = JSON.parse(raw);
          const usage  = parsed.usage || {};
          logUsage({
            provider:         'anthropic',
            model:            MODEL,
            promptTokens:     usage.input_tokens  || 0,
            completionTokens: usage.output_tokens || 0,
            latencyMs,
            caller:           'fund-manager',
            success:          !!parsed.content?.[0]?.text,
          });
          resolve(parsed.content?.[0]?.text || null);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Haiku API 타임아웃')); });
    req.write(body);
    req.end();
  });
}

// ─── 포트폴리오 컨텍스트 빌드 ──────────────────────────────────────

async function buildPortfolioContext() {
  // 잔고
  let usdtFree = 0;
  let balanceLines = [];
  try {
    const bal = await binance.fetchBalance();
    usdtFree = bal.USDT?.free || 0;
    balanceLines.push(`USDT 가용 잔고: $${usdtFree.toFixed(2)}`);
    for (const [sym, info] of Object.entries(bal)) {
      if (sym === 'USDT' || !info?.free || info.free < 0.0001) continue;
      balanceLines.push(`${sym}: ${info.free.toFixed(6)}`);
    }
  } catch (e) {
    balanceLines.push(`잔고 조회 실패: ${e.message}`);
  }

  // 현재 포지션
  const positions = await db.getAllPositions();
  const posLines  = positions.length === 0
    ? ['보유 포지션 없음']
    : positions.map(p => {
        const pnlStr = p.unrealized_pnl >= 0
          ? `+$${p.unrealized_pnl.toFixed(2)}`
          : `-$${Math.abs(p.unrealized_pnl).toFixed(2)}`;
        return `${p.symbol}: ${p.amount.toFixed(5)} @ $${p.avg_price.toFixed(2)} avg (미실현 ${pnlStr}) [${p.exchange}]`;
      });

  // 오늘 손익
  const todayPnl = await db.getTodayPnl();

  // 총자산 추정 (USDT + 포지션 평가액)
  const posValue  = positions.reduce((s, p) => s + (p.amount * p.avg_price), 0);
  const totalAsset = usdtFree + posValue;

  return {
    usdtFree,
    totalAsset,
    positionCount: positions.length,
    context: [
      '=== 포트폴리오 현황 ===',
      ...balanceLines,
      '',
      '=== 현재 포지션 ===',
      ...posLines,
      '',
      `오늘 거래: ${todayPnl.trade_count}건 | 오늘 P&L: ${(todayPnl.pnl || 0) >= 0 ? '+' : ''}$${(todayPnl.pnl || 0).toFixed(2)}`,
      `총 자산 추정: $${totalAsset.toFixed(2)} (포지션 ${positions.length}/${MAX_POS_COUNT}개)`,
    ].join('\n'),
  };
}

// ─── 최근 신호 조회 ─────────────────────────────────────────────────

async function getRecentSignals(minutesBack = 30) {
  return db.query(
    `SELECT s.*, a.reasoning as analysis_summary
     FROM signals s
     LEFT JOIN (
       SELECT symbol, STRING_AGG(reasoning, ' | ' ORDER BY created_at DESC) as reasoning
       FROM analysis
       WHERE created_at > now() - INTERVAL '${minutesBack} minutes'
       GROUP BY symbol
     ) a ON s.symbol = a.symbol
     WHERE s.status = 'pending'
       AND s.created_at > now() - INTERVAL '${minutesBack} minutes'
     ORDER BY s.confidence DESC`
  );
}

// ─── 최종 판단 → sonnet ─────────────────────────────────────────────

async function getFundManagerDecision(signals, portfolio) {
  if (signals.length === 0) {
    return { decisions: [], portfolio_view: '처리할 신호 없음', risk_level: 'LOW' };
  }

  const signalLines = signals.map(s =>
    `[${s.exchange?.toUpperCase() || 'BNB'}] ${s.symbol} → ${s.action} | 확신도 ${((s.confidence || 0) * 100).toFixed(0)}% | ${s.reasoning}`
  ).join('\n');

  const userMsg = [
    portfolio.context,
    '',
    '=== 분석가 신호 목록 ===',
    signalLines,
    '',
    '위 신호들을 포트폴리오 맥락에서 검토하여 최종 투자 결정을 내려주세요.',
    `가용 USDT: $${portfolio.usdtFree.toFixed(2)} / 총자산: $${portfolio.totalAsset.toFixed(2)}`,
  ].join('\n');

  const raw = await callHaikuAPI(userMsg);
  if (!raw) return null;

  try {
    const cleaned = raw.replace(/```json?\n?|\n?```/g, '').trim();
    const s = cleaned.indexOf('{'), e2 = cleaned.lastIndexOf('}');
    return JSON.parse(s >= 0 && e2 > s ? cleaned.slice(s, e2 + 1) : cleaned);
  } catch (e) {
    console.error('⚠️ Haiku 응답 파싱 실패:', raw.slice(0, 200));
    return null;
  }
}

// ─── 신호 실행 ──────────────────────────────────────────────────────

async function executeDecisions(decisions, portfolio, dryRun) {
  const results = [];

  for (const dec of decisions) {
    if (dec.action === ACTIONS.HOLD) {
      console.log(`  ⏸️ HOLD: ${dec.symbol}`);
      continue;
    }
    if ((dec.confidence || 0) < MIN_CONF) {
      console.log(`  ⏸️ 확신도 미달(${((dec.confidence || 0) * 100).toFixed(0)}%): ${dec.symbol} → HOLD`);
      continue;
    }

    // 포지션 한도 체크
    if (dec.action === ACTIONS.BUY) {
      if (portfolio.positionCount >= MAX_POS_COUNT) {
        console.log(`  ⚠️ 최대 포지션(${MAX_POS_COUNT}개) 초과 → ${dec.symbol} 스킵`);
        continue;
      }
      const maxAmount = portfolio.totalAsset * MAX_POSITION;
      if ((dec.amount_usdt || 0) > maxAmount) {
        dec.amount_usdt = Math.floor(maxAmount);
        console.log(`  ⚠️ 금액 조정: ${dec.symbol} → $${dec.amount_usdt} (20% 한도)`);
      }
      if ((dec.amount_usdt || 0) > portfolio.usdtFree) {
        console.log(`  ⚠️ 잔고 부족: ${dec.symbol} → 스킵 (필요 $${dec.amount_usdt} > 가용 $${portfolio.usdtFree.toFixed(2)})`);
        continue;
      }
    }

    // 신호 객체 구성
    const mockSignal = {
      id:         `FM-${Date.now()}-${dec.symbol.replace('/', '')}`,
      symbol:     dec.symbol,
      action:     dec.action,
      amount_usdt: dec.amount_usdt || 100,
      confidence: dec.confidence,
      reasoning:  `[펀드매니저] ${dec.reasoning}`,
      exchange:   dec.exchange || 'binance',
    };

    console.log(`\n  ⚡ ${dec.action} ${dec.symbol} $${dec.amount_usdt} (확신도 ${((dec.confidence || 0) * 100).toFixed(0)}%)`);

    try {
      if (!dryRun) guardRealOrder(dec.symbol, dec.action, dec.amount_usdt);
      const result = await executeSignal(mockSignal);
      results.push({ ...dec, result });
    } catch (e) {
      console.error(`  ❌ 실행 오류: ${e.message}`);
      await notifyError(`펀드매니저 실행 - ${dec.symbol}`, e);
    }
  }

  return results;
}

// ─── 메인 파이프라인 ────────────────────────────────────────────────

async function runFundManager({ skipPipeline = false } = {}) {
  printModeBanner('fund-manager (LU-030)');
  await db.initSchema();

  const dryRun = isDryRun();
  console.log(`\n🏦 [펀드매니저] 시작 — 모드: ${getMode().toUpperCase()} / 드라이런: ${dryRun}`);

  // 1. 신호 파이프라인 실행 (선택적)
  if (!skipPipeline) {
    console.log('\n📊 [1/4] signal-aggregator 실행 중...');
    try {
      const { runPipeline } = require('./analysts/signal-aggregator');
      await runPipeline();
    } catch (e) {
      console.warn(`  ⚠️ signal-aggregator 오류 (계속): ${e.message}`);
    }
  }

  // 2. 포트폴리오 현황
  console.log('\n💼 [2/4] 포트폴리오 현황 조회...');
  const portfolio = await buildPortfolioContext();
  console.log(portfolio.context);

  // 3. 최근 신호 조회
  console.log('\n📋 [3/4] 최근 신호 조회...');
  const signals = await getRecentSignals(30);
  if (signals.length === 0) {
    console.log('  ℹ️ 처리할 신호 없음 — 종료');
    return [];
  }
  console.log(`  → ${signals.length}개 신호 확인`);
  signals.forEach(s => console.log(`    ${s.symbol}: ${s.action} (${((s.confidence || 0) * 100).toFixed(0)}%)`));

  // 4. Sonnet 최종 판단
  console.log(`\n🧠 [4/4] [${MODEL}] 포트폴리오 최종 판단...`);
  const decision = await getFundManagerDecision(signals, portfolio);

  if (!decision) {
    console.log('  ⚠️ 판단 실패 — 종료');
    return [];
  }

  console.log(`\n  📌 포트폴리오 시황: ${decision.portfolio_view}`);
  console.log(`  📌 리스크 레벨: ${decision.risk_level}`);
  console.log(`  📌 결정 ${decision.decisions?.length || 0}건:`);
  decision.decisions?.forEach(d =>
    console.log(`    ${d.action} ${d.symbol} $${d.amount_usdt} (${((d.confidence || 0) * 100).toFixed(0)}%) — ${d.reasoning?.slice(0, 60)}`)
  );

  // 텔레그램 — 판단 요약
  const summaryMsg = [
    `🏦 펀드매니저 판단 (${getMode().toUpperCase()})`,
    `시황: ${decision.portfolio_view}`,
    `리스크: ${decision.risk_level}`,
    '',
    ...(decision.decisions || []).map(d =>
      `${d.action === 'BUY' ? '🟢' : d.action === 'SELL' ? '🔴' : '⚪'} ${d.action} ${d.symbol} $${d.amount_usdt} (${((d.confidence || 0) * 100).toFixed(0)}%)\n  ${d.reasoning?.slice(0, 80)}`
    ),
  ].join('\n');
  await sendTelegram(summaryMsg);

  // 5. 실행
  const actable = (decision.decisions || []).filter(d => d.action !== ACTIONS.HOLD);
  if (actable.length === 0) {
    console.log('\n  ⏸️ 실행할 BUY/SELL 없음');
    return [];
  }

  console.log(`\n⚡ 실행 (${actable.length}건)...`);
  const results = await executeDecisions(actable, portfolio, dryRun);

  console.log(`\n✅ [펀드매니저] 완료 — 실행 ${results.length}건`);
  return results;
}

// CLI
if (require.main === module) {
  const { registerShutdownHandlers } = require('../lib/health');
  registerShutdownHandlers([]);

  const args        = process.argv.slice(2);
  if (args.includes('--dry-run')) process.env.DRY_RUN = 'true';
  const skipPipeline = args.includes('--skip-pipeline');

  runFundManager({ skipPipeline })
    .then(r => { console.log(`\n결과: ${r.length}건 실행`); process.exit(0); })
    .catch(e => { console.error('❌ 펀드매니저 오류:', e.message); process.exit(1); });
}

module.exports = { runFundManager };
