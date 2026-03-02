'use strict';

/**
 * src/analysts/signal-aggregator.js — 신호 취합 및 LLM 판단 v2
 *
 * 1. TA 분석가 v2 — 멀티타임프레임 (1d / 4h / 1h)
 * 2. 온체인분석가 — 공포탐욕지수 + 펀딩비 + Long/Short + 미결제약정
 * 3. 전체 분석 결과 취합 → claude-haiku-4-5 최종 판단
 * 4. 신호 → DB 저장 + 텔레그램 알림
 *
 * 실행: node src/analysts/signal-aggregator.js [--symbols=BTC/USDT,ETH/USDT]
 */

const https = require('https');
const { logUsage } = require('../../lib/api-usage');
const { analyzeSymbol, calcRSI, calcMACD, calcBB, calcMovingAverages, calcStochastic, calcATR, analyzeVolume, judgeSignal } = require('./ta-analyst');
const { analyzeOnchain } = require('./onchain-analyst');
const { analyzeNews }      = require('./news-analyst');
const { analyzeSentiment } = require('./sentiment-analyst');
const { runBullResearcher, runBearResearcher } = require('./researchers');
const db = require('../../lib/db');
const { validateSignal, ACTIONS, ANALYST_TYPES } = require('../../lib/signal');
const { loadSecrets, isDryRun, hasKisApiKey, getKisSymbols, getKisOverseasSymbols, getSymbols, isKisMarketOpen, isKisOverseasMarketOpen } = require('../../lib/secrets');
const { notifySignal, notifyKisSignal, notifyError } = require('../../lib/telegram');
const { printModeBanner, assertOpsReady, getMode } = require('../../lib/mode');
const kis = require('../../lib/kis');

const DEFAULT_SYMBOLS    = getSymbols(); // secrets.binance_symbols || BTC/ETH/SOL/BNB
const MIN_CONFIDENCE     = 0.5;
const MAX_DEBATE_SYMBOLS = 2; // 실행당 강세/약세 리서처 debate 최대 심볼 수 (API 비용 절감)

// 멀티타임프레임 설정 (가중치 합계 = 1.0)
// 장기 → 단기 순으로 실행 (맥락 파악 후 단기 신호 판단)
const TIMEFRAMES = [
  { tf: '1d', label: '일봉',    weight: 0.40 },
  { tf: '4h', label: '4시간봉', weight: 0.35 },
  { tf: '1h', label: '1시간봉', weight: 0.25 },
];

// ─── Claude API 호출 ────────────────────────────────────────────────
// 임시 배정 (맥미니 구매 전): claude-haiku-4-5
// 최종 배정 (맥미니 구매 후): groq/llama-3.3-70b (3× 빠름, 무료)

function callClaudeAPI(systemPrompt, userMessage) {
  const secrets = loadSecrets();
  const apiKey  = secrets.anthropic_api_key || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ Anthropic API 키 없음 — 규칙 기반 판단으로 대체');
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  1500,
      temperature: 0.1,
      system:      systemPrompt,
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
            model:            'claude-haiku-4-5-20251001',
            promptTokens:     usage.input_tokens  || 0,
            completionTokens: usage.output_tokens || 0,
            latencyMs,
            caller:           'signal-aggregator',
            success:          !!parsed.content?.[0]?.text,
          });
          resolve(parsed.content?.[0]?.text || null);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('API 타임아웃')); });
    req.write(body);
    req.end();
  });
}

// ─── LLM 프롬프트 ──────────────────────────────────────────────────

const SYSTEM_PROMPT_CRYPTO = `당신은 암호화폐 투자 종합 판단 전문가입니다.
분석 데이터를 종합해 최종 매매 신호를 판단합니다.

응답: JSON 한 줄만 (코드블록 없음):
{"action":"HOLD","amount_usdt":100,"confidence":0.6,"reasoning":"근거 60자 이내"}

규칙:
- 장기(일봉)와 단기(1시간봉) 방향이 일치할 때만 BUY/SELL
- confidence 0.5 미만이면 반드시 HOLD
- amount_usdt: 50~300 USDT`;

const SYSTEM_PROMPT_KIS = `당신은 한국 주식시장 종합 판단 전문가입니다.
기술지표를 종합해 국내주식 매매 신호를 판단합니다.

응답: JSON 한 줄만 (코드블록 없음):
{"action":"HOLD","amount_usdt":300000,"confidence":0.6,"reasoning":"근거 60자 이내"}

주의:
- amount_usdt는 KRW 금액 (100,000~500,000원)
- confidence 0.5 미만이면 반드시 HOLD
- 가격제한폭 ±30%, 시간외거래 없음 고려`;

const SYSTEM_PROMPT_KIS_OVERSEAS = `당신은 미국 주식시장 종합 판단 전문가입니다.
기술지표를 종합해 미국주식 매매 신호를 판단합니다.

응답: JSON 한 줄만 (코드블록 없음):
{"action":"HOLD","amount_usdt":100,"confidence":0.6,"reasoning":"근거 60자 이내"}

주의:
- amount_usdt는 USD 금액 (50~300 USD)
- confidence 0.5 미만이면 반드시 HOLD
- 미국 장 시간(EST/EDT) 내에서만 거래 가능
- 1주 단위 거래 (소수점 불가)`;

// ─── 분석 요약 빌더 (리서처용) ────────────────────────────────────

function buildAnalysisSummary(analyses) {
  if (!analyses || analyses.length === 0) return '분석 데이터 없음';
  return analyses.map(a => {
    const label = a.analyst === ANALYST_TYPES.ONCHAIN   ? '온체인'        :
                  a.analyst === ANALYST_TYPES.NEWS       ? '뉴스'          :
                  a.analyst === ANALYST_TYPES.SENTIMENT  ? '커뮤니티감성'  : 'TA';
    return `[${label}] 신호: ${a.signal} | 확신도: ${((a.confidence || 0) * 100).toFixed(0)}% | ${a.reasoning || ''}`;
  }).join('\n');
}

async function getLLMDecision(symbol, analyses, exchange = 'binance', debate = null) {
  // 분석 타입·타임프레임별 분류
  const byTf      = {};
  const onchainList = [];
  const newsList      = [];
  const sentimentList = [];
  for (const a of analyses) {
    if (a.analyst === ANALYST_TYPES.ONCHAIN) {
      onchainList.push(a);
      continue;
    }
    if (a.analyst === ANALYST_TYPES.NEWS) {
      newsList.push(a);
      continue;
    }
    if (a.analyst === ANALYST_TYPES.SENTIMENT) {
      sentimentList.push(a);
      continue;
    }
    const tfMatch = a.reasoning?.match(/^\[(\w+)\]/);
    const tf = tfMatch ? tfMatch[1] : '1h';
    if (!byTf[tf]) byTf[tf] = [];
    byTf[tf].push(a);
  }

  const taSummary = TIMEFRAMES
    .filter(({ tf }) => byTf[tf]?.length > 0)
    .map(({ tf, label, weight }) => {
      const latest = byTf[tf]?.sort((a, b) => b.created_at - a.created_at)[0];
      return `[TA ${label} ${(weight * 100).toFixed(0)}%] 신호: ${latest.signal} | 확신도: ${(latest.confidence * 100).toFixed(0)}% | ${latest.reasoning}`;
    }).join('\n');

  const onchainSummary = onchainList.length > 0
    ? `[온체인] 신호: ${onchainList[0].signal} | 확신도: ${(onchainList[0].confidence * 100).toFixed(0)}% | ${onchainList[0].reasoning}`
    : '';

  const newsSummary = newsList.length > 0
    ? `[뉴스] 신호: ${newsList[0].signal} | 확신도: ${(newsList[0].confidence * 100).toFixed(0)}% | ${newsList[0].reasoning}`
    : '';

  const sentimentSummary = sentimentList.length > 0
    ? `[커뮤니티감성] 신호: ${sentimentList[0].signal} | 확신도: ${(sentimentList[0].confidence * 100).toFixed(0)}% | ${sentimentList[0].reasoning}`
    : '';

  const summary = [taSummary, onchainSummary, newsSummary, sentimentSummary].filter(Boolean).join('\n');

  const marketLabel = exchange === 'kis' ? '국내주식' : exchange === 'kis_overseas' ? '미국주식' : '암호화폐';
  let debateSection = '';
  if (debate) {
    const bullText = debate.bull
      ? `목표가 ${debate.bull.targetPrice?.toLocaleString()} | 상승여력 ${debate.bull.upsidePct}% | ${debate.bull.reasoning} | 촉매: ${debate.bull.keyCatalysts?.join(', ')}`
      : '데이터 없음';
    const bearText = debate.bear
      ? `목표가 ${debate.bear.targetPrice?.toLocaleString()} | 하락위험 ${debate.bear.downsidePct}% | ${debate.bear.reasoning} | 리스크: ${debate.bear.keyRisks?.join(', ')}`
      : '데이터 없음';
    debateSection = `\n\n강세/약세 리서처 토론:\n[강세 리서처] ${bullText}\n[약세 리서처] ${bearText}`;
  }
  const userMsg = `심볼: ${symbol} (${marketLabel})\n\n멀티타임프레임 분석:\n${summary || '분석 없음'}${debateSection}\n\n최종 매매 판단을 내려주세요.`;
  const systemPrompt = exchange === 'kis' ? SYSTEM_PROMPT_KIS
                     : exchange === 'kis_overseas' ? SYSTEM_PROMPT_KIS_OVERSEAS
                     : SYSTEM_PROMPT_CRYPTO;

  const responseText = await callClaudeAPI(systemPrompt, userMsg);

  if (!responseText) {
    // API 없을 때 가중치 기반 규칙 판단
    const weightedScore = TIMEFRAMES.reduce((total, { tf, weight }) => {
      const latest = byTf[tf]?.sort((a, b) => b.created_at - a.created_at)[0];
      if (!latest) return total;
      const v = latest.signal === 'BUY' ? 1 : latest.signal === 'SELL' ? -1 : 0;
      return total + v * weight * latest.confidence;
    }, 0);

    const action    = weightedScore > 0.2 ? ACTIONS.BUY : weightedScore < -0.2 ? ACTIONS.SELL : ACTIONS.HOLD;
    const avgConf   = analyses.reduce((s, a) => s + (a.confidence || 0), 0) / analyses.length;
    return { action, amount_usdt: 100, confidence: avgConf, reasoning: `규칙 기반 가중치 판단 (점수: ${weightedScore.toFixed(2)})` };
  }

  try {
    const cleaned = responseText.replace(/```json?\n?|\n?```/g, '').trim();
    // JSON 객체 경계 추출 (잘린 응답 대비)
    const s = cleaned.indexOf('{'), e2 = cleaned.lastIndexOf('}');
    return JSON.parse(s >= 0 && e2 > s ? cleaned.slice(s, e2 + 1) : cleaned);
  } catch (e) {
    // 잘린 JSON에서 필드 추출 (부분복구)
    const aMatch = responseText.match(/"action"\s*:\s*"(\w+)"/);
    const cMatch = responseText.match(/"confidence"\s*:\s*([\d.]+)/);
    const mMatch = responseText.match(/"amount_usdt"\s*:\s*([\d]+)/);
    const rMatch = responseText.match(/"reasoning"\s*:\s*"([^"]{1,80})/);
    if (aMatch) {
      console.warn(`  ⚠️ LLM 응답 부분복구: action=${aMatch[1]}`);
      return {
        action:      aMatch[1],
        amount_usdt: mMatch ? parseInt(mMatch[1]) : 0,
        confidence:  cMatch ? parseFloat(cMatch[1]) : 0,
        reasoning:   (rMatch ? rMatch[1] : '부분복구') + ' (파싱복구)',
      };
    }
    console.error('⚠️ LLM 응답 파싱 실패:', responseText.slice(0, 200));
    return { action: ACTIONS.HOLD, amount_usdt: 0, confidence: 0, reasoning: 'LLM 응답 파싱 실패 → HOLD' };
  }
}

// ─── 메인 파이프라인 ───────────────────────────────────────────────

async function runPipeline(symbols = DEFAULT_SYMBOLS) {
  printModeBanner('signal-aggregator v2');

  if (getMode() === 'ops') assertOpsReady();

  console.log(`\n🔄 [신호 집계 v2] 파이프라인 시작 — ${symbols.join(', ')}`);
  console.log(`📍 모드: ${getMode().toUpperCase()} / 드라이런: ${isDryRun()}`);
  console.log(`📐 타임프레임: ${TIMEFRAMES.map(t => t.tf).join(' + ')} + 온체인 + 뉴스 + 감성`);

  const results = [];
  let debateCount = 0; // 이번 실행에서 debate 실행된 심볼 수 (MAX_DEBATE_SYMBOLS 제한)

  // ─── 코인 파이프라인 ────────────────────────────────────────────
  for (const symbol of symbols) {
    try {
      // 1. 멀티타임프레임 TA 분석
      for (const { tf, label } of TIMEFRAMES) {
        console.log(`\n  📊 [${label}] ${symbol} 분석 중...`);
        await analyzeSymbol(symbol, tf);
        await new Promise(r => setTimeout(r, 300));
      }

      // 2. 온체인 분석
      try {
        await analyzeOnchain(symbol);
      } catch (e) {
        console.warn(`  ⚠️ [온체인] ${symbol} 분석 실패 (계속): ${e.message}`);
      }

      // 3. 뉴스 분석
      try {
        await analyzeNews(symbol);
      } catch (e) {
        console.warn(`  ⚠️ [뉴스] ${symbol} 분석 실패 (계속): ${e.message}`);
      }

      // 4. 커뮤니티 감성 분석
      try {
        await analyzeSentiment(symbol);
      } catch (e) {
        console.warn(`  ⚠️ [감성] ${symbol} 분석 실패 (계속): ${e.message}`);
      }

      // 5. 최근 60분 분석 결과 조회 (TA + 온체인 + 뉴스 + 감성 모두 포함)
      const analyses = await db.getRecentAnalysis(symbol, 60);
      if (analyses.length === 0) {
        console.log(`  ⚠️ ${symbol}: 분석 결과 없음 → 스킵`);
        continue;
      }

      // 6. 강세/약세 리서처 병렬 실행 (HedgeAgents 패턴, 최대 MAX_DEBATE_SYMBOLS 심볼)
      let debate = null;
      if (debateCount < MAX_DEBATE_SYMBOLS) {
        try {
          const summaryForResearchers = buildAnalysisSummary(analyses);
          const [bull, bear] = await Promise.all([
            runBullResearcher(symbol, summaryForResearchers, null, 'binance'),
            runBearResearcher(symbol, summaryForResearchers, null, 'binance'),
          ]);
          debate = { bull, bear };
          debateCount++;
          if (bull) console.log(`  🐂 [강세] 목표가 ${bull.targetPrice} | ${bull.reasoning?.slice(0, 50)}`);
          if (bear) console.log(`  🐻 [약세] 목표가 ${bear.targetPrice} | ${bear.reasoning?.slice(0, 50)}`);
        } catch (e) {
          console.warn(`  ⚠️ [리서처] ${symbol} 실패 (계속): ${e.message}`);
        }
      } else {
        console.log(`  ⏭️ [리서처] ${symbol}: debate 한도 도달 (${debateCount}/${MAX_DEBATE_SYMBOLS}) → 스킵`);
      }

      // 7. LLM 최종 판단 (토론 결과 포함)
      console.log(`\n🤖 [LLM haiku] ${symbol} 판단 요청...`);
      const decision = await getLLMDecision(symbol, analyses, 'binance', debate);
      console.log(`  → ${decision.action} (확신도 ${((decision.confidence || 0) * 100).toFixed(0)}%)`);
      console.log(`  근거: ${decision.reasoning}`);

      // 4. 신호 검증 + 저장
      const signalData = {
        symbol,
        action:     decision.action,
        amountUsdt: decision.amount_usdt,
        confidence: decision.confidence,
        reasoning:  decision.reasoning,
      };

      const { valid, errors } = validateSignal(signalData);
      if (!valid) {
        console.warn(`  ⚠️ 신호 검증 실패: ${errors.join(', ')}`);
        continue;
      }

      if (decision.action !== ACTIONS.HOLD && decision.confidence >= MIN_CONFIDENCE) {
        const signalId = await db.insertSignal(signalData);
        console.log(`  ✅ 신호 저장: ${signalId}`);
        await notifySignal({ ...signalData, dryRun: isDryRun() });
        results.push({ symbol, signalId, ...decision });
      } else {
        console.log(`  ⏸️ ${symbol}: HOLD 또는 확신도 낮음 → 대기`);
      }

    } catch (e) {
      console.error(`  ❌ ${symbol} 처리 오류: ${e.message}`);
      await notifyError(`신호 집계 v2 - ${symbol}`, e);
    }
  }

  // ─── KIS 파이프라인 ────────────────────────────────────────────
  const kisSymbols  = getKisSymbols();
  const kisIsOpen   = isKisMarketOpen();

  if (!hasKisApiKey()) {
    console.log(`\n⚠️ [KIS] API 키 미설정 — KIS 파이프라인 건너뜀 (${kisSymbols.join(', ')})`);
  } else if (!kisIsOpen) {
    // 장외 시간에는 일봉 OHLCV가 전일 종가로 고정 → TA 신호 의미 없음
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60000);
    console.log(`\n⏸️ [KIS] 장외 시간 — KIS 파이프라인 건너뜀 (KST ${kst.toISOString().slice(11, 16)}, 09:00~15:30 장중만 실행)`);
  } else {
    console.log(`\n🏛️ [KIS] 파이프라인 시작 — ${kisSymbols.join(', ')}`);

    for (const symbol of kisSymbols) {
      try {
        console.log(`\n📊 [TA] ${symbol} (KIS) 분석 시작`);

        // MA120 계산을 위해 150개 요청 (KIS API 최대치 내)
        const ohlcv = await kis.fetchOHLCV(symbol, 150);
        if (ohlcv.length < 27) {
          console.log(`  ⚠️ ${symbol}: 데이터 부족 (${ohlcv.length}개, 최소 27개 필요) → 스킵`);
          continue;
        }

        // OHLCV 분해 — 암호화폐 TA와 동일한 6지표 계산
        const highs   = ohlcv.map(c => c[2]);
        const lows    = ohlcv.map(c => c[3]);
        const closes  = ohlcv.map(c => c[4]);
        const volumes = ohlcv.map(c => c[5]);
        const currentPrice = closes[closes.length - 1];

        const rsi   = calcRSI(closes);
        const macd  = calcMACD(closes);
        const bb    = calcBB(closes);
        const mas   = calcMovingAverages(closes);
        const stoch = calcStochastic(highs, lows, closes);
        const atr   = calcATR(highs, lows, closes);
        const vol   = analyzeVolume(volumes);

        const { signal, confidence, reasoning, score } =
          judgeSignal({ rsi, macd, bb, currentPrice, mas, stoch, atr, vol });

        console.log(`  현재가: ${currentPrice?.toLocaleString()}원 | RSI: ${rsi?.toFixed(1)} | MACD: ${macd?.histogram?.toFixed(4)}`);
        console.log(`  MA5: ${mas.ma5?.toFixed(0)} | MA20: ${mas.ma20?.toFixed(0)} | MA60: ${mas.ma60?.toFixed(0)} | 스토캐스틱K: ${stoch?.k?.toFixed(1)}`);
        console.log(`  → 점수: ${score?.toFixed(2)} | 신호: ${signal} (확신도 ${(confidence * 100).toFixed(0)}%)`);

        await db.insertAnalysis({
          symbol,
          analyst:   ANALYST_TYPES.TA,
          signal,
          confidence,
          reasoning: `[1d] ${reasoning}`,
          metadata:  {
            timeframe: '1d',
            score,
            indicators: {
              rsi,
              macd:     macd?.histogram,
              bbWidth:  bb?.bandwidth,
              ma5:      mas.ma5,
              ma20:     mas.ma20,
              ma60:     mas.ma60,
              ma120:    mas.ma120,
              stochK:   stoch?.k,
              stochD:   stoch?.d,
              atr,
              volRatio: vol?.ratio,
            },
          },
          exchange:  'kis',
        });

        const analyses = await db.getRecentAnalysis(symbol, 30);

        // 강세/약세 리서처 병렬 실행 (HedgeAgents 패턴, 코인과 공유 debate 카운터)
        let debate = null;
        if (debateCount < MAX_DEBATE_SYMBOLS) {
          try {
            const summaryForResearchers = buildAnalysisSummary(analyses);
            const [bull, bear] = await Promise.all([
              runBullResearcher(symbol, summaryForResearchers, currentPrice, 'kis'),
              runBearResearcher(symbol, summaryForResearchers, currentPrice, 'kis'),
            ]);
            debate = { bull, bear };
            debateCount++;
            if (bull) console.log(`  🐂 [강세] 목표가 ${bull.targetPrice?.toLocaleString()}원 | ${bull.reasoning?.slice(0, 40)}`);
            if (bear) console.log(`  🐻 [약세] 목표가 ${bear.targetPrice?.toLocaleString()}원 | ${bear.reasoning?.slice(0, 40)}`);
          } catch (e) {
            console.warn(`  ⚠️ [리서처] ${symbol} (KIS) 실패 (계속): ${e.message}`);
          }
        } else {
          console.log(`  ⏭️ [리서처] ${symbol} (KIS): debate 한도 도달 (${debateCount}/${MAX_DEBATE_SYMBOLS}) → 스킵`);
        }

        console.log(`\n🤖 [LLM haiku] ${symbol} (KIS) 판단 요청...`);
        const decision = await getLLMDecision(symbol, analyses, 'kis', debate);
        console.log(`  → ${decision.action} (확신도 ${((decision.confidence || 0) * 100).toFixed(0)}%)`);
        console.log(`  근거: ${decision.reasoning}`);

        const signalData = {
          symbol,
          action:     decision.action,
          amountUsdt: decision.amount_usdt,
          confidence: decision.confidence,
          reasoning:  decision.reasoning,
          exchange:   'kis',
        };

        const { valid, errors } = validateSignal(signalData);
        if (!valid) { console.warn(`  ⚠️ KIS 신호 검증 실패: ${errors.join(', ')}`); continue; }

        if (decision.action !== ACTIONS.HOLD && decision.confidence >= MIN_CONFIDENCE) {
          const signalId = await db.insertSignal(signalData);
          console.log(`  ✅ KIS 신호 저장: ${signalId}`);
          await notifyKisSignal({ ...signalData, dryRun: isDryRun() });
          results.push({ symbol, signalId, exchange: 'kis', ...decision });
        } else {
          console.log(`  ⏸️ ${symbol} (KIS): HOLD 또는 확신도 낮음 → 대기`);
        }

      } catch (e) {
        console.error(`  ❌ ${symbol} (KIS) 처리 오류: ${e.message}`);
        await notifyError(`신호 집계(KIS) - ${symbol}`, e);
      }
    }
  }

  // ─── KIS 해외주식(미국) 파이프라인 ──────────────────────────────
  const overseasSymbols = getKisOverseasSymbols();
  const overseasIsOpen  = isKisOverseasMarketOpen();

  if (!hasKisApiKey()) {
    console.log(`\n⚠️ [KIS 해외] API 키 미설정 — 해외주식 파이프라인 건너뜀 (${overseasSymbols.join(', ')})`);
  } else if (!overseasIsOpen) {
    const now = new Date();
    const etOffset = -4 * 60; // EDT (서머타임 간소화)
    const etMin    = ((now.getUTCHours() * 60 + now.getUTCMinutes()) + etOffset + 24 * 60) % (24 * 60);
    const etTime   = `${String(Math.floor(etMin / 60)).padStart(2, '0')}:${String(etMin % 60).padStart(2, '0')}`;
    console.log(`\n⏸️ [KIS 해외] 장외 시간 — 파이프라인 건너뜀 (ET ${etTime}, 09:30~16:00 장중만 실행)`);
  } else {
    console.log(`\n🌏 [KIS 해외] 파이프라인 시작 — ${overseasSymbols.join(', ')}`);

    for (const symbol of overseasSymbols) {
      try {
        console.log(`\n📊 [TA] ${symbol} (미국주식) 분석 시작`);

        const ohlcv = await kis.fetchOHLCVOverseas(symbol, 150);
        if (ohlcv.length < 27) {
          console.log(`  ⚠️ ${symbol}: 데이터 부족 (${ohlcv.length}개, 최소 27개 필요) → 스킵`);
          continue;
        }

        const highs   = ohlcv.map(c => c[2]);
        const lows    = ohlcv.map(c => c[3]);
        const closes  = ohlcv.map(c => c[4]);
        const volumes = ohlcv.map(c => c[5]);
        const currentPrice = closes[closes.length - 1];

        const rsi   = calcRSI(closes);
        const macd  = calcMACD(closes);
        const bb    = calcBB(closes);
        const mas   = calcMovingAverages(closes);
        const stoch = calcStochastic(highs, lows, closes);
        const atr   = calcATR(highs, lows, closes);
        const vol   = analyzeVolume(volumes);

        const { signal, confidence, reasoning, score } =
          judgeSignal({ rsi, macd, bb, currentPrice, mas, stoch, atr, vol });

        console.log(`  현재가: $${currentPrice?.toFixed(2)} | RSI: ${rsi?.toFixed(1)} | MACD: ${macd?.histogram?.toFixed(4)}`);
        console.log(`  MA5: ${mas.ma5?.toFixed(2)} | MA20: ${mas.ma20?.toFixed(2)} | MA60: ${mas.ma60?.toFixed(2)} | 스토캐스틱K: ${stoch?.k?.toFixed(1)}`);
        console.log(`  → 점수: ${score?.toFixed(2)} | 신호: ${signal} (확신도 ${(confidence * 100).toFixed(0)}%)`);

        await db.insertAnalysis({
          symbol,
          analyst:   ANALYST_TYPES.TA,
          signal,
          confidence,
          reasoning: `[1d] ${reasoning}`,
          metadata:  {
            timeframe: '1d',
            score,
            indicators: {
              rsi, macd: macd?.histogram, bbWidth: bb?.bandwidth,
              ma5: mas.ma5, ma20: mas.ma20, ma60: mas.ma60, ma120: mas.ma120,
              stochK: stoch?.k, stochD: stoch?.d, atr, volRatio: vol?.ratio,
            },
          },
          exchange:  'kis_overseas',
        });

        const analyses = await db.getRecentAnalysis(symbol, 30);

        // 강세/약세 리서처 병렬 실행 (코인·국내주식과 공유 debate 카운터)
        let debate = null;
        if (debateCount < MAX_DEBATE_SYMBOLS) {
          try {
            const summaryForResearchers = buildAnalysisSummary(analyses);
            const [bull, bear] = await Promise.all([
              runBullResearcher(symbol, summaryForResearchers, currentPrice, 'kis_overseas'),
              runBearResearcher(symbol, summaryForResearchers, currentPrice, 'kis_overseas'),
            ]);
            debate = { bull, bear };
            debateCount++;
            if (bull) console.log(`  🐂 [강세] 목표가 $${bull.targetPrice} | ${bull.reasoning?.slice(0, 40)}`);
            if (bear) console.log(`  🐻 [약세] 목표가 $${bear.targetPrice} | ${bear.reasoning?.slice(0, 40)}`);
          } catch (e) {
            console.warn(`  ⚠️ [리서처] ${symbol} (해외) 실패 (계속): ${e.message}`);
          }
        } else {
          console.log(`  ⏭️ [리서처] ${symbol} (해외): debate 한도 도달 (${debateCount}/${MAX_DEBATE_SYMBOLS}) → 스킵`);
        }

        console.log(`\n🤖 [LLM haiku] ${symbol} (미국주식) 판단 요청...`);
        const decision = await getLLMDecision(symbol, analyses, 'kis_overseas', debate);
        console.log(`  → ${decision.action} (확신도 ${((decision.confidence || 0) * 100).toFixed(0)}%)`);
        console.log(`  근거: ${decision.reasoning}`);

        const signalData = {
          symbol,
          action:     decision.action,
          amountUsdt: decision.amount_usdt, // USD 금액
          confidence: decision.confidence,
          reasoning:  decision.reasoning,
          exchange:   'kis_overseas',
        };

        const { valid, errors } = validateSignal(signalData);
        if (!valid) { console.warn(`  ⚠️ KIS 해외 신호 검증 실패: ${errors.join(', ')}`); continue; }

        if (decision.action !== ACTIONS.HOLD && decision.confidence >= MIN_CONFIDENCE) {
          const signalId = await db.insertSignal(signalData);
          console.log(`  ✅ KIS 해외 신호 저장: ${signalId}`);
          await notifyKisSignal({ ...signalData, dryRun: isDryRun() });
          results.push({ symbol, signalId, exchange: 'kis_overseas', ...decision });
        } else {
          console.log(`  ⏸️ ${symbol} (미국주식): HOLD 또는 확신도 낮음 → 대기`);
        }

      } catch (e) {
        console.error(`  ❌ ${symbol} (KIS 해외) 처리 오류: ${e.message}`);
        await notifyError(`신호 집계(KIS 해외) - ${symbol}`, e);
      }
    }
  }

  console.log(`\n✅ [신호 집계 v2] 완료 — ${results.length}개 신호 생성`);
  return results;
}

// CLI 실행
if (require.main === module) {
  const { registerShutdownHandlers } = require('../../lib/health');
  registerShutdownHandlers([]);

  const args = process.argv.slice(2);
  const symbolArg = args.find(a => a.startsWith('--symbols='));
  const symbols = symbolArg
    ? symbolArg.split('=')[1].split(',').map(s => s.trim())
    : DEFAULT_SYMBOLS;

  runPipeline(symbols)
    .then(results => { console.log(`\n결과: ${results.length}개 신호`); process.exit(0); })
    .catch(e => { console.error('❌ 파이프라인 오류:', e.message); process.exit(1); });
}

module.exports = { runPipeline };
