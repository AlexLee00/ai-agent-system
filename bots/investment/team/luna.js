'use strict';

/**
 * team/luna.js — 루나 (오케스트레이터·최종 판단)
 *
 * 역할: 모든 분석가 결과 수집 → 강세/약세 토론 → 최종 투자 판단
 * LLM: Claude Haiku (포트폴리오 레벨 최종 판단)
 *
 * 흐름:
 *   1. 분석가 결과 조회 (aria + oracle + hermes + sophia)
 *   2. 제우스(강세) + 아테나(약세) 리서처 병렬 토론
 *   3. Haiku 최종 판단 (포트폴리오 맥락)
 *   4. 네메시스 리스크 평가
 *   5. 신호 DB 저장 + 텔레그램
 *
 * bots/invest/src/fund-manager.js + signal-aggregator.js 통합
 *
 * 실행: node team/luna.js --symbols=BTC/USDT,ETH/USDT
 */

const db       = require('../shared/db');
const { callHaiku, parseJSON } = require('../shared/llm');
const { ACTIONS, ANALYST_TYPES, validateSignal } = require('../shared/signal');
const { notifySignal, notifyError, sendTelegram } = require('../shared/report');
const { isPaperMode }           = require('../shared/secrets');
const { runBullResearcher }     = require('./zeus');
const { runBearResearcher }     = require('./athena');
const { evaluateSignal }        = require('./nemesis');

const MIN_CONFIDENCE     = 0.55;   // 신호 저장 최소 확신도
const FUND_MIN_CONF      = 0.60;   // 펀드매니저 최소 실행 확신도
const MAX_POSITION       = 0.20;   // 단일 포지션 최대 20%
const MAX_POS_COUNT      = 5;
const MAX_DEBATE_SYMBOLS = 2;      // debate 비용 절감: 최대 2심볼

// ─── 시스템 프롬프트 ────────────────────────────────────────────────

const SIGNAL_PROMPT = `당신은 루나팀 투자 분석가입니다. 멀티타임프레임 분석·온체인·뉴스·감성·리서처 토론 결과를 종합해 최종 매매 신호를 판단합니다.

응답: JSON 한 줄만 (코드블록 없음):
{"action":"HOLD","amount_usdt":100,"confidence":0.6,"reasoning":"근거 60자 이내"}

규칙:
- 장기(4h)와 단기(1h) 방향이 일치할 때만 BUY/SELL
- confidence 0.55 미만이면 반드시 HOLD
- amount_usdt: 50~300 USDT`;

const PORTFOLIO_PROMPT = `당신은 루나팀 수석 펀드매니저입니다. 개별 심볼 신호를 포트폴리오 맥락에서 검토합니다.

응답: JSON만 (코드블록 없음):
{"decisions":[{"symbol":"BTC/USDT","action":"BUY","amount_usdt":100,"confidence":0.7,"reasoning":"판단 근거 (한국어 60자)"}],"portfolio_view":"전체 시황 평가 (80자)","risk_level":"LOW"|"MEDIUM"|"HIGH"}

제약:
- 단일 포지션: 총자산 20% 이하
- 동시 포지션: 최대 ${MAX_POS_COUNT}개
- 일손실 한도: 5%
- confidence ${FUND_MIN_CONF} 미만: HOLD
- USDT 잔고 초과 매수 금지`;

// ─── 분석 요약 빌더 ─────────────────────────────────────────────────

function buildAnalysisSummary(analyses) {
  if (!analyses || analyses.length === 0) return '분석 데이터 없음';
  return analyses.map(a => {
    const label = a.analyst === ANALYST_TYPES.TA_MTF    ? 'TA(MTF)'
                : a.analyst === ANALYST_TYPES.ONCHAIN   ? '온체인'
                : a.analyst === ANALYST_TYPES.NEWS      ? '뉴스'
                : a.analyst === ANALYST_TYPES.SENTIMENT ? '감성'
                : a.analyst === ANALYST_TYPES.X_SEARCH  ? 'X감성'
                : 'TA';
    return `[${label}] ${a.signal} | ${((a.confidence || 0) * 100).toFixed(0)}% | ${a.reasoning || ''}`;
  }).join('\n');
}

// ─── 개별 심볼 LLM 판단 ────────────────────────────────────────────

async function getSymbolDecision(symbol, analyses, exchange = 'binance', debate = null) {
  const summary = buildAnalysisSummary(analyses);
  const label   = exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';

  let debateSection = '';
  if (debate) {
    const bullText = debate.bull
      ? `목표가 ${debate.bull.targetPrice} | 상승 ${debate.bull.upsidePct}% | ${debate.bull.reasoning}`
      : '데이터 없음';
    const bearText = debate.bear
      ? `목표가 ${debate.bear.targetPrice} | 하락 ${debate.bear.downsidePct}% | ${debate.bear.reasoning}`
      : '데이터 없음';
    debateSection = `\n\n[강세 리서처] ${bullText}\n[약세 리서처] ${bearText}`;
  }

  const userMsg = `심볼: ${symbol} (${label})\n\n분석 결과:\n${summary}${debateSection}\n\n최종 매매 신호:`;

  const raw    = await callHaiku(SIGNAL_PROMPT, userMsg, 'luna-signal', 512);
  const parsed = parseJSON(raw);

  if (!parsed?.action) {
    // fallback: 가중 평균
    const votes    = analyses.filter(a => a.signal !== 'HOLD').map(a => a.signal === 'BUY' ? 1 : -1);
    const avgConf  = analyses.reduce((s, a) => s + (a.confidence || 0), 0) / (analyses.length || 1);
    const vote     = votes.reduce((a, b) => a + b, 0);
    const action   = vote > 0 ? ACTIONS.BUY : vote < 0 ? ACTIONS.SELL : ACTIONS.HOLD;
    return { action, amount_usdt: 100, confidence: avgConf, reasoning: '분석가 투표 기반 (LLM fallback)' };
  }
  return parsed;
}

// ─── 포트폴리오 판단 ───────────────────────────────────────────────

async function getPortfolioDecision(symbolDecisions, portfolio) {
  if (symbolDecisions.length === 0) return null;

  const signalLines = symbolDecisions
    .map(s => `${s.symbol}: ${s.action} | 확신도 ${((s.confidence || 0) * 100).toFixed(0)}% | ${s.reasoning}`)
    .join('\n');

  const userMsg = [
    `=== 포트폴리오 현황 ===`,
    `USDT 가용: $${portfolio.usdtFree.toFixed(2)} | 총자산: $${portfolio.totalAsset.toFixed(2)}`,
    `현재 포지션: ${portfolio.positionCount}/${MAX_POS_COUNT}개`,
    `오늘 P&L: ${(portfolio.todayPnl?.pnl || 0) >= 0 ? '+' : ''}$${(portfolio.todayPnl?.pnl || 0).toFixed(2)}`,
    ``,
    `=== 분석가 신호 ===`,
    signalLines,
    ``,
    `최종 포트폴리오 투자 결정:`,
  ].join('\n');

  const raw    = await callHaiku(PORTFOLIO_PROMPT, userMsg, 'luna-portfolio', 1024);
  const parsed = parseJSON(raw);
  if (!parsed) return { decisions: symbolDecisions.map(s => ({ ...s })), portfolio_view: 'LLM 판단 실패', risk_level: 'MEDIUM' };
  return parsed;
}

// ─── 포트폴리오 컨텍스트 ───────────────────────────────────────────

async function buildPortfolioContext() {
  const positions   = await db.getAllPositions();
  const todayPnl    = await db.getTodayPnl();
  const posValue    = positions.reduce((s, p) => s + (p.amount * p.avg_price), 0);
  const usdtFree    = 10000; // 바이낸스 키 없으면 기본값
  const totalAsset  = usdtFree + posValue;
  return { usdtFree, totalAsset, positionCount: positions.length, todayPnl, positions };
}

// ─── 메인 오케스트레이터 ────────────────────────────────────────────

/**
 * 심볼 배열에 대해 분석 결과 취합 → 최종 신호 결정 → DB 저장
 * @param {string[]} symbols
 * @param {string}   exchange
 * @returns {Promise<Array>}
 */
async function orchestrate(symbols, exchange = 'binance') {
  const label       = exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
  const results     = [];
  let debateCount   = 0;
  const portfolio   = await buildPortfolioContext();
  const symbolDecisions = [];

  console.log(`\n🌙 [루나] ${label} 오케스트레이션 시작 — ${symbols.join(', ')}`);

  for (const symbol of symbols) {
    try {
      // 최근 70분 분석 결과 조회 (5분 사이클 × 14회 = 70분)
      const analyses = await db.getRecentAnalysis(symbol, 70);
      if (analyses.length === 0) {
        console.log(`  ⚠️ [루나] ${symbol}: 분석 결과 없음 → 스킵`);
        continue;
      }

      console.log(`  📋 [루나] ${symbol}: ${analyses.length}개 분석 결과`);

      // 강세/약세 토론 (최대 MAX_DEBATE_SYMBOLS)
      let debate = null;
      if (debateCount < MAX_DEBATE_SYMBOLS) {
        try {
          const summary = buildAnalysisSummary(analyses);
          const currentPrice = null; // 아리아의 현재가 추출
          const [bull, bear] = await Promise.all([
            runBullResearcher(symbol, summary, currentPrice, exchange),
            runBearResearcher(symbol, summary, currentPrice, exchange),
          ]);
          debate = { bull, bear };
          debateCount++;
          if (bull) console.log(`  🐂 [제우스] 목표가 ${bull.targetPrice} | ${bull.reasoning?.slice(0, 50)}`);
          if (bear) console.log(`  🐻 [아테나] 목표가 ${bear.targetPrice} | ${bear.reasoning?.slice(0, 50)}`);
        } catch (e) {
          console.warn(`  ⚠️ [루나] ${symbol} 리서처 실패: ${e.message}`);
        }
      } else {
        console.log(`  ⏭️ [루나] ${symbol}: debate 한도 도달 → 스킵`);
      }

      // 심볼별 최종 신호 판단
      console.log(`\n  🤖 [루나] ${symbol} 신호 판단 중...`);
      const decision = await getSymbolDecision(symbol, analyses, exchange, debate);
      console.log(`  → ${decision.action} (${((decision.confidence || 0) * 100).toFixed(0)}%) | ${decision.reasoning}`);

      symbolDecisions.push({ symbol, exchange, ...decision });
    } catch (e) {
      console.error(`  ❌ [루나] ${symbol} 오류: ${e.message}`);
      await notifyError(`루나 오케스트레이터 - ${symbol}`, e);
    }
  }

  if (symbolDecisions.length === 0) {
    console.log('  ℹ️ [루나] 처리할 심볼 없음');
    return [];
  }

  // 포트폴리오 레벨 최종 판단
  console.log(`\n🏦 [루나] 포트폴리오 최종 판단...`);
  const portfolio_decision = await getPortfolioDecision(symbolDecisions, portfolio);

  if (!portfolio_decision) {
    console.log('  ⚠️ [루나] 포트폴리오 판단 실패');
    return [];
  }

  console.log(`  📌 시황: ${portfolio_decision.portfolio_view}`);
  console.log(`  📌 리스크: ${portfolio_decision.risk_level}`);

  // 텔레그램 요약
  const paperMode  = isPaperMode();
  const summaryMsg = [
    `${paperMode ? '[PAPER] ' : ''}🌙 루나 판단 (${label})`,
    `시황: ${portfolio_decision.portfolio_view}`,
    `리스크: ${portfolio_decision.risk_level}`,
    '',
    ...(portfolio_decision.decisions || []).map(d => {
      const emoji = d.action === 'BUY' ? '🟢' : d.action === 'SELL' ? '🔴' : '⚪';
      return `${emoji} ${d.action} ${d.symbol} $${d.amount_usdt} (${((d.confidence || 0) * 100).toFixed(0)}%)\n  ${d.reasoning?.slice(0, 80)}`;
    }),
  ].join('\n');
  await sendTelegram(summaryMsg);

  // 신호 저장 + 네메시스 리스크 평가
  for (const dec of (portfolio_decision.decisions || [])) {
    if (dec.action === ACTIONS.HOLD) continue;
    if ((dec.confidence || 0) < FUND_MIN_CONF) {
      console.log(`  ⏸️ [루나] ${dec.symbol}: 확신도 미달 (${((dec.confidence || 0) * 100).toFixed(0)}%) → HOLD`);
      continue;
    }

    const signalData = {
      symbol:     dec.symbol,
      action:     dec.action,
      amountUsdt: dec.amount_usdt || 100,
      confidence: dec.confidence,
      reasoning:  `[루나] ${dec.reasoning}`,
      exchange:   dec.exchange || exchange,
    };

    const { valid, errors } = validateSignal(signalData);
    if (!valid) {
      console.warn(`  ⚠️ [루나] ${dec.symbol} 신호 검증 실패: ${errors.join(', ')}`);
      continue;
    }

    const signalId = await db.insertSignal(signalData);
    console.log(`  ✅ [루나] 신호 저장: ${signalId} (${dec.symbol} ${dec.action})`);
    await notifySignal({ ...signalData, paper: paperMode });

    // 네메시스 리스크 평가
    try {
      const riskResult = await evaluateSignal({ id: signalId, ...signalData }, { totalUsdt: portfolio.totalAsset });
      if (riskResult.approved) {
        console.log(`  ✅ [네메시스] 승인: $${riskResult.adjustedAmount}`);
        results.push({ symbol: dec.symbol, signalId, ...dec, adjustedAmount: riskResult.adjustedAmount });
      } else {
        console.log(`  🚫 [네메시스] 거부: ${riskResult.reason}`);
      }
    } catch (e) {
      console.warn(`  ⚠️ [네메시스] 리스크 평가 실패 (신호만 저장): ${e.message}`);
      results.push({ symbol: dec.symbol, signalId, ...dec });
    }
  }

  console.log(`\n✅ [루나] 완료 — ${results.length}개 신호 승인`);
  return results;
}

// CLI 실행
if (require.main === module) {
  const args     = process.argv.slice(2);
  const symArg   = args.find(a => a.startsWith('--symbols='));
  const symbols  = symArg ? symArg.split('=')[1].split(',').map(s => s.trim()) : ['BTC/USDT'];
  const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';

  db.initSchema()
    .then(() => orchestrate(symbols, exchange))
    .then(r => { console.log(`\n결과: ${r.length}개 신호`); process.exit(0); })
    .catch(e => { console.error('❌ 루나 오류:', e.message); process.exit(1); });
}

module.exports = { orchestrate, getSymbolDecision, getPortfolioDecision, buildAnalysisSummary };
