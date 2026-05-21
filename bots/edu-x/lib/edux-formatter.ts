// @ts-nocheck
'use strict';

/**
 * edux-formatter.ts — 커뮤니티/시장 데이터 → Edu-X 게시글
 *
 * 3 카테고리 차별:
 *   crypto: BTC/USDT 중심 6블록 커뮤니티형 시황 카드
 *   kis:    코스피/코스닥, 외인/기관, 섹터 이슈 중심 6블록 시황 카드
 *   overseas: S&P/Nasdaq, VIX/DXY, Magnificent 7 중심 6블록 시황 카드
 *
 * Hub LLM Gateway (Sonnet 4.6 = anthropic_sonnet 매핑)
 * 모든 LLM 호출은 hub-client.ts 경유 (직접 anthropic API 호출 금지)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { callHubLlm } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/hub-client'));
const kst = require('../../../packages/core/lib/kst');

const CALLER_TEAM = 'luna';
const LLM_AGENT = 'reporter';
const LLM_SELECTOR_KEY = 'investment.reporter';
const LLM_TIMEOUT_MS = 90000;
const DEFAULT_FORMATTER_MODE = 'llm';
const DEFAULT_LLM_ABSTRACT_MODEL = 'anthropic_opus';
const DEFAULT_LLM_MAX_TOKENS = 4096;
const DEFAULT_LLM_TEMPERATURE = 0.2;
const DEFAULT_LLM_PRIMARY_MODEL = 'gpt-5.4';
const DEFAULT_LLM_GEMINI_PRO_MODEL = 'gemini-2.5-pro';
const DEFAULT_LLM_DEEP_FALLBACK_MODEL = 'qwen/qwen3-32b';
const DEFAULT_LLM_MINI_FALLBACK_MODEL = 'gpt-5.4-mini';
const MAX_CONTENT_LEN = 19500;
const TARGET_MIN_LEN = 0;
const LEGACY_SECTION_MARKERS_RE = /^[①②③④⑤⑥⑦⑧⑨⑩]\s*/;
const SECTION_HEADING_EMOJI_RE = /^(?:[①②③④⑤⑥⑦⑧⑨⑩]\s*)?(?:🧭|⚡|₿|📌|🌐|📰|📈|🛡️?|💸|💎|👀|🗓️?|🤖|⚠️?)\s+/u;
const REQUIRED_SECTION_COUNT = 10;
const REQUIRED_SECTIONS_BY_CATEGORY = {
  crypto: [
    { key: 'quick_read', prefix: '⚡', keywords: ['핵심', '3줄', '요약'] },
    { key: 'price_map', prefix: '📌', keywords: ['btc/usdt', '가격', '지도'] },
    { key: 'scenarios', prefix: '📈', keywords: ['상승', '하락', '시나리오'] },
    { key: 'community_news', prefix: '🌐', keywords: ['커뮤니티', '뉴스', '이슈'] },
    { key: 'ai_recommendation', prefix: '🤖', keywords: ['인공지능', '추천'] },
    { key: 'checkpoint_disclaimer', prefix: '⚠', keywords: ['체크포인트', '면책'] },
  ],
  kis: [
    { key: 'quick_read', prefix: '⚡', keywords: ['핵심', '3줄', '요약'] },
    { key: 'market_flow_map', prefix: '📌', keywords: ['지수', '수급', '지도'] },
    { key: 'sector_watch', prefix: '👀', keywords: ['섹터', '워치'] },
    { key: 'community_news', prefix: '🌐', keywords: ['커뮤니티', '뉴스', '이슈'] },
    { key: 'ai_recommendation', prefix: '🤖', keywords: ['인공지능', '추천'] },
    { key: 'checkpoint_disclaimer', prefix: '⚠', keywords: ['체크포인트', '면책'] },
  ],
  overseas: [
    { key: 'quick_read', prefix: '⚡', keywords: ['핵심', '3줄', '요약'] },
    { key: 'market_risk_map', prefix: '📌', keywords: ['지수', '리스크', '지도'] },
    { key: 'mag7_sector_map', prefix: '💎', keywords: ['magnificent', '7', '섹터', '지도'] },
    { key: 'community_news', prefix: '🌐', keywords: ['커뮤니티', '뉴스', '이슈'] },
    { key: 'ai_recommendation', prefix: '🤖', keywords: ['인공지능', '추천'] },
    { key: 'checkpoint_disclaimer', prefix: '⚠', keywords: ['체크포인트', '면책'] },
  ],
};
const FORBIDDEN_PATTERNS = [
  { key: 'notion', re: /notion/i },
  { key: 'activity', re: /\bactivity\b/i },
  { key: 'likes_or_comments', re: /좋아요|댓글/ },
];
const CRYPTO_PLACEHOLDER_RE = /수집 대기|데이터 없음|데이터 부족|충분히 수집되지|확인 필요|N\/A|다음 슬롯에서 재확인|차트에서 재확인/i;
const INTERNAL_EQUITY_SOURCE_RE = /^(?:luna|investment|strategy|runtime|worker|ai\.|bot)/i;
const INTERNAL_EQUITY_EVIDENCE_RE = /strategy-|stop_loss|take_profit|blocked_reason|reconcile|승인형\s*strategy|매수\s*신호|매도\s*신호/i;

function isSectionHeadingLine(line) {
  return SECTION_HEADING_EMOJI_RE.test(String(line || '').trim());
}

function stripLegacySectionNumber(line) {
  const text = String(line || '');
  return isSectionHeadingLine(text) ? text.replace(LEGACY_SECTION_MARKERS_RE, '') : text;
}

function normalizeSectionHeadingNumbers(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => stripLegacySectionNumber(line))
    .join('\n')
    .trim();
}

function extractSectionHeadings(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => stripLegacySectionNumber(line).trim())
    .filter((line) => isSectionHeadingLine(line));
}

function normalizeHeadingForMatch(heading) {
  return String(heading || '')
    .replace(/\uFE0F/g, '')
    .trim()
    .toLowerCase();
}

function headingMatchesRule(heading, rule) {
  const text = normalizeHeadingForMatch(heading);
  const prefix = normalizeHeadingForMatch(rule.prefix);
  if (!text.startsWith(prefix)) return false;
  return (rule.keywords || []).some((keyword) => text.includes(String(keyword).toLowerCase()));
}

function resolveSectionValidation(content, category) {
  const headings = extractSectionHeadings(content);
  const categoryKeys = category && REQUIRED_SECTIONS_BY_CATEGORY[category]
    ? [category]
    : Object.keys(REQUIRED_SECTIONS_BY_CATEGORY);
  const candidates = categoryKeys.map((key) => {
    const rules = REQUIRED_SECTIONS_BY_CATEGORY[key];
    const missingSections = rules
      .filter((rule) => !headings.some((heading) => headingMatchesRule(heading, rule)))
      .map((rule) => rule.key);
    return { category: key, headings, missingSections };
  });
  return candidates.sort((a, b) => a.missingSections.length - b.missingSections.length)[0];
}

function requiredSectionCountFor(category) {
  return REQUIRED_SECTIONS_BY_CATEGORY[category]?.length || REQUIRED_SECTION_COUNT;
}

function validateCryptoInformationDensity(text) {
  const issues = [];
  if (CRYPTO_PLACEHOLDER_RE.test(text)) issues.push('crypto_placeholder_text');
  const numericSignalCount = (String(text).match(/\$[\d,.]+[KMBT]?|\b\d+(?:\.\d+)?K\b|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?점/g) || []).length;
  if (numericSignalCount < 8) issues.push(`crypto_numeric_signals:${numericSignalCount}/8`);
  const requiredTerms = [
    { key: 'current_price', re: /현재가|가격/ },
    { key: 'support', re: /지지/ },
    { key: 'resistance', re: /저항/ },
    { key: 'bull_scenario', re: /상승 시나리오/ },
    { key: 'bear_scenario', re: /하락 시나리오/ },
    { key: 'invalidation', re: /무효화|이탈|돌파 실패/ },
    { key: 'community_issue', re: /커뮤니티|뉴스|이슈/ },
  ];
  for (const item of requiredTerms) {
    if (!item.re.test(text)) issues.push(`crypto_missing_${item.key}`);
  }
  return issues;
}

function cleanConfigValue(value) {
  return String(value || '').trim();
}

function categoryEnvName(category, suffix) {
  return `EDUX_${String(category || '').toUpperCase()}_${suffix}`;
}

function normalizeFormatterMode(value) {
  const mode = cleanConfigValue(value || DEFAULT_FORMATTER_MODE).toLowerCase();
  if (['llm', 'hub_llm', 'hub-llm'].includes(mode)) return 'llm';
  if (['deterministic', 'fallback', 'card', 'static', 'off', 'false', '0'].includes(mode)) return 'deterministic';
  return DEFAULT_FORMATTER_MODE;
}

function resolveFormatterMode(category, options = {}) {
  if (options.formatterMode) return normalizeFormatterMode(options.formatterMode);
  const categoryMode = process.env[categoryEnvName(category, 'FORMATTER_MODE')];
  if (categoryMode) return normalizeFormatterMode(categoryMode);
  return normalizeFormatterMode(process.env.EDUX_FORMATTER_MODE || DEFAULT_FORMATTER_MODE);
}

function resolveFormatterLlmConfig(category, options = {}) {
  const categoryPrefix = String(category || '').toUpperCase();
  const abstractModel = cleanConfigValue(
    options.abstractModel
    || process.env[`EDUX_${categoryPrefix}_FORMATTER_ABSTRACT_MODEL`]
    || process.env.EDUX_FORMATTER_ABSTRACT_MODEL
    || DEFAULT_LLM_ABSTRACT_MODEL,
  );
  const selectorKey = cleanConfigValue(
    options.selectorKey
    || process.env[`EDUX_${categoryPrefix}_FORMATTER_SELECTOR_KEY`]
    || process.env.EDUX_FORMATTER_SELECTOR_KEY
    || LLM_SELECTOR_KEY,
  );
  const agent = cleanConfigValue(
    options.agent
    || process.env[`EDUX_${categoryPrefix}_FORMATTER_AGENT`]
    || process.env.EDUX_FORMATTER_AGENT
    || LLM_AGENT,
  );
  const maxTokens = Math.max(1024, Number(
    options.maxTokens
    || process.env[`EDUX_${categoryPrefix}_FORMATTER_MAX_TOKENS`]
    || process.env.EDUX_FORMATTER_MAX_TOKENS
    || DEFAULT_LLM_MAX_TOKENS,
  ) || DEFAULT_LLM_MAX_TOKENS);
  const temperature = Number.isFinite(Number(options.temperature))
    ? Number(options.temperature)
    : Number(
      process.env[`EDUX_${categoryPrefix}_FORMATTER_TEMPERATURE`]
      || process.env.EDUX_FORMATTER_TEMPERATURE
      || DEFAULT_LLM_TEMPERATURE,
    );

  return {
    mode: resolveFormatterMode(category, options),
    callerTeam: CALLER_TEAM,
    agent,
    selectorKey,
    abstractModel,
    maxTokens,
    temperature: Number.isFinite(temperature) ? temperature : DEFAULT_LLM_TEMPERATURE,
    timeoutMs: Math.max(10000, Number(
      options.timeoutMs
      || process.env[`EDUX_${categoryPrefix}_FORMATTER_TIMEOUT_MS`]
      || process.env.EDUX_FORMATTER_TIMEOUT_MS
      || LLM_TIMEOUT_MS,
    ) || LLM_TIMEOUT_MS),
  };
}

function flagDisabled(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function resolveFormatterPolicyOverride(llmConfig, options = {}) {
  if (options.policyOverride) return options.policyOverride;
  if (flagDisabled(process.env.EDUX_FORMATTER_POLICY_OVERRIDE)) return undefined;

  const maxTokens = llmConfig.maxTokens || DEFAULT_LLM_MAX_TOKENS;
  const temperature = llmConfig.temperature ?? DEFAULT_LLM_TEMPERATURE;
  const primaryModel = cleanConfigValue(process.env.EDUX_FORMATTER_PRIMARY_MODEL || DEFAULT_LLM_PRIMARY_MODEL);
  const geminiProModel = cleanConfigValue(process.env.EDUX_FORMATTER_GEMINI_PRO_MODEL || DEFAULT_LLM_GEMINI_PRO_MODEL);
  const deepFallbackModel = cleanConfigValue(process.env.EDUX_FORMATTER_DEEP_FALLBACK_MODEL || DEFAULT_LLM_DEEP_FALLBACK_MODEL);
  const miniFallbackModel = cleanConfigValue(process.env.EDUX_FORMATTER_MINI_FALLBACK_MODEL || DEFAULT_LLM_MINI_FALLBACK_MODEL);

  return {
    chain: [
      { provider: 'openai-oauth', model: primaryModel, maxTokens, temperature, timeoutMs: llmConfig.timeoutMs },
      { provider: 'gemini-cli-oauth', model: geminiProModel, maxTokens, temperature, timeoutMs: llmConfig.timeoutMs },
      { provider: 'groq', model: deepFallbackModel, maxTokens, temperature, timeoutMs: Math.min(llmConfig.timeoutMs, 60000) },
      { provider: 'openai-oauth', model: miniFallbackModel, maxTokens, temperature, timeoutMs: Math.min(llmConfig.timeoutMs, 60000) },
    ],
  };
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function formatUsd(value, decimals = 0) {
  if (!hasValue(value)) return '수집 대기';
  const n = Number(value);
  if (!Number.isFinite(n)) return '수집 대기';
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatUsdCompact(value) {
  if (!hasValue(value)) return '수집 대기';
  const n = Number(value);
  if (!Number.isFinite(n)) return '수집 대기';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatPercent(value) {
  if (!hasValue(value)) return '수집 대기';
  const n = Number(value);
  if (!Number.isFinite(n)) return '수집 대기';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function formatPlain(value, suffix = '') {
  if (!hasValue(value)) return '수집 대기';
  return `${value}${suffix}`;
}

function formatScore(value, label = '', scale = '0~100') {
  if (!hasValue(value)) return '수집 대기';
  const n = Number(value);
  if (!Number.isFinite(n)) return '수집 대기';
  const score = Number.isInteger(n) ? String(n) : n.toFixed(1);
  const details = [label, scale].filter(Boolean).join(', ');
  return `${score}점${details ? `(${details})` : ''}`;
}

function formatMacdValue(value) {
  if (!hasValue(value)) return '수집 대기';
  if (typeof value === 'number') return `${value.toFixed(2)} USDT`;
  const text = String(value);
  const match = text.match(/^([+-]?\d+(?:\.\d+)?)(.*)$/);
  if (!match) return text;
  const tail = match[2] || '';
  return `${match[1]} USDT${tail}`;
}

function displayMarketSymbol(symbol, fallbackQuote = 'USDT') {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.includes('/')) return normalized;
  if (fallbackQuote && normalized.endsWith(fallbackQuote)) {
    return `${normalized.slice(0, -fallbackQuote.length)}/${fallbackQuote}`;
  }
  if (/^[A-Z0-9]{2,10}$/.test(normalized) && fallbackQuote) return `${normalized}/${fallbackQuote}`;
  return normalized;
}

function formatCommunitySourceLabel(sourceName) {
  const text = String(sourceName || '').trim();
  const key = text.toLowerCase();
  if (!key || key.startsWith('luna') || key.includes('community')) return '커뮤니티 수집';
  if (key.includes('reddit')) return 'Reddit 커뮤니티';
  if (key.includes('fear_greed')) return 'Fear & Greed 지수';
  if (key.includes('coingecko')) return 'CoinGecko 트렌드';
  if (key.includes('apewisdom')) return 'ApeWisdom 트렌드';
  if (key.includes('google_news') || key.includes('news_rss') || key.endsWith('_rss')) return '뉴스 RSS';
  if (key.includes('naver')) return '네이버 뉴스';
  if (key.includes('yahoo')) return 'Yahoo Finance 뉴스';
  return '외부 커뮤니티/뉴스';
}

function formatSignalDirectionLabel(direction) {
  const key = String(direction || '').trim().toLowerCase();
  if (key === 'positive' || key === 'bullish') return '긍정';
  if (key === 'negative' || key === 'bearish') return '주의';
  if (key === 'neutral') return '중립';
  return key || '중립';
}

function extractFlowAmount(text) {
  const match = String(text || '').match(/(?:\$|usd\s*)?\d+(?:[.,]\d+)?\s*(?:b|bn|billion|m|mn|million)\b/i);
  return match ? match[0].replace(/\s+/g, ' ') : '';
}

function formatCryptoIssueSummary(item, btcSymbol = 'BTC/USDT') {
  const summary = String(item?.evidenceSummary || '').trim();
  if (!summary) return `${btcSymbol} 가격 반응 관련 커뮤니티 이슈가 관측됐습니다.`;
  if (/[가-힣]/.test(summary)) return summary;

  const text = summary.toLowerCase();
  const flowAmount = extractFlowAmount(summary);
  const flowAmountText = flowAmount ? `${flowAmount} 규모의 ` : '';
  if (/outflow|withdrawal|redemption/.test(text)) {
    return `ETF/ETP에서 ${flowAmountText}자금 유출이 언급되며, 단기 수급 부담으로 확인됩니다.`;
  }
  if (/inflow|net add|adding|addition/.test(text)) {
    return `ETF/ETP에서 ${flowAmountText}자금 유입이 언급되며, 단기 수급 지지 요인으로 확인됩니다.`;
  }
  if (/etf|etp|coinshares/.test(text)) {
    return 'ETF/ETP 자금 흐름 변화가 단기 수급 이슈로 언급됩니다.';
  }
  if (/bond|yield|interest rate|rates|fomc|fed/.test(text)) {
    return '미국 금리·채권금리 부담이 변동성 요인으로 언급됩니다.';
  }
  if (/bear market|pessimistic|downside|slides?|slump|below|under|gives up|sell|loss/.test(text)) {
    return '약세 흐름과 손절·위험회피 심리가 단기 경계 요인으로 언급됩니다.';
  }
  if (/treasury|strategy|saylor|buys?|adding|holdings?|positions?/.test(text)) {
    return `기관·상장사의 BTC 보유 확대 이슈가 중장기 수요 근거로 언급됩니다.`;
  }
  if (/defi|programmable|private|privacy|verifiedx/.test(text)) {
    return `비트코인 기반 DeFi·프라이버시 확장 논의가 중장기 내러티브로 언급됩니다.`;
  }
  if (/miner|mining|hive|canaan|ai facility|infrastructure/.test(text)) {
    return `비트코인 채굴·AI 인프라 관련 기업 뉴스가 BTC 관련 섹터 이슈로 언급됩니다.`;
  }
  if (/congress|clarity act|regulat|china|u\.s\.|us /.test(text)) {
    return `미국 규제·정책 논의가 암호화폐 위험 선호에 영향을 줄 이슈로 언급됩니다.`;
  }
  return '관련 해외 뉴스 이슈가 관측됐으며, 가격 반응과 거래량 확인이 필요합니다.';
}

function formatCryptoIssueTone(item, summary = '') {
  const text = `${summary || ''} ${item?.evidenceSummary || ''}`.toLowerCase();
  if (/약세|손절|위험회피|금리|채권금리|부담|유출|outflow|withdrawal|redemption/.test(text)) return '주의';
  if (/유입|inflow/.test(text)) return '긍정';
  if (/기관|상장사|보유 확대|defi|프라이버시|확장 논의|정책|규제/.test(text)) return '중립';
  return formatSignalDirectionLabel(item?.signalDirection);
}

function formatEquitySourceLabel(sourceName, category) {
  const key = String(sourceName || '').trim().toLowerCase();
  if (!key || key.startsWith('luna')) return category === 'kis' ? '국내 수급/뉴스 수집' : '해외 시장/뉴스 수집';
  if (key.includes('naver')) return '네이버 뉴스';
  if (key.includes('yahoo')) return 'Yahoo Finance 뉴스';
  if (key.includes('reuters')) return 'Reuters 뉴스';
  if (key.includes('bloomberg')) return 'Bloomberg 뉴스';
  if (key.includes('google_news') || key.includes('news_rss') || key.endsWith('_rss')) return '뉴스 RSS';
  if (key.includes('reddit')) return 'Reddit 커뮤니티';
  if (key.includes('community')) return '커뮤니티 수집';
  return category === 'kis' ? '국내 커뮤니티/뉴스' : '해외 커뮤니티/뉴스';
}

function formatKisIssueSummary(item) {
  const summary = String(item?.evidenceSummary || item?.summary || '').trim();
  if (!summary) return '국내 증시 수급·섹터 이슈가 관측됐습니다.';
  if (/[가-힣]/.test(summary)) return summary;

  const text = summary.toLowerCase();
  if (/semiconductor|hbm|chip|memory|samsung|sk hynix|sk hynix|ai server/.test(text)) {
    return '반도체·HBM 이슈가 코스피 대형주와 외국인 수급의 핵심 변수로 언급됩니다.';
  }
  if (/battery|ev|lithium|cathode|anode|lg energy|sdi|posco/.test(text)) {
    return '2차전지·전기차 밸류체인 이슈가 코스닥과 성장주 선별 변수로 언급됩니다.';
  }
  if (/fx|usd\/krw|won|dollar|currency|exchange rate/.test(text)) {
    return '원/달러 환율 변화가 외국인 수급과 대형주 방향성 변수로 언급됩니다.';
  }
  if (/foreign|institution|net buy|net selling|flow|rotation/.test(text)) {
    return '외국인·기관 수급 변화와 업종 순환매가 장중 방향성 변수로 언급됩니다.';
  }
  if (/biotech|bio|pharma|healthcare/.test(text)) {
    return '바이오·헬스케어 이슈가 코스닥 변동성 확대 요인으로 언급됩니다.';
  }
  if (/shipbuilding|defense|cosmetics|export|tariff/.test(text)) {
    return '수출·방산·조선·화장품 등 테마성 업종 이슈가 단기 수급 후보로 언급됩니다.';
  }
  return '국내 증시 관련 해외·커뮤니티 이슈가 관측됐으며, 개장 후 수급 반응 확인이 필요합니다.';
}

function formatOverseasIssueSummary(item) {
  const summary = String(item?.evidenceSummary || item?.summary || '').trim();
  if (!summary) return '해외 증시 매크로·대형주 이슈가 관측됐습니다.';
  if (/[가-힣]/.test(summary)) return summary;

  const text = summary.toLowerCase();
  if (/nvidia|nvda|ai|semiconductor|chip|datacenter|data center|infrastructure/.test(text)) {
    return 'AI 인프라·반도체 대형주 이슈가 Nasdaq과 Magnificent 7 방향성 변수로 언급됩니다.';
  }
  if (/earnings|eps|revenue|guidance|beat|miss/.test(text)) {
    return '실적·가이던스 이슈가 개별 대형주와 지수 체감 방향을 흔들 변수로 언급됩니다.';
  }
  if (/vix|volatility|risk-off|selloff|drawdown/.test(text)) {
    return 'VIX와 변동성 확대 이슈가 장전 리스크 관리 포인트로 언급됩니다.';
  }
  if (/fed|fomc|rate|yield|treasury|inflation|cpi|pce/.test(text)) {
    return '연준·금리·물가 지표가 성장주 밸류에이션 부담 변수로 언급됩니다.';
  }
  if (/oil|geopolitical|middle east|china|tariff|sanction/.test(text)) {
    return '유가·지정학·정책 이슈가 섹터 순환과 위험 선호 변수로 언급됩니다.';
  }
  if (/dollar|dxy|fx/.test(text)) {
    return '달러지수 변화가 글로벌 위험자산 선호와 해외주식 수급 변수로 언급됩니다.';
  }
  return '해외 증시 관련 뉴스 이슈가 관측됐으며, 개장 후 선물·현물 반응 확인이 필요합니다.';
}

function formatEquityIssueTone(item, summary = '') {
  const text = `${summary || ''} ${item?.evidenceSummary || ''}`.toLowerCase();
  if (/주의|부담|하락|매도|경계|변동성 확대|risk-off|selloff|miss|drawdown|net selling/.test(text)) return '주의';
  if (/긍정|상승|순매수|강세|수급 지지|beat|rally|gain|net buy|inflow/.test(text)) return '긍정';
  return formatSignalDirectionLabel(item?.signalDirection);
}

function isInternalEquityEvidence(item) {
  const sourceText = [
    item?.sourceName,
    item?.source,
  ].filter(Boolean).join(' ');
  const joined = [
    item?.signalDirection,
    item?.evidenceSummary,
    item?.summary,
    item?.symbol,
  ].filter(Boolean).join(' ');
  return INTERNAL_EQUITY_SOURCE_RE.test(sourceText) && INTERNAL_EQUITY_EVIDENCE_RE.test(joined);
}

function buildEquityIssueRows(evidenceItems, category, fallbackSummary, limit = 3) {
  const rows = [];
  const seen = new Set();
  for (const item of (evidenceItems || [])) {
    if (isInternalEquityEvidence(item)) continue;
    const summary = category === 'overseas' ? formatOverseasIssueSummary(item) : formatKisIssueSummary(item);
    const key = summary.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const source = formatEquitySourceLabel(item.sourceName || item.source, category);
    const symbol = item.symbol ? `[${String(item.symbol).trim().toUpperCase()}] ` : '';
    const tone = formatEquityIssueTone(item, summary);
    rows.push(`${rows.length + 1}. ${symbol}${summary} (근거: ${source}, 해석: ${tone})`);
    if (rows.length >= limit) break;
  }
  while (rows.length < limit) {
    rows.push(`${rows.length + 1}. ${fallbackSummary[rows.length] || fallbackSummary[0]}`);
  }
  return rows;
}

function formatKrwNetBuy(value) {
  if (!hasValue(value)) return '미확인';
  const n = Number(value);
  if (!Number.isFinite(n)) return '미확인';
  return `${n > 0 ? '+' : ''}${Number(n / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}억원`;
}

function formatPointValue(value, suffix = 'pt') {
  if (!hasValue(value)) return '미확인';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `${n.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}${suffix}`;
}

function formatPercentOrUnknown(value) {
  const text = formatPercent(value);
  return text === '수집 대기' ? '미확인' : text;
}

function displayOr(text, fallback) {
  return !text || text === '미확인' || text === '수집 대기' ? fallback : text;
}

function readerValue(text, fallback) {
  const value = String(text || '').trim();
  if (!value || /N\/A|수집 대기|데이터 없음|미확인/i.test(value)) return fallback;
  return value;
}

function hasNumericValue(value) {
  return hasValue(value) && Number.isFinite(Number(value));
}

function isDeferredFlowText(text) {
  return /09:30 이후|장중 확인|순매수 방향 확인/.test(String(text || ''));
}

// ─── 헤드라인 생성 ────────────────────────────────────────────────

function buildCryptoTitle(slot, marketData) {
  const btcSymbol = displayMarketSymbol(marketData?.btc_symbol || 'BTC/USDT');
  const btcPrice = marketData?.btc_price
    ? `$${Number(marketData.btc_price).toLocaleString()}`
    : '시세';
  const btcChange = marketData?.btc_change_24h != null
    ? ` ${marketData.btc_change_24h > 0 ? '+' : ''}${Number(marketData.btc_change_24h).toFixed(1)}%`
    : '';
  const now = kst.now ? kst.now() : new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}/${dd} ${btcSymbol} 시황 카드 | ${btcPrice}${btcChange}`;
}

function buildKisTitle(marketData) {
  const kospi = marketData?.kospi_index ? `코스피 ${Number(marketData.kospi_index).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}` : '코스피';
  const kospiChange = marketData?.kospi_change != null
    ? ` ${marketData.kospi_change > 0 ? '+' : ''}${Number(marketData.kospi_change).toFixed(1)}%`
    : '';
  const now = kst.now ? kst.now() : new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}/${dd} 국내주식 시황 카드 | ${kospi}${kospiChange}`;
}

function buildOverseasTitle(marketData) {
  const sp500 = marketData?.sp500_index ? `S&P500 ${Number(marketData.sp500_index).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'S&P500';
  const sp500Change = marketData?.sp500_change != null
    ? ` ${marketData.sp500_change > 0 ? '+' : ''}${Number(marketData.sp500_change).toFixed(1)}%`
    : '';
  const now = kst.now ? kst.now() : new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}/${dd} 해외주식 시황 카드 | ${sp500}${sp500Change}`;
}

// ─── 시스템 프롬프트 ───────────────────────────────────────────────

function buildCryptoSystemPrompt() {
  return `당신은 Edu-X 금융교육 플랫폼의 암호화폐 전문 분석가입니다.
BTC/USDT 가격·기술·리스크 정보, 암호화폐 커뮤니티 이슈, 루나팀 자동매매 정보를 바탕으로 교육적이고 균형 잡힌 일일 브리핑을 작성합니다.

규칙:
- 분량은 자연스럽게 작성하고, 같은 말을 반복해 글자수를 채우지 말 것
- Edu-X 커뮤니티에 맞게 짧고 구체적인 6블록 시황 카드로 작성할 것
- 투자 권유 절대 금지 (교육 목적만)
- 단정적 표현 금지 ("반드시 오른다" 등)
- 첫 화면에 BTC/USDT 현재가, 24h 등락률, 지지·저항, 돌파/이탈 조건이 보이게 할 것
- 커뮤니티/뉴스 이슈는 실제 헤드라인형 문장 3개로 제시할 것
- 인공지능 추천안은 매수/매도 지시가 아니라 관찰 우선순위와 리스크 기준으로만 작성할 것
- 루나팀 자동매매는 아직 개발/테스트 중인 내부 자동화로 맨 아래 한 줄만 언급하고, 성과·권위·매매 추천처럼 표현하지 말 것
- 전문 용어는 간단한 설명 병기
- N/A, 수집 대기, 데이터 없음 같은 placeholder를 본문에 넣지 말 것
- Notion, activity 카테고리, 좋아요/댓글 지표는 언급하지 말 것`;
}

function buildKisSystemPrompt() {
  return `당신은 Edu-X 금융교육 플랫폼의 국내주식 전문 분석가입니다.
KIS WebSocket 데이터와 네이버 뉴스를 바탕으로 장 시작 전 브리핑을 작성합니다.

규칙:
- 분량은 자연스럽게 작성하고, 같은 말을 반복해 글자수를 채우지 말 것
- Edu-X 커뮤니티에 맞게 짧고 구체적인 6블록 시황 카드로 작성할 것
- 외인/기관 동향은 수치 중심으로 객관 서술
- 첫 화면에 코스피/코스닥, 환율, 외인/기관 수급, 오늘 볼 섹터가 보이게 할 것
- 커뮤니티/뉴스 이슈는 실제 헤드라인형 문장 3개로 제시할 것
- 인공지능 추천안은 매수/매도 지시가 아니라 관찰 우선순위와 리스크 기준으로만 작성할 것
- 투자 권유 절대 금지
- 공시/이벤트 일정은 KST 기준
- Notion, activity 카테고리, 좋아요/댓글 지표는 언급하지 말 것`;
}

function buildOverseasSystemPrompt() {
  return `당신은 Edu-X 금융교육 플랫폼의 해외주식 전문 분석가입니다.
루나팀 해외주식 데이터와 Reuters/Bloomberg 뉴스를 바탕으로 NY 개장 전 브리핑을 작성합니다.

규칙:
- 분량은 자연스럽게 작성하고, 같은 말을 반복해 글자수를 채우지 말 것
- Edu-X 커뮤니티에 맞게 짧고 구체적인 6블록 시황 카드로 작성할 것
- 첫 화면에 S&P500/Nasdaq, VIX/DXY, Magnificent 7 핵심 흐름이 보이게 할 것
- 커뮤니티/뉴스 이슈는 실제 헤드라인형 문장 3개로 제시할 것
- Magnificent 7 동향은 개별 종목 수치 포함
- 어닝 캘린더는 날짜/EPS 예상치 포함
- 인공지능 추천안은 매수/매도 지시가 아니라 관찰 우선순위와 리스크 기준으로만 작성할 것
- 투자 권유 절대 금지
- Notion, activity 카테고리, 좋아요/댓글 지표는 언급하지 말 것`;
}

// ─── 사용자 프롬프트 ──────────────────────────────────────────────

function buildCryptoUserPrompt(slot, marketData, evidenceItems, technicalData) {
  const slotLabel = { '0600': '오전 업데이트', '1400': '오후 업데이트', '2230': '심야 업데이트' }[slot] || '정기 업데이트';
  const now = kst.now ? kst.now() : new Date();
  const btcSymbol = displayMarketSymbol(marketData?.btc_symbol || 'BTC/USDT');
  const ethSymbol = displayMarketSymbol(marketData?.eth_symbol || 'ETH/USDT');
  const fearGreedText = formatScore(marketData?.fear_greed_index, marketData?.fear_greed_label, '0~100');

  const macroItems = [
    hasValue(marketData?.sp500) ? `- S&P500: ${marketData.sp500}` : null,
    hasValue(marketData?.nasdaq) ? `- Nasdaq: ${marketData.nasdaq}` : null,
    hasValue(marketData?.dxy) ? `- DXY: ${marketData.dxy}` : null,
    hasValue(marketData?.us10y) ? `- 미국 10년물: ${marketData.us10y}%` : null,
    hasValue(marketData?.fomc_hike_prob) ? `- FOMC 인상 확률: ${marketData.fomc_hike_prob}%` : null,
  ].filter(Boolean);
  const macroBlock = macroItems.length
    ? macroItems.join('\n')
    : '- 이번 암호화폐 슬롯은 거시 지표를 별도 수집하지 않고, 가격·거래량·커뮤니티·Fear & Greed를 우선 반영합니다.';

  const topIssues = (evidenceItems || [])
    .slice(0, 5)
    .map((e, i) => {
      const mentions = e.rawRef?.mentions != null ? `, 언급 ${e.rawRef.mentions}건` : '';
      const symbol = displayMarketSymbol(e.symbol || btcSymbol);
      const summary = formatCryptoIssueSummary(e, btcSymbol);
      return `${i + 1}. [${symbol}] [${formatCommunitySourceLabel(e.sourceName)}] ${summary} (해석: ${formatCryptoIssueTone(e, summary)}${mentions})`;
    })
    .join('\n');

  const altcoins = (marketData?.altcoins || [])
    .slice(0, 5)
    .map((a) => `${displayMarketSymbol(a.symbol)} | ${a.price ? '$' + Number(a.price).toFixed(2) : '-'} | ${a.change_24h != null ? (a.change_24h > 0 ? '+' : '') + Number(a.change_24h).toFixed(1) + '%' : '-'} | ${a.trigger || '-'}`)
    .join('\n');

  const todaySchedule = (marketData?.schedule || [])
    .slice(0, 4)
    .map((s) => `- ${s.time} KST: ${s.event}`)
    .join('\n');

  return `현재 시각: ${now.toLocaleString('ko-KR')} KST (${slotLabel})

🥇 1순위 — BTC/USDT 핵심 정보:
- ${btcSymbol} 가격: ${formatUsd(marketData?.btc_price)} (24h 등락률: ${formatPercent(marketData?.btc_change_24h)})
- Fear & Greed: ${fearGreedText}
- 기술지표(${btcSymbol} 1H): RSI ${formatScore(technicalData?.rsi, '', '0~100')}, MACD ${formatMacdValue(technicalData?.macd)}
- 지지선(USDT): ${formatUsd(technicalData?.support)} / 저항선(USDT): ${formatUsd(technicalData?.resistance)}
- 24h 거래대금(USDT): ${formatPlain(technicalData?.volume_24h)}

🥈 2순위 — 암호화폐 커뮤니티/뉴스 이슈:
${topIssues || `${btcSymbol} 관련 커뮤니티/뉴스 이슈가 충분히 수집되지 않았습니다.`}

🥉 3순위 — 루나팀 자동매매 정보:
- 루나팀 자동매매는 개발 및 테스트 중인 내부 자동화입니다.
- 게시글에서는 자동매매 판단을 권위 있는 근거로 쓰지 않고, 공개 데이터 해석을 보조하는 운영 메모로만 다룹니다.

📊 보조 시장 현황:
- ${ethSymbol} 가격: ${formatUsd(marketData?.eth_price)} (24h 등락률: ${formatPercent(marketData?.eth_change_24h)})
- 글로벌 시총: ${formatUsdCompact(marketData?.total_market_cap)}

🌐 거시 환경:
${macroBlock}

🏆 알트코인 워치 Top 5:
symbol | 가격(USDT) | 24h 등락률(%) | 트리거
${altcoins || 'SOL / XRP / AVAX / SUI / DOGE는 상위 거래량과 가격 반응을 다음 슬롯에서 재확인합니다.'}

📅 오늘 일정 (KST):
${todaySchedule || '일정 없음'}

---
위 데이터를 바탕으로 아래 6개 블록 구조로 게시글을 작성해주세요:

섹션 제목은 순번 없이 이모지로만 시작하세요. 예: "⚡ 핵심 3줄"

⚡ 핵심 3줄
📌 ${btcSymbol} 가격 지도
📈 상승/하락 시나리오
🌐 커뮤니티·뉴스 이슈 Top 3
🤖 인공지능 추천안
⚠️ 오늘 체크포인트 + 면책

첫 5줄 안에 현재가, 지지, 저항이 보여야 합니다. N/A, 수집 대기, 데이터 없음은 쓰지 마세요. 중복 문장 없이 자연스럽게 작성하세요.`;
}

function buildKisUserPrompt(marketData, evidenceItems) {
  const now = kst.now ? kst.now() : new Date();

  const topIssues = (evidenceItems || [])
    .slice(0, 5)
    .map((e, i) => `${i + 1}. ${e.evidenceSummary || ''} (출처: ${e.sourceName || 'unknown'})`)
    .join('\n');

  const sectorWatch = (marketData?.sectors || [])
    .slice(0, 3)
    .map((s) => `- ${s.name}: ${s.change_1d != null ? (s.change_1d > 0 ? '+' : '') + Number(s.change_1d).toFixed(1) + '%' : '장중 확인'}`)
    .join('\n');

  return `현재 시각: ${now.toLocaleString('ko-KR')} KST (국내장 09:00 30분 전)

📊 지수 현황:
- 코스피: ${marketData?.kospi_index || '장중 확인'} (${marketData?.kospi_change != null ? (marketData.kospi_change > 0 ? '+' : '') + Number(marketData.kospi_change).toFixed(1) + '%' : '등락률 장중 확인'})
- 코스닥: ${marketData?.kosdaq_index || '장중 확인'} (${marketData?.kosdaq_change != null ? (marketData.kosdaq_change > 0 ? '+' : '') + Number(marketData.kosdaq_change).toFixed(1) + '%' : '등락률 장중 확인'})
- 원/달러: ${marketData?.usd_krw ? `${marketData.usd_krw}원` : '환율 장중 확인'}

👁 외인/기관 동향 (어제 기준):
- 외인 순매수: ${marketData?.foreign_net_buy != null ? (marketData.foreign_net_buy > 0 ? '+' : '') + Number(marketData.foreign_net_buy / 1e8).toFixed(0) + '억원' : '09:30 이후 방향 확인'}
- 기관 순매수: ${marketData?.institution_net_buy != null ? (marketData.institution_net_buy > 0 ? '+' : '') + Number(marketData.institution_net_buy / 1e8).toFixed(0) + '억원' : '09:30 이후 방향 확인'}

📰 Top 5 뉴스/이슈:
${topIssues || '개장 전 확인된 공개 뉴스는 장중 수급 반응과 함께 보수적으로 해석합니다.'}

🏭 섹터 ETF 워치:
${sectorWatch || '반도체 / 2차전지 / 바이오는 장초반 거래대금과 수급 동조를 확인합니다.'}

📅 공시/이벤트:
${(marketData?.events || []).slice(0, 4).map((e) => `- ${e.time || ''}: ${e.event || ''}`).join('\n') || '없음'}

---
아래 6개 블록 구조로 국내주식 시황 카드를 작성해주세요:

섹션 제목은 순번 없이 이모지로만 시작하세요. 예: "⚡ 핵심 3줄"

⚡ 핵심 3줄
📌 지수·수급 지도
👀 오늘 볼 섹터
🌐 커뮤니티·뉴스 이슈 Top 3
🤖 인공지능 추천안
⚠️ 오늘 체크포인트 + 면책

N/A, 데이터 없음 같은 placeholder 없이 중복 문장 없이 자연스럽게 작성하세요.`;
}

function buildOverseasUserPrompt(marketData, evidenceItems) {
  const now = kst.now ? kst.now() : new Date();

  const topIssues = (evidenceItems || [])
    .slice(0, 5)
    .map((e, i) => `${i + 1}. ${e.evidenceSummary || ''} (출처: ${e.sourceName || 'unknown'})`)
    .join('\n');

  const mag7 = (marketData?.mag7 || [])
    .map((s) => `- ${s.symbol}: ${s.price ? '$' + s.price : '가격 장전 확인'} (${s.change_1d != null ? (s.change_1d > 0 ? '+' : '') + Number(s.change_1d).toFixed(1) + '%' : '등락률 장전 확인'})`)
    .join('\n');

  return `현재 시각: ${now.toLocaleString('ko-KR')} KST (NY 개장 30분 전)

📊 지수 현황:
- S&P500: ${marketData?.sp500_index || '장전 확인'} (${marketData?.sp500_change != null ? (marketData.sp500_change > 0 ? '+' : '') + Number(marketData.sp500_change).toFixed(1) + '%' : '등락률 장전 확인'})
- Nasdaq: ${marketData?.nasdaq_index || '장전 확인'} (${marketData?.nasdaq_change != null ? (marketData.nasdaq_change > 0 ? '+' : '') + Number(marketData.nasdaq_change).toFixed(1) + '%' : '등락률 장전 확인'})
- DXY: ${marketData?.dxy || '장전 확인'} | VIX: ${marketData?.vix || '장전 확인'}

🏆 Magnificent 7 동향 ⭐:
${mag7 || 'AAPL/MSFT/GOOGL/AMZN/NVDA/META/TSLA는 정규장 초반 동조 여부를 확인합니다.'}

📰 Top 5 이슈:
${topIssues || '장전 확인된 공개 뉴스는 선물과 정규장 거래량 반응으로 검증합니다.'}

📅 어닝 캘린더:
${(marketData?.earnings || []).slice(0, 4).map((e) => `- ${e.date} ${e.symbol}: EPS 예상 ${e.eps_est || '확인 전'}`).join('\n') || '주요 어닝 일정은 장전 업데이트에서 확인합니다.'}

---
아래 6개 블록 구조로 해외주식 시황 카드를 작성해주세요:

섹션 제목은 순번 없이 이모지로만 시작하세요. 예: "⚡ 핵심 3줄"

⚡ 핵심 3줄
📌 지수·리스크 지도
💎 Magnificent 7·섹터 지도
🌐 커뮤니티·뉴스 이슈 Top 3
🤖 인공지능 추천안
⚠️ 오늘 체크포인트 + 면책

N/A, 데이터 없음 같은 placeholder 없이 중복 문장 없이 자연스럽게 작성하세요.`;
}

// ─── 품질 게이트/폴백 ─────────────────────────────────────────────

function validateContentQuality(content, category = null) {
  const text = String(content || '');
  const sectionValidation = resolveSectionValidation(text, category);
  const sectionCount = sectionValidation.headings.length;
  const requiredSectionCount = requiredSectionCountFor(sectionValidation.category);
  const infoIssues = sectionValidation.category === 'crypto' ? validateCryptoInformationDensity(text) : [];
  const forbidden = FORBIDDEN_PATTERNS.filter((item) => item.re.test(text)).map((item) => item.key);
  return {
    ok: text.length >= TARGET_MIN_LEN && sectionCount >= requiredSectionCount && sectionValidation.missingSections.length === 0 && infoIssues.length === 0 && forbidden.length === 0,
    contentLen: text.length,
    sectionCount,
    category: sectionValidation.category,
    missingSections: [
      ...(sectionCount >= requiredSectionCount ? [] : [`section_count:${sectionCount}/${requiredSectionCount}`]),
      ...sectionValidation.missingSections,
    ],
    infoIssues,
    forbidden,
  };
}

function bulletList(items, fallback, options = {}) {
  const rows = (items || []).slice(0, 5).map((item, index) => {
    const summary = item.evidenceSummary || item.summary || fallback;
    const source = item.sourceName || item.source || 'luna';
    const symbol = options.marketSymbols && item.symbol ? `[${displayMarketSymbol(item.symbol)}] ` : '';
    return `${index + 1}. ${symbol}${summary} (출처: ${source})`;
  });
  return rows.length ? rows.join('\n') : `1. ${fallback}\n2. 수치가 확인되는 항목만 선별합니다.\n3. 변동성 확대 구간에서는 포지션 크기를 보수적으로 해석합니다.`;
}

function padToMinLength(content, category) {
  let text = String(content || '').trim();
  const categoryLabel = { crypto: '암호화폐', kis: '국내주식', overseas: '해외주식' }[category] || '시장';
  const appendBeforeDisclaimer = (current, addition) => {
    const marker = '\n\n⚠️ ';
    const index = current.indexOf(marker);
    if (index === -1) return `${current}\n\n${addition}`;
    return `${current.slice(0, index)}\n\n${addition}${current.slice(index)}`;
  };
  const additions = [
    `운영 해석: 이번 ${categoryLabel} 브리핑은 단기 방향을 단정하지 않고 루나팀이 수집한 가격, 수급, 커뮤니티 언급, 이벤트 일정을 교육용 관점으로 분리해 해석합니다. 단일 지표가 강해도 후속 거래량과 변동성 확인이 없으면 신호 신뢰도는 낮게 보는 것이 안전합니다.`,
    '리스크 기준: 한 가지 신호만 강할 때보다 거래량, 추세, 일정, 변동성 지표가 함께 확인될 때 신뢰도가 높아집니다. 신호가 엇갈리면 관망 또는 비중 축소 관점이 더 합리적이며, 자동 분석도 보류 판단을 정상 운영 결과로 취급해야 합니다.',
    '활용 방법: 본문은 매수·매도 지시가 아니라 체크리스트입니다. 독자는 자신의 투자 목적, 손실 감내 범위, 보유 기간에 맞춰 별도 판단해야 하며 자동 분석 결과는 참고 자료로만 사용해야 합니다.',
    '데이터 한계: 일부 지표가 비어 있을 때는 결론을 강화하지 않습니다. 확인되지 않은 값은 모르는 값으로 남겨 두고, 다음 슬롯에서 데이터가 보강되는지 비교하는 방식이 더 정확합니다.',
    '검증 관점: 같은 방향의 신호가 여러 출처에서 반복될 때만 해석 강도를 높입니다. 가격만 움직이고 수급이나 일정 근거가 약하면 이벤트성 노이즈일 가능성도 함께 열어 둡니다.',
    '운영 메모: 자동 작성 콘텐츠는 빠른 현황 파악을 돕기 위한 요약입니다. 실제 의사결정에는 원문 데이터, 체결 환경, 개인별 리스크 한도 확인이 필요합니다.',
  ];
  let index = 0;
  while (text.length < TARGET_MIN_LEN && index < additions.length) {
    text = appendBeforeDisclaimer(text, additions[index]);
    index += 1;
  }
  while (text.length < TARGET_MIN_LEN) {
    text = appendBeforeDisclaimer(text, '보충 메모: 다음 슬롯에서는 신규 가격, 거래량, 수급, 일정 데이터를 다시 대조해 현재 판단의 유지 여부를 확인합니다.');
  }
  return text;
}

function buildCryptoFallbackContent(slot, marketData = {}, evidenceItems = {}, technicalData = {}) {
  const btcSymbol = displayMarketSymbol(marketData?.btc_symbol || 'BTC/USDT');
  const ethSymbol = displayMarketSymbol(marketData?.eth_symbol || 'ETH/USDT');
  const price = readerValue(formatUsd(marketData?.btc_price), `${btcSymbol} 가격은 다음 슬롯에서 재확인`);
  const change = readerValue(formatPercent(marketData?.btc_change_24h), '24h 흐름은 다음 슬롯에서 재확인');
  const ethPrice = readerValue(formatUsd(marketData?.eth_price), `${ethSymbol} 가격은 다음 슬롯에서 재확인`);
  const ethChange = readerValue(formatPercent(marketData?.eth_change_24h), '24h 흐름은 다음 슬롯에서 재확인');
  const ethLine = `${ethSymbol} ${ethPrice} (${ethChange})`;
  const fearGreed = readerValue(formatScore(marketData?.fear_greed_index, marketData?.fear_greed_label, '0~100'), '시장 심리는 다음 슬롯에서 재확인');
  const support = readerValue(formatUsd(technicalData?.support), '최근 지지 구간은 차트에서 재확인');
  const resistance = readerValue(formatUsd(technicalData?.resistance), '최근 저항 구간은 차트에서 재확인');
  const volume24h = readerValue(formatPlain(technicalData?.volume_24h), '24h 거래대금은 다음 슬롯에서 재확인');
  const rsi = readerValue(formatScore(technicalData?.rsi, '', '0~100'), 'RSI는 다음 슬롯에서 재확인');
  const macd = readerValue(formatMacdValue(technicalData?.macd), 'MACD는 다음 슬롯에서 재확인');
  const issueRows = [];
  const seenIssueSummaries = new Set();
  for (const item of (evidenceItems || [])) {
    const symbol = displayMarketSymbol(item.symbol || btcSymbol);
    const source = formatCommunitySourceLabel(item.sourceName);
    const summary = formatCryptoIssueSummary(item, btcSymbol);
    const summaryKey = summary.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seenIssueSummaries.has(summaryKey)) continue;
    seenIssueSummaries.add(summaryKey);
    const direction = formatCryptoIssueTone(item, summary);
    issueRows.push(`${issueRows.length + 1}. [${symbol}] ${summary} (근거: ${source}, 해석: ${direction})`);
    if (issueRows.length >= 3) break;
  }
  while (issueRows.length < 3) {
    const fallbackIssue = [
      `${btcSymbol}가 ${support} 지지와 ${resistance} 저항 사이에서 다음 방향을 대기 중입니다.`,
      `Fear & Greed ${fearGreed}와 24h 거래대금 ${volume24h} USDT가 단기 심리 확인 지표입니다.`,
      `${ethLine} 흐름은 알트코인 위험 선호를 확인하는 보조 지표입니다.`,
    ][issueRows.length];
    issueRows.push(`${issueRows.length + 1}. ${fallbackIssue}`);
  }
  const scheduleRows = (marketData?.schedule || [])
    .slice(0, 2)
    .map((item) => `- ${item.time} KST: ${item.event}`)
    .join('\n');

  const body = `⚡ 핵심 3줄
- ${btcSymbol} 현재가 ${price}, 24h ${change}. 지금은 ${support} 지지와 ${resistance} 저항 사이의 결정 구간입니다.
- 상승 쪽은 ${resistance} 회복·안착이 먼저이고, 하락 쪽은 ${support} 이탈 여부가 핵심입니다.
- 커뮤니티 이슈는 BTC/USDT 가격 반응을 먼저 확인한 뒤 보조 근거로만 봅니다.

📌 ${btcSymbol} 가격 지도
• 현재가: ${price} / 24h 등락률: ${change}
• 1차 지지: ${support} / 1차 저항: ${resistance}
• RSI: ${rsi} / MACD: ${macd}
• 24h 거래대금: ${volume24h} (USDT 기준) / Fear & Greed: ${fearGreed}
• 보조 체크: ${ethLine}

📈 상승/하락 시나리오
상승 시나리오: ${resistance} 위로 1시간봉이 안착하면 단기 매도 압력이 줄고, 다음 저항 확인 구간으로 이동할 수 있습니다. 이 경우 추격보다 돌파 후 되돌림에서 거래량이 유지되는지가 중요합니다.
하락 시나리오: ${support} 아래로 종가가 밀리면 지지 실패로 보고 변동성 확대를 경계해야 합니다. 무효화 기준은 ${support} 재이탈이며, 이탈 후 빠른 회복이 없으면 방어적 해석이 우선입니다.

🌐 커뮤니티·뉴스 이슈 Top 3
${issueRows.join('\n')}

🤖 인공지능 추천안
- 우선 관찰: ${btcSymbol}가 ${support} 위에서 버티고 ${resistance}에 재도전하는지 먼저 봅니다.
- 긍정 조건: ${resistance} 돌파 후 거래대금이 유지되면 단기 위험 선호가 살아난 것으로 해석합니다.
- 방어 조건: ${support} 재이탈 또는 MACD 약화가 겹치면 추격보다 관망이 더 합리적입니다.
- 루나 자동화 메모: 현재 추천안은 공개 데이터 기반 교육용 체크리스트이며, 자동매매 성과나 매매 지시가 아닙니다.

⚠️ 오늘 체크포인트 + 면책
${scheduleRows || `- ${btcSymbol} ${support} 지지 유지 여부\n- ${btcSymbol} ${resistance} 회복 여부`}
- 루나팀 자동화는 내부 개발/테스트 중인 보조 수집 시스템이며, 공개 글의 판단 근거는 ${btcSymbol} 가격·기술 지표·커뮤니티 이슈입니다.
- 본 글은 Edu-X 커뮤니티용 자동 작성 교육 콘텐츠이며 투자 권유가 아닙니다. 실제 투자 판단과 책임은 독자에게 있습니다.
#EduX #BTC #Bitcoin #BTC_USDT #시장브리핑`;

  return body.trim();
}

function buildKisFallbackContent(marketData = {}, evidenceItems = {}) {
  const issueRows = buildEquityIssueRows(evidenceItems, 'kis', [
    '원/달러 환율과 미국 선물 흐름은 외국인 대형주 수급의 첫 번째 체크포인트입니다.',
    '반도체·HBM은 코스피 방향을 설명하는 핵심 업종으로, 대형주 거래대금 동반 여부가 중요합니다.',
    '2차전지·바이오 등 성장주는 지수보다 거래대금과 개별 재료 반응을 우선 확인합니다.',
  ]);
  const sectorWatch = (marketData?.sectors || [])
    .filter((item) => hasNumericValue(item.change_1d ?? item.change))
    .slice(0, 5)
    .map((item, index) => {
      const change = item.change_1d ?? item.change;
      const direction = Number(change) > 0 ? '강세 확인' : Number(change) < 0 ? '방어적 관찰' : '방향 확인';
      return `${index + 1}. ${item.name}: ${formatPercentOrUnknown(change)} — ${direction}`;
    })
    .join('\n');
  const events = (marketData?.events || [])
    .slice(0, 4)
    .map((item) => `- ${item.time || '시간 미정'} KST: ${item.event || item.title || '일정 확인'}`)
    .join('\n');
  const kospi = displayOr(formatPointValue(marketData?.kospi_index), '코스피 실시간 지수는 장중 확인');
  const kosdaq = displayOr(formatPointValue(marketData?.kosdaq_index), '코스닥 실시간 지수는 장중 확인');
  const kospiChange = displayOr(formatPercentOrUnknown(marketData?.kospi_change), '전일 대비 흐름 장중 확인');
  const kosdaqChange = displayOr(formatPercentOrUnknown(marketData?.kosdaq_change), '전일 대비 흐름 장중 확인');
  const usdKrw = hasValue(marketData?.usd_krw) ? `${Number(marketData.usd_krw).toLocaleString('ko-KR')}원` : '환율 실시간 값은 장중 확인';
  const foreignFlow = displayOr(formatKrwNetBuy(marketData?.foreign_net_buy), '09:30 이후 순매수 방향 확인');
  const institutionFlow = displayOr(formatKrwNetBuy(marketData?.institution_net_buy), '09:30 이후 순매수 방향 확인');
  const flowLine = isDeferredFlowText(foreignFlow) && isDeferredFlowText(institutionFlow)
    ? '외국인·기관 수급은 09:30 이후 순매수 방향을 확인해야 합니다. 두 주체가 같은 방향인지가 지수 신뢰도 핵심입니다.'
    : `수급은 외국인 ${foreignFlow}, 기관 ${institutionFlow}. 두 주체가 같은 방향인지가 지수 신뢰도 핵심입니다.`;
  const leadSector = (marketData?.sectors || [])
    .filter((item) => hasNumericValue(item.change_1d ?? item.change))
    .slice()
    .sort((a, b) => Number(b.change_1d ?? b.change ?? -999) - Number(a.change_1d ?? a.change ?? -999))[0];
  const leadSectorText = leadSector
    ? `${leadSector.name} ${formatPercentOrUnknown(leadSector.change_1d ?? leadSector.change)}`
    : '반도체·HBM, 2차전지, 바이오 중 거래대금 우위 섹터';

  return `⚡ 핵심 3줄
- 코스피 ${kospi} (${kospiChange}), 코스닥 ${kosdaq} (${kosdaqChange}). 원·달러는 ${usdKrw}입니다.
- ${flowLine}
- 오늘은 ${leadSectorText}를 먼저 보고, 뉴스는 실제 수급 반응으로 확인합니다.

📌 지수·수급 지도
• 코스피: ${kospi} (${kospiChange})
• 코스닥: ${kosdaq} (${kosdaqChange})
• 원·달러 환율: ${usdKrw}
• 외국인 순매수: ${foreignFlow}
• 기관 순매수: ${institutionFlow}
• 해석 기준: 지수 상승 + 외국인/기관 동반 순매수면 추세 신뢰도를 높이고, 지수 상승 + 수급 엇갈림이면 섹터 순환매로 봅니다.

👀 오늘 볼 섹터
${sectorWatch || '1. 반도체·HBM: 코스피 대형주와 외국인 수급 동반 여부 확인\n2. 2차전지: 코스닥 성장주 거래대금 회복 여부 확인\n3. 바이오: 개별 재료와 지수 변동성 확대 여부 확인'}
섹터는 등락률보다 대형주 동조, 거래대금 증가, 외국인 수급 지속성을 같이 확인합니다.

🌐 커뮤니티·뉴스 이슈 Top 3
${issueRows.join('\n')}
이슈는 방향을 단정하는 재료가 아니라 개장 후 어느 섹터에 돈이 붙는지 확인하기 위한 관찰 목록입니다.

🤖 인공지능 추천안
- 우선순위: 지수보다 외국인·기관 수급과 ${leadSectorText}의 거래대금 동조를 먼저 확인합니다.
- 긍정 조건: 코스피/코스닥 상승과 외국인 순매수가 함께 나오면 주도 섹터 쪽 해석 강도를 높입니다.
- 방어 조건: 지수는 오르는데 수급이 엇갈리면 장초반 추격보다 10:00 이후 재확인이 낫습니다.
- 루나 자동화 메모: 추천안은 국내주식 데이터 수집 기반 교육용 체크리스트이며, 매수·매도 지시가 아닙니다.

⚠️ 오늘 체크포인트 + 면책
${events || '- 09:00 KST: 시초가 갭과 장초반 거래대금 확인\n- 09:30 KST: 외국인·기관 순매수 방향 확인'}
- 루나팀 자동화는 국내주식 데이터 수집과 브리핑 보조를 위한 개발·테스트 중인 내부 시스템입니다.
- 본 글은 Edu-X 커뮤니티용 자동 작성 교육 콘텐츠이며 투자 권유가 아닙니다. 실제 투자 판단과 책임은 독자에게 있습니다.
#EduX #국내주식 #코스피 #코스닥 #장전시황`;
}

function buildOverseasFallbackContent(marketData = {}, evidenceItems = {}) {
  const issueRows = buildEquityIssueRows(evidenceItems, 'overseas', [
    'S&P500·Nasdaq 방향은 장전 선물과 정규장 초반 대형주 반응을 함께 확인합니다.',
    'VIX·DXY·금리 흐름은 성장주와 대형 기술주 밸류에이션의 보조 변수입니다.',
    '실적·가이던스 이벤트는 개별 종목뿐 아니라 같은 섹터 ETF 반응까지 같이 봅니다.',
  ]);
  const mag7 = (marketData?.mag7 || [])
    .filter((item) => hasNumericValue(item.price) || hasNumericValue(item.change_1d))
    .slice(0, 7)
    .map((item, index) => `${index + 1}. ${item.symbol}: ${hasValue(item.price) ? `$${Number(item.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '가격 장중 확인'} (${displayOr(formatPercentOrUnknown(item.change_1d), '등락률 장중 확인')})`)
    .join('\n');
  const etfs = (marketData?.top_etfs || [])
    .slice(0, 5)
    .map((item) => {
      if (hasValue(item.change_1d)) return `- ${item.symbol}: ${formatPercentOrUnknown(item.change_1d)}`;
      if (hasValue(item.price)) return `- ${item.symbol}: $${Number(item.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      if (hasValue(item.market_cap)) return `- ${item.symbol}: 시총/규모 ${item.market_cap}`;
      return `- ${item.symbol}: 정규장 초반 흐름 확인`;
    })
    .join('\n');
  const earnings = (marketData?.earnings || [])
    .slice(0, 4)
    .map((item) => `- ${item.date || '일정 미정'} ${item.symbol || ''}: EPS 예상 ${item.eps_est || '확인 전'}`)
    .join('\n');
  const sp500 = displayOr(formatPointValue(marketData?.sp500_index), 'S&P500 지수는 장전 확인');
  const nasdaq = displayOr(formatPointValue(marketData?.nasdaq_index), 'Nasdaq 지수는 장전 확인');
  const sp500Change = displayOr(formatPercentOrUnknown(marketData?.sp500_change), '등락률 장전 확인');
  const nasdaqChange = displayOr(formatPercentOrUnknown(marketData?.nasdaq_change), '등락률 장전 확인');
  const vix = hasValue(marketData?.vix) ? String(marketData.vix) : '장전 확인';
  const dxy = hasValue(marketData?.dxy) ? String(marketData.dxy) : '장전 확인';
  const strongestMag7 = (marketData?.mag7 || [])
    .filter((item) => hasNumericValue(item.change_1d))
    .slice()
    .sort((a, b) => Number(b.change_1d ?? -999) - Number(a.change_1d ?? -999))[0];
  const strongestMag7Text = strongestMag7
    ? `${strongestMag7.symbol} ${formatPercentOrUnknown(strongestMag7.change_1d)}`
    : 'NVDA/MSFT/AAPL 등 대형 기술주 정규장 반응';

  return `⚡ 핵심 3줄
- S&P500 ${sp500} (${sp500Change}), Nasdaq ${nasdaq} (${nasdaqChange}). VIX ${vix}, DXY ${dxy}도 함께 봅니다.
- Magnificent 7에서는 ${strongestMag7Text}가 첫 확인 대상입니다. 지수보다 대형주 동조가 더 중요합니다.
- 장전 뉴스는 선물 반응만으로 단정하지 않고, 정규장 초반 거래량과 섹터 ETF 반응으로 검증합니다.

📌 지수·리스크 지도
• S&P500: ${sp500} (${sp500Change})
• Nasdaq: ${nasdaq} (${nasdaqChange})
• VIX: ${vix}
• DXY: ${dxy}
• 해석 기준: Nasdaq이 S&P500보다 강하고 VIX가 낮으면 성장주 위험 선호, 지수 상승에도 VIX가 오르면 방어적 수요를 같이 봅니다.

💎 Magnificent 7·섹터 지도
${mag7 || '1. NVDA: 정규장 반응 확인\n2. MSFT: 클라우드·AI 수요 확인\n3. AAPL: 소비재 대형주 방어력 확인'}
섹터 ETF:
${etfs || '- QQQ: 기술주 위험 선호 확인\n- XLK: 대형 기술주 동조 확인\n- XLE: 유가·에너지 민감도 확인'}

🌐 커뮤니티·뉴스 이슈 Top 3
${issueRows.join('\n')}
해외 이슈는 지수와 섹터에 어떤 경로로 반영되는지 확인해야 합니다. 헤드라인만으로 방향을 단정하지 않습니다.

🤖 인공지능 추천안
- 우선순위: S&P500보다 Nasdaq과 Magnificent 7 동조가 강한지 먼저 봅니다.
- 긍정 조건: ${strongestMag7Text}가 지수 상승을 같이 끌고 VIX가 안정되면 성장주 위험 선호를 우선 해석합니다.
- 방어 조건: 지수 상승에도 VIX가 오르거나 DXY가 급등하면 대형주 추격보다 리스크 점검이 먼저입니다.
- 루나 자동화 메모: 추천안은 해외주식 데이터 수집 기반 교육용 체크리스트이며, 매수·매도 지시가 아닙니다.

⚠️ 오늘 체크포인트 + 면책
${earnings || '- NY 개장 전 선물 방향 확인\n- 정규장 초반 Magnificent 7 동조 여부 확인'}
- 루나팀 자동화는 해외주식 데이터 수집과 브리핑 보조를 위한 개발·테스트 중인 내부 시스템입니다.
- 본 글은 Edu-X 커뮤니티용 자동 작성 교육 콘텐츠이며 투자 권유가 아닙니다. 실제 투자 판단과 책임은 독자에게 있습니다.
#EduX #해외주식 #미국증시 #SP500 #Nasdaq`;
}

function buildFallbackContent(category, slot, marketData = {}, evidenceItems = {}, technicalData = {}) {
  if (category === 'crypto') return buildCryptoFallbackContent(slot, marketData, evidenceItems, technicalData);
  if (category === 'kis') return buildKisFallbackContent(marketData, evidenceItems);
  if (category === 'overseas') return buildOverseasFallbackContent(marketData, evidenceItems);
  return buildCryptoFallbackContent(slot, marketData, evidenceItems, technicalData);
}

async function callFormatterLlm({ category, systemPrompt, userPrompt, options = {} }) {
  const llmConfig = resolveFormatterLlmConfig(category, options);
  const policyOverride = resolveFormatterPolicyOverride(llmConfig, options);
  return await callHubLlm({
    callerTeam: llmConfig.callerTeam,
    agent: llmConfig.agent,
    selectorKey: llmConfig.selectorKey,
    abstractModel: llmConfig.abstractModel,
    systemPrompt,
    prompt: userPrompt,
    maxTokens: llmConfig.maxTokens,
    temperature: llmConfig.temperature,
    timeoutMs: llmConfig.timeoutMs,
    taskType: `edux_market_post_${category}`,
    cacheEnabled: false,
    policyOverride,
  });
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
async function formatPost(category, slot, marketData, evidenceItems, technicalData = {}, options = {}) {
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

  if (options.fixture || process.env.EDUX_FORMATTER_FIXTURE === 'true') {
    const content = normalizeSectionHeadingNumbers(buildFallbackContent(category, slot, marketData, evidenceItems, technicalData));
    return { title, content, source: 'fixture_fallback' };
  }

  const llmConfig = resolveFormatterLlmConfig(category, options);
  if (llmConfig.mode !== 'llm') {
    const content = normalizeSectionHeadingNumbers(buildFallbackContent(category, slot, marketData, evidenceItems, technicalData));
    return { title, content, source: `${category}_deterministic`, formatterMode: llmConfig.mode };
  }

  let content = null;
  let quality = null;
  let source = 'hub_llm';
  let lastLlmResponse = null;
  let lastLlmError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let llmResp;
    try {
      const prompt = attempt === 0
        ? userPrompt
        : category === 'crypto'
          ? `${userPrompt}\n\n이전 응답이 품질 게이트를 통과하지 못했습니다. 반드시 순번 없이 이모지로 시작하는 6개 블록을 모두 포함하고, BTC/USDT 현재가·지지·저항·상승/하락 시나리오·무효화 조건·커뮤니티/뉴스 이슈·인공지능 추천안을 구체적으로 작성하세요. N/A/수집 대기/데이터 없음과 Notion/activity/좋아요/댓글 언급은 제외하세요.`
          : `${userPrompt}\n\n이전 응답이 품질 게이트를 통과하지 못했습니다. 반드시 순번 없이 이모지로 시작하는 6개 블록을 모두 포함하고, 중복 문장 없이 지수·수급·섹터·커뮤니티/뉴스 이슈·인공지능 추천안을 구체적으로 작성하며, Notion/activity/좋아요/댓글 언급은 제외하세요.`;
      llmResp = await callFormatterLlm({ category, systemPrompt, userPrompt: prompt, options });
      lastLlmResponse = llmResp;
    } catch (err) {
      console.error('[edu-x/formatter] callHubLlm 예외:', err?.message);
      lastLlmError = err?.message || String(err);
      break;
    }

    if (!llmResp?.ok || !llmResp?.text) {
      console.error('[edu-x/formatter] LLM 응답 실패:', llmResp?.error);
      lastLlmError = llmResp?.error || 'empty_llm_response';
      continue;
    }

    content = normalizeSectionHeadingNumbers(llmResp.text);
    if (content.length > MAX_CONTENT_LEN) content = content.slice(0, MAX_CONTENT_LEN);
    quality = validateContentQuality(content, category);
    if (quality.ok) break;
    console.warn(`[edu-x/formatter] 품질 미달 attempt=${attempt + 1}: ${JSON.stringify(quality)}`);
  }

  if (!content || !quality?.ok) {
    source = 'fallback_after_quality_gate';
    content = normalizeSectionHeadingNumbers(buildFallbackContent(category, slot, marketData, evidenceItems, technicalData));
    quality = validateContentQuality(content, category);
  }

  return {
    title,
    content,
    quality,
    source,
    formatterMode: llmConfig.mode,
    llm: {
      requested: llmConfig,
      used: source === 'hub_llm',
      provider: lastLlmResponse?.provider || null,
      model: lastLlmResponse?.model || null,
      selectedRoute: lastLlmResponse?.selected_route || null,
      fallbackCount: lastLlmResponse?.fallbackCount ?? null,
      traceId: lastLlmResponse?.traceId || null,
      error: lastLlmError,
      policyOverrideEnabled: Boolean(resolveFormatterPolicyOverride(llmConfig, options)),
    },
  };
}

module.exports = {
  formatPost,
  validateContentQuality,
  buildFallbackContent,
  buildCryptoTitle,
  buildKisTitle,
  buildOverseasTitle,
  displayMarketSymbol,
  resolveFormatterMode,
  resolveFormatterLlmConfig,
  resolveFormatterPolicyOverride,
};
