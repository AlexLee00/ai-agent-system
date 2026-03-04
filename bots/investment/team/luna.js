/**
 * team/luna.js — 루나 (오케스트레이터·최종 판단)
 *
 * 역할: 모든 분석가 결과 수집 → 강세/약세 토론 → 최종 투자 판단
 * LLM: Claude Haiku (LIVE) / Groq Scout (PAPER) — PAPER_MODE 분기
 *
 * 흐름:
 *   1. 분석가 결과 조회 (aria + oracle + hermes + sophia)
 *   2. 제우스(강세) + 아테나(약세) 리서처 병렬 토론
 *   3. 최종 판단 (포트폴리오 맥락)
 *   4. 네메시스 리스크 평가
 *   5. 신호 DB 저장 + 텔레그램
 *
 * 실행: node team/luna.js --symbols=BTC/USDT,ETH/USDT
 */

import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import { callLLM, parseJSON } from '../shared/llm-client.js';
import { ACTIONS, ANALYST_TYPES, validateSignal } from '../shared/signal.js';
import { notifySignal, notifyError } from '../shared/report.js';
import { publishToMainBot } from '../shared/mainbot-client.js';
import { isPaperMode } from '../shared/secrets.js';
import { runBullResearcher } from './zeus.js';
import { runBearResearcher } from './athena.js';
import { evaluateSignal } from './nemesis.js';
import { recommendStrategy } from './argos.js';

const MIN_CONFIDENCE     = 0.55;
const FUND_MIN_CONF      = 0.60;
const MAX_POS_COUNT      = 5;
const MAX_DEBATE_SYMBOLS = 2;

// ─── 시스템 프롬프트 ────────────────────────────────────────────────

const LUNA_SYSTEM = `당신은 루나(Luna), 루나팀의 수석 오케스트레이터다.
멀티타임프레임 TA·온체인·뉴스·감성·강세/약세 2라운드 토론 결과를 종합해 최종 매매 신호를 결정한다.

핵심 원칙:
- 불확실할 때는 HOLD — 확신이 없으면 진입하지 않는다
- 장기(4h)와 단기(1h) 방향이 일치할 때만 BUY/SELL
- 2라운드 토론 후 강세가 약세를 충분히 반박하지 못하면 HOLD
- confidence 0.55 미만이면 반드시 HOLD

응답 형식 (JSON만, 다른 텍스트 없이):
{"action":"HOLD","amount_usdt":100,"confidence":0.6,"reasoning":"근거 60자 이내"}

amount_usdt 범위: 50~300 USDT`.trim();

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

export function buildAnalysisSummary(analyses) {
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

export async function getSymbolDecision(symbol, analyses, exchange = 'binance', debate = null) {
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

  // 아르고스 전략 컨텍스트 (실패 시 빈 문자열)
  let strategySection = '';
  try {
    const strat = await recommendStrategy(symbol, exchange);
    if (strat) {
      strategySection = `\n\n[참고 전략 — 아르고스]\n${strat.strategy_name}: ${strat.entry_condition || '진입 조건 없음'} (품질점수 ${strat.quality_score?.toFixed(2)})`;
    }
  } catch {}

  const userMsg = `심볼: ${symbol} (${label})\n\n분석 결과:\n${summary}${debateSection}${strategySection}\n\n최종 매매 신호:`;
  const raw     = await callLLM('luna', LUNA_SYSTEM, userMsg, 512);
  const parsed  = parseJSON(raw);

  if (!parsed?.action) {
    const votes   = analyses.filter(a => a.signal !== 'HOLD').map(a => a.signal === 'BUY' ? 1 : -1);
    const avgConf = analyses.reduce((s, a) => s + (a.confidence || 0), 0) / (analyses.length || 1);
    const vote    = votes.reduce((a, b) => a + b, 0);
    const action  = vote > 0 ? ACTIONS.BUY : vote < 0 ? ACTIONS.SELL : ACTIONS.HOLD;
    return { action, amount_usdt: 100, confidence: avgConf, reasoning: '분석가 투표 기반 (LLM fallback)' };
  }
  return parsed;
}

// ─── 포트폴리오 판단 ───────────────────────────────────────────────

export async function getPortfolioDecision(symbolDecisions, portfolio) {
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

  const raw    = await callLLM('luna', PORTFOLIO_PROMPT, userMsg, 1024);
  const parsed = parseJSON(raw);
  if (!parsed) return { decisions: symbolDecisions.map(s => ({ ...s })), portfolio_view: 'LLM 판단 실패', risk_level: 'MEDIUM' };
  return parsed;
}

// ─── 포트폴리오 컨텍스트 ───────────────────────────────────────────

async function buildPortfolioContext() {
  const positions  = await db.getAllPositions();
  const todayPnl   = await db.getTodayPnl();
  const posValue   = positions.reduce((s, p) => s + (p.amount * p.avg_price), 0);
  const usdtFree   = 10000;
  const totalAsset = usdtFree + posValue;
  // 사이클별 자산 스냅샷 기록 (드로우다운 추적용)
  try { await db.insertAssetSnapshot(totalAsset, usdtFree); } catch {}
  return { usdtFree, totalAsset, positionCount: positions.length, todayPnl, positions };
}

// ─── 2라운드 토론 ───────────────────────────────────────────────────

/**
 * 리서처 토론 1라운드 or 2라운드 실행
 * @param {string} symbol
 * @param {string} summary    분석 요약 텍스트
 * @param {string} exchange
 * @param {object|null} prevDebate  1라운드 결과 (null이면 1라운드)
 * @returns {{ bull, bear, round }}
 */
async function runDebateRound(symbol, summary, exchange, prevDebate = null) {
  if (!prevDebate) {
    // 1라운드: 병렬 실행
    const [bull, bear] = await Promise.all([
      runBullResearcher(symbol, summary, null, exchange),
      runBearResearcher(symbol, summary, null, exchange),
    ]);
    return { bull, bear, round: 1 };
  }

  // 2라운드: 상대방 주장 포함 재반박
  const bullCtx = prevDebate.bear
    ? `${summary}\n\n[약세 주장 반박 요청]\n${prevDebate.bear.reasoning}`
    : summary;
  const bearCtx = prevDebate.bull
    ? `${summary}\n\n[강세 주장 반박 요청]\n${prevDebate.bull.reasoning}`
    : summary;

  const [bull2, bear2] = await Promise.all([
    runBullResearcher(symbol, bullCtx, null, exchange),
    runBearResearcher(symbol, bearCtx, null, exchange),
  ]);
  return { bull: bull2, bear: bear2, round: 2 };
}

// ─── 메인 오케스트레이터 ────────────────────────────────────────────

/**
 * 심볼 배열에 대해 분석 결과 취합 → 최종 신호 결정 → DB 저장
 * @param {string[]} symbols
 * @param {string}   exchange
 * @returns {Promise<Array>}
 */
export async function orchestrate(symbols, exchange = 'binance', params = null) {
  const label           = exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
  const results         = [];
  let debateCount       = 0;
  const portfolio       = await buildPortfolioContext();
  const symbolDecisions = [];

  console.log(`\n🌙 [루나] ${label} 오케스트레이션 시작 — ${symbols.join(', ')}`);

  for (const symbol of symbols) {
    try {
      const analyses = await db.getRecentAnalysis(symbol, 70);
      if (analyses.length === 0) {
        console.log(`  ⚠️ [루나] ${symbol}: 분석 결과 없음 → 스킵`);
        continue;
      }

      console.log(`  📋 [루나] ${symbol}: ${analyses.length}개 분석 결과`);

      let debate = null;
      if (debateCount < MAX_DEBATE_SYMBOLS) {
        try {
          const summary = buildAnalysisSummary(analyses);

          // 1라운드
          const r1 = await runDebateRound(symbol, summary, exchange, null);
          if (r1.bull) console.log(`  🐂 [제우스 R1] 목표가 ${r1.bull.targetPrice} | ${r1.bull.reasoning?.slice(0, 50)}`);
          if (r1.bear) console.log(`  🐻 [아테나 R1] 목표가 ${r1.bear.targetPrice} | ${r1.bear.reasoning?.slice(0, 50)}`);

          // 2라운드 (상대방 주장 보고 재반박)
          const r2 = await runDebateRound(symbol, summary, exchange, r1);
          if (r2.bull) console.log(`  🐂 [제우스 R2] ${r2.bull.reasoning?.slice(0, 60)}`);
          if (r2.bear) console.log(`  🐻 [아테나 R2] ${r2.bear.reasoning?.slice(0, 60)}`);

          debate = { bull: r2.bull, bear: r2.bear, r1 };
          debateCount++;
        } catch (e) {
          console.warn(`  ⚠️ [루나] ${symbol} 리서처 실패: ${e.message}`);
        }
      } else {
        console.log(`  ⏭️ [루나] ${symbol}: debate 한도 도달 → 스킵`);
      }

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

  console.log(`\n🏦 [루나] 포트폴리오 최종 판단...`);
  const portfolio_decision = await getPortfolioDecision(symbolDecisions, portfolio);

  if (!portfolio_decision) {
    console.log('  ⚠️ [루나] 포트폴리오 판단 실패');
    return [];
  }

  console.log(`  📌 시황: ${portfolio_decision.portfolio_view}`);
  console.log(`  📌 리스크: ${portfolio_decision.risk_level}`);

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
  publishToMainBot({ from_bot: 'luna', event_type: 'report', alert_level: 1, message: summaryMsg });

  for (const dec of (portfolio_decision.decisions || [])) {
    if (dec.action === ACTIONS.HOLD) continue;
    const minConf = params?.minSignalScore ?? FUND_MIN_CONF;
    if ((dec.confidence || 0) < minConf) {
      console.log(`  ⏸️ [루나] ${dec.symbol}: 확신도 미달 (${((dec.confidence || 0) * 100).toFixed(0)}% < ${(minConf * 100).toFixed(0)}%) → HOLD`);
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args     = process.argv.slice(2);
  const symArg   = args.find(a => a.startsWith('--symbols='));
  const symbols  = symArg ? symArg.split('=')[1].split(',').map(s => s.trim()) : ['BTC/USDT'];
  const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';

  await db.initSchema();
  try {
    const r = await orchestrate(symbols, exchange);
    console.log(`\n결과: ${r.length}개 신호`);
    process.exit(0);
  } catch (e) {
    console.error('❌ 루나 오류:', e.message);
    process.exit(1);
  }
}
