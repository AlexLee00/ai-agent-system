// @ts-nocheck
'use strict';

/**
 * edux-formatter.ts — 루나팀 데이터 → 10섹션 표준 게시글 (1,800~2,500자)
 *
 * 3 카테고리 차별:
 *   crypto: BTC/ETH/알트코인, 기술적 분석, Fear&Greed
 *   kis:    코스피/코스닥, 외인/기관 동향
 *   overseas: S&P/Nasdaq, Magnificent 7
 *
 * Hub LLM Gateway (Sonnet 4.6 = anthropic_sonnet 매핑)
 * 모든 LLM 호출은 hub-client.ts 경유 (직접 anthropic API 호출 금지)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { callHubLlm } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/hub-client'));
const kst = require('../../../packages/core/lib/kst');

const CALLER_TEAM = 'edu-x';
const LLM_TIMEOUT_MS = 90000;
const MAX_CONTENT_LEN = 19500;
const TARGET_MIN_LEN = 1800;

// ─── 헤드라인 생성 ────────────────────────────────────────────────

function buildCryptoTitle(slot, marketData) {
  const slotLabel = { '0600': '아시아', '1400': '유럽', '2230': '미국' }[slot] || '';
  const btcPrice = marketData?.btc_price
    ? `BTC $${Number(marketData.btc_price).toLocaleString()}`
    : 'BTC 시세';
  const btcChange = marketData?.btc_change_24h != null
    ? ` (${marketData.btc_change_24h > 0 ? '+' : ''}${Number(marketData.btc_change_24h).toFixed(1)}%)`
    : '';
  const now = kst.now ? kst.now() : new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `[일일 암호화폐 브리핑${slotLabel ? ` — ${slotLabel}` : ''}] ${mm}/${dd} ${btcPrice}${btcChange}`;
}

function buildKisTitle(marketData) {
  const kospi = marketData?.kospi_index ? `코스피 ${Number(marketData.kospi_index).toFixed(0)}` : '코스피';
  const kospiChange = marketData?.kospi_change != null
    ? ` (${marketData.kospi_change > 0 ? '+' : ''}${Number(marketData.kospi_change).toFixed(1)}%)`
    : '';
  const now = kst.now ? kst.now() : new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `[국내주식 일일 브리핑] ${mm}/${dd} ${kospi}${kospiChange} 장시작 30분 전 점검`;
}

function buildOverseasTitle(marketData) {
  const sp500 = marketData?.sp500_index ? `S&P500 ${Number(marketData.sp500_index).toFixed(0)}` : 'S&P500';
  const sp500Change = marketData?.sp500_change != null
    ? ` (${marketData.sp500_change > 0 ? '+' : ''}${Number(marketData.sp500_change).toFixed(1)}%)`
    : '';
  const now = kst.now ? kst.now() : new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `[해외주식 일일 브리핑] ${mm}/${dd} ${sp500}${sp500Change} NY 개장 30분 전 점검`;
}

// ─── 시스템 프롬프트 ───────────────────────────────────────────────

function buildCryptoSystemPrompt() {
  return `당신은 Edu-X 금융교육 플랫폼의 암호화폐 전문 분석가입니다.
루나팀 AI가 수집한 시장 데이터를 바탕으로 교육적이고 균형 잡힌 일일 브리핑을 작성합니다.

규칙:
- 총 1,800~2,500자 (한국어)
- 10개 섹션 구조를 정확히 따를 것
- 투자 권유 절대 금지 (교육 목적만)
- 단정적 표현 금지 ("반드시 오른다" 등)
- 커뮤니티 멘션/트렌드 데이터를 객관적으로 제시
- 전문 용어는 간단한 설명 병기`;
}

function buildKisSystemPrompt() {
  return `당신은 Edu-X 금융교육 플랫폼의 국내주식 전문 분석가입니다.
KIS WebSocket 데이터와 네이버 뉴스를 바탕으로 장 시작 전 브리핑을 작성합니다.

규칙:
- 총 1,800~2,500자 (한국어)
- 10개 섹션 구조를 정확히 따를 것
- 외인/기관 동향은 수치 중심으로 객관 서술
- 투자 권유 절대 금지
- 공시/이벤트 일정은 KST 기준`;
}

function buildOverseasSystemPrompt() {
  return `당신은 Edu-X 금융교육 플랫폼의 해외주식 전문 분석가입니다.
루나팀 해외주식 데이터와 Reuters/Bloomberg 뉴스를 바탕으로 NY 개장 전 브리핑을 작성합니다.

규칙:
- 총 1,800~2,500자 (한국어)
- 10개 섹션 구조를 정확히 따를 것
- Magnificent 7 동향은 개별 종목 수치 포함
- 어닝 캘린더는 날짜/EPS 예상치 포함
- 투자 권유 절대 금지`;
}

// ─── 사용자 프롬프트 ──────────────────────────────────────────────

function buildCryptoUserPrompt(slot, marketData, evidenceItems, technicalData) {
  const slotLabel = { '0600': '아시아', '1400': '유럽', '2230': '미국' }[slot] || '';
  const now = kst.now ? kst.now() : new Date();

  const topIssues = (evidenceItems || [])
    .slice(0, 5)
    .map((e, i) => `${i + 1}. [${e.sourceName || 'unknown'}] ${e.evidenceSummary || ''} (멘션: ${e.rawRef?.mentions || 0}, 방향: ${e.signalDirection || 'neutral'})`)
    .join('\n');

  const altcoins = (marketData?.altcoins || [])
    .slice(0, 5)
    .map((a) => `${a.symbol} | ${a.price ? '$' + Number(a.price).toFixed(2) : '-'} | ${a.change_24h != null ? (a.change_24h > 0 ? '+' : '') + Number(a.change_24h).toFixed(1) + '%' : '-'} | ${a.trigger || '-'}`)
    .join('\n');

  const todaySchedule = (marketData?.schedule || [])
    .slice(0, 4)
    .map((s) => `- ${s.time} KST: ${s.event}`)
    .join('\n');

  return `현재 시각: ${now.toLocaleString('ko-KR')} KST (${slotLabel} 세션)

📊 시장 현황:
- BTC: $${marketData?.btc_price ? Number(marketData.btc_price).toLocaleString() : 'N/A'} (24h: ${marketData?.btc_change_24h != null ? (marketData.btc_change_24h > 0 ? '+' : '') + Number(marketData.btc_change_24h).toFixed(1) + '%' : 'N/A'})
- ETH: $${marketData?.eth_price ? Number(marketData.eth_price).toLocaleString() : 'N/A'} (24h: ${marketData?.eth_change_24h != null ? (marketData.eth_change_24h > 0 ? '+' : '') + Number(marketData.eth_change_24h).toFixed(1) + '%' : 'N/A'})
- 시총: $${marketData?.total_market_cap ? (Number(marketData.total_market_cap) / 1e12).toFixed(2) + 'T' : 'N/A'}
- Fear & Greed: ${marketData?.fear_greed_index || 'N/A'} (${marketData?.fear_greed_label || ''})

🔥 커뮤니티 Top 5 이슈 (루나팀 4,688건+ 수집):
${topIssues || '데이터 없음'}

📈 기술적 분석 (BTC 1H):
- RSI 14: ${technicalData?.rsi || 'N/A'}
- MACD: ${technicalData?.macd || 'N/A'}
- 지지선: $${technicalData?.support || 'N/A'} / 저항선: $${technicalData?.resistance || 'N/A'}
- 볼륨 (24h): ${technicalData?.volume_24h || 'N/A'}

🌐 거시 환경:
- S&P500: ${marketData?.sp500 || 'N/A'} | Nasdaq: ${marketData?.nasdaq || 'N/A'}
- DXY: ${marketData?.dxy || 'N/A'} | 10Y: ${marketData?.us10y || 'N/A'}%
- FOMC 인상 확률: ${marketData?.fomc_hike_prob || 'N/A'}%

🏆 알트코인 워치 Top 5:
symbol | 가격 | 24h | 트리거
${altcoins || 'SOL / XRP / AVAX / SUI / DOGE 데이터 없음'}

📅 오늘 일정 (KST):
${todaySchedule || '일정 없음'}

---
위 데이터를 바탕으로 아래 10개 섹션 구조로 게시글을 작성해주세요:

① 제목 + 해시태그 (제목은 별도로 반환, 해시태그는 본문에)
② TL;DR 박스 (3~4줄 핵심 요약)
③ [이미지 2장 플레이스홀더 — 실제 URL은 후처리]
④ 주요 이슈 Top 5 (헤드라인 + 핵심내용 + 영향분석 + 출처)
⑤ 기술적 분석 (RSI/MACD/지지저항/볼륨)
⑥ 거시 환경 (1~2 단락)
⑦ 알트코인 워치 Top 5 (테이블)
⑧ 오늘 일정 (KST 기준)
⑨ 루나봇 인사이트 (1~2 단락, AI 분석 관점)
⑩ 면책 + 출처 (투자 권유 아님, 자동 작성 명시)

총 1,800~2,500자로 작성하세요.`;
}

function buildKisUserPrompt(marketData, evidenceItems) {
  const now = kst.now ? kst.now() : new Date();

  const topIssues = (evidenceItems || [])
    .slice(0, 5)
    .map((e, i) => `${i + 1}. ${e.evidenceSummary || ''} (출처: ${e.sourceName || 'unknown'})`)
    .join('\n');

  const sectorWatch = (marketData?.sectors || [])
    .slice(0, 3)
    .map((s) => `- ${s.name}: ${s.change_1d != null ? (s.change_1d > 0 ? '+' : '') + Number(s.change_1d).toFixed(1) + '%' : 'N/A'}`)
    .join('\n');

  return `현재 시각: ${now.toLocaleString('ko-KR')} KST (국내장 09:00 30분 전)

📊 지수 현황:
- 코스피: ${marketData?.kospi_index || 'N/A'} (${marketData?.kospi_change != null ? (marketData.kospi_change > 0 ? '+' : '') + Number(marketData.kospi_change).toFixed(1) + '%' : 'N/A'})
- 코스닥: ${marketData?.kosdaq_index || 'N/A'} (${marketData?.kosdaq_change != null ? (marketData.kosdaq_change > 0 ? '+' : '') + Number(marketData.kosdaq_change).toFixed(1) + '%' : 'N/A'})
- 원/달러: ${marketData?.usd_krw || 'N/A'}원

👁 외인/기관 동향 (어제 기준):
- 외인 순매수: ${marketData?.foreign_net_buy != null ? (marketData.foreign_net_buy > 0 ? '+' : '') + Number(marketData.foreign_net_buy / 1e8).toFixed(0) + '억원' : 'N/A'}
- 기관 순매수: ${marketData?.institution_net_buy != null ? (marketData.institution_net_buy > 0 ? '+' : '') + Number(marketData.institution_net_buy / 1e8).toFixed(0) + '억원' : 'N/A'}

📰 Top 5 뉴스/이슈:
${topIssues || '데이터 없음'}

🏭 섹터 ETF 워치:
${sectorWatch || '반도체 / 2차전지 / 바이오 데이터 없음'}

📅 공시/이벤트:
${(marketData?.events || []).slice(0, 4).map((e) => `- ${e.time || ''}: ${e.event || ''}`).join('\n') || '없음'}

---
아래 10개 섹션 구조로 국내주식 브리핑을 작성해주세요:

① 제목 + 해시태그
② TL;DR (코스피/코스닥 핵심 3~4줄)
③ [이미지 플레이스홀더]
④ Top 5 이슈 (네이버 뉴스 기반)
⑤ 기술적 분석 (KOSPI 일봉)
⑥ 외인/기관 동향 ⭐ (수치 중심)
⑦ 섹터 ETF 워치 (반도체/2차전지/바이오)
⑧ 공시/이벤트 일정
⑨ 루나봇 인사이트
⑩ 면책

총 1,800~2,500자.`;
}

function buildOverseasUserPrompt(marketData, evidenceItems) {
  const now = kst.now ? kst.now() : new Date();

  const topIssues = (evidenceItems || [])
    .slice(0, 5)
    .map((e, i) => `${i + 1}. ${e.evidenceSummary || ''} (출처: ${e.sourceName || 'unknown'})`)
    .join('\n');

  const mag7 = (marketData?.mag7 || [])
    .map((s) => `- ${s.symbol}: $${s.price || 'N/A'} (${s.change_1d != null ? (s.change_1d > 0 ? '+' : '') + Number(s.change_1d).toFixed(1) + '%' : 'N/A'})`)
    .join('\n');

  return `현재 시각: ${now.toLocaleString('ko-KR')} KST (NY 개장 30분 전)

📊 지수 현황:
- S&P500: ${marketData?.sp500_index || 'N/A'} (${marketData?.sp500_change != null ? (marketData.sp500_change > 0 ? '+' : '') + Number(marketData.sp500_change).toFixed(1) + '%' : 'N/A'})
- Nasdaq: ${marketData?.nasdaq_index || 'N/A'} (${marketData?.nasdaq_change != null ? (marketData.nasdaq_change > 0 ? '+' : '') + Number(marketData.nasdaq_change).toFixed(1) + '%' : 'N/A'})
- DXY: ${marketData?.dxy || 'N/A'} | VIX: ${marketData?.vix || 'N/A'}

🏆 Magnificent 7 동향 ⭐:
${mag7 || 'AAPL/MSFT/GOOGL/AMZN/NVDA/META/TSLA 데이터 없음'}

📰 Top 5 이슈:
${topIssues || '데이터 없음'}

📅 어닝 캘린더:
${(marketData?.earnings || []).slice(0, 4).map((e) => `- ${e.date} ${e.symbol}: EPS 예상 ${e.eps_est || 'N/A'}`).join('\n') || '없음'}

---
아래 10개 섹션 구조로 해외주식 브리핑을 작성해주세요:

① 제목 + 해시태그
② TL;DR (S&P/Nasdaq 핵심 3~4줄)
③ [이미지 플레이스홀더]
④ Top 5 이슈 (Reuters/Bloomberg 기반)
⑤ 기술적 분석 (S&P 일봉)
⑥ Magnificent 7 동향 ⭐
⑦ 섹터 ETF (QQQ/XLK/XLE)
⑧ 어닝 캘린더
⑨ 루나봇 인사이트
⑩ 면책

총 1,800~2,500자.`;
}

// ─── LLM 호출 ─────────────────────────────────────────────────────

/**
 * @param {'crypto'|'kis'|'overseas'} category
 * @param {string} slot
 * @param {object} marketData
 * @param {Array} evidenceItems
 * @param {object} [technicalData]
 * @returns {Promise<{title: string, content: string} | null>}
 */
async function formatPost(category, slot, marketData, evidenceItems, technicalData = {}) {
  let systemPrompt, userPrompt, title;

  if (category === 'crypto') {
    systemPrompt = buildCryptoSystemPrompt();
    userPrompt = buildCryptoUserPrompt(slot, marketData, evidenceItems, technicalData);
    title = buildCryptoTitle(slot, marketData);
  } else if (category === 'kis') {
    systemPrompt = buildKisSystemPrompt();
    userPrompt = buildKisUserPrompt(marketData, evidenceItems);
    title = buildKisTitle(marketData);
  } else if (category === 'overseas') {
    systemPrompt = buildOverseasSystemPrompt();
    userPrompt = buildOverseasUserPrompt(marketData, evidenceItems);
    title = buildOverseasTitle(marketData);
  } else {
    console.error('[edu-x/formatter] 알 수 없는 category:', category);
    return null;
  }

  let llmResp;
  try {
    llmResp = await callHubLlm({
      callerTeam: CALLER_TEAM,
      agent: 'edux-formatter',
      selectorKey: 'edu-x.formatter',
      abstractModel: 'anthropic_sonnet',
      systemPrompt,
      prompt: userPrompt,
      maxTokens: 4096,
      timeoutMs: LLM_TIMEOUT_MS,
    });
  } catch (err) {
    console.error('[edu-x/formatter] callHubLlm 예외:', err?.message);
    return null;
  }

  if (!llmResp?.ok || !llmResp?.text) {
    console.error('[edu-x/formatter] LLM 응답 실패:', llmResp?.error);
    return null;
  }

  let content = llmResp.text.trim();
  if (content.length < TARGET_MIN_LEN) {
    console.warn(`[edu-x/formatter] 본문 ${content.length}자 — 목표 ${TARGET_MIN_LEN}자 미달`);
  }
  if (content.length > MAX_CONTENT_LEN) {
    content = content.slice(0, MAX_CONTENT_LEN);
  }

  return { title, content };
}

module.exports = { formatPost, buildCryptoTitle, buildKisTitle, buildOverseasTitle };
