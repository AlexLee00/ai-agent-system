// @ts-nocheck
/**
 * team/scout-scraper.js — 스카우트 전용 토스 시장 스크레이퍼
 *
 * 역할:
 *   - 토스증권/시장 페이지에서 스카우트 시그널 후보를 수집
 *   - dry-run에서는 안정적인 mock 데이터로 소프트 테스트 지원
 *
 * 실행:
 *   node team/scout-scraper.js --dry-run --json
 */

import { createRequire } from 'module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const BASE_URL = process.env.SCOUT_BASE_URL || 'https://tossinvest.com';
const DEFAULT_TARGET_URL = `${BASE_URL}/`;
const DEFAULT_SCREENER_URL = process.env.SCOUT_SCREENER_URL || `${BASE_URL}/screener`;
const DEFAULT_CALENDAR_URL = process.env.SCOUT_CALENDAR_URL || `${BASE_URL}/calendar`;
const DEFAULT_TIMEOUT_MS = Number(process.env.SCOUT_TIMEOUT_MS || 30000);
const DEFAULT_USER_AGENT = process.env.SCOUT_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactEvidence(value, max = 220) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function isNoiseText(value) {
  const text = normalizeText(value);
  if (!text) return true;
  if (text.length < 2) return true;
  if (text.length > 500) return true;
  return [
    '지원하지 않는 브라우저',
    '크롬 또는 엣지 최신 버전',
    '아이패드OS를 최신 버전',
    '[data-radix-scroll-area-viewport]',
    'scrollbar-width:none',
    '::-webkit-scrollbar',
    'function ()',
    'ApplePaySession',
    'contain-intrinsic-width',
    '개인정보 처리방침',
    '고객센터 1599-7987',
  ].some((token) => text.includes(token));
}

function uniqueTexts(values, limit = 50) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = normalizeText(raw);
    if (isNoiseText(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function buildMockPayload(limit = 10) {
  const items = [
    'AI 시그널 강세 종목: 삼성전자, SK하이닉스, 네이버',
    '오늘의 TOP 10 거래대금: 삼성전자, 한화오션, 두산에너빌리티',
    '실적 캘린더 관심 종목: LG에너지솔루션, 현대차',
    '스크리너 전략: 신고가 돌파, 거래량 급증, 기관 수급 집중',
    '토론실 인기 종목: 카카오, 하이브, 에코프로비엠',
    '섹터 모멘텀: 반도체, AI 인프라, 전력설비',
  ].slice(0, Math.max(1, limit));

  const sections = {
    strategies: items.filter((line) => /스크리너|돌파|거래량|수급/.test(line)),
    aiSignals: items.filter((line) => /AI 시그널/.test(line)),
    calendar: items.filter((line) => /캘린더|실적/.test(line)),
    top10: items.filter((line) => /TOP 10|거래대금/.test(line)),
    community: items.filter((line) => /토론실|인기 종목/.test(line)),
    sectors: items.filter((line) => /섹터|모멘텀/.test(line)),
  };

  return {
    source: 'mock',
    fetchedAt: new Date().toISOString(),
    targetUrl: DEFAULT_TARGET_URL,
    urls: {
      home: DEFAULT_TARGET_URL,
      screener: DEFAULT_SCREENER_URL,
      calendar: DEFAULT_CALENDAR_URL,
    },
    sections,
    signals: [
      { symbol: '005930', market: 'domestic', label: '삼성전자', source: 'aiSignals', score: 0.82 },
      { symbol: '000660', market: 'domestic', label: 'SK하이닉스', source: 'strategies', score: 0.79 },
      { symbol: '035420', market: 'domestic', label: 'NAVER', source: 'calendar', score: 0.74 },
    ],
  };
}

async function collectPageTexts(page, url, {
  waitForSelector = null,
  limit = 220,
} = {}) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT_MS });
  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout: 8000 }).catch(() => {});
  }
  await sleep(1200);
  return page.evaluate((maxItems) => {
    const textOf = (value) => String(value?.textContent || '').replace(/\s+/g, ' ').trim();
    const bodyLines = String(document.body?.innerText || '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, maxItems);
    const texts = [
      ...Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"],button,a,li,span,strong,p,td,th,div')),
    ]
      .map(textOf)
      .filter(Boolean)
      .slice(0, maxItems);
    return {
      title: document.title || '',
      bodyLines,
      texts,
    };
  }, limit);
}

function inferSignalSource(line, sections = {}) {
  const text = normalizeText(line);
  for (const [source, values] of Object.entries(sections)) {
    if ((Array.isArray(values) ? values : []).some((item) => normalizeText(item) === text || normalizeText(item).includes(text) || text.includes(normalizeText(item)))) {
      return source;
    }
  }
  return 'scan';
}

function extractSignalsFromTexts(lines = [], sections = {}) {
  const patterns = [
    { symbol: '005930', label: '삼성전자', market: 'domestic', re: /삼성전자/i },
    { symbol: '000660', label: 'SK하이닉스', market: 'domestic', re: /SK하이닉스/i },
    { symbol: '035420', label: 'NAVER', market: 'domestic', re: /\bNAVER\b/i },
    { symbol: '005380', label: '현대차', market: 'domestic', re: /현대차/i },
    { symbol: '034020', label: '두산에너빌리티', market: 'domestic', re: /두산에너빌리티/i },
    { symbol: '042660', label: '한화오션', market: 'domestic', re: /한화오션/i },
    { symbol: '000815', label: '삼성E&A', market: 'domestic', re: /삼성E&A/i },
    { symbol: '000250', label: '삼천당제약', market: 'domestic', re: /삼천당제약/i },
    { symbol: 'BTC/USDT', label: 'BTC', market: 'crypto', re: /\bBTC\b|비트코인/i },
    { symbol: 'ETH/USDT', label: 'ETH', market: 'crypto', re: /\bETH\b|이더리움/i },
    { symbol: 'NVDA', label: 'NVIDIA', market: 'overseas', re: /\bNVDA\b|NVIDIA/i },
    { symbol: 'TSLA', label: 'Tesla', market: 'overseas', re: /\bTSLA\b|Tesla/i },
  ];

  const signals = [];
  for (const candidate of patterns) {
    const hit = (Array.isArray(lines) ? lines : []).find((line) => candidate.re.test(line));
    if (!hit) continue;
    const source = inferSignalSource(hit, sections);
    signals.push({
      symbol: candidate.symbol,
      market: candidate.market,
      label: candidate.label,
      source,
      score: source === 'aiSignals' ? 0.84 : source === 'top10' ? 0.76 : source === 'scan' ? 0.7 : 0.68,
      evidence: compactEvidence(hit),
    });
  }

  return signals;
}

function classifySections(lines = []) {
  const normalized = uniqueTexts(lines, 120);
  return {
    strategies: normalized.filter((line) => /스크리너|전략|돌파|거래량|수급|신고가|저평가/i.test(line)).slice(0, 14),
    aiSignals: normalized.filter((line) => /\bAI\b|시그널/i.test(line)).slice(0, 10),
    calendar: normalized.filter((line) => /캘린더|실적|배당|일정|공모/i.test(line)).slice(0, 10),
    top10: normalized.filter((line) => /TOP ?10|거래대금|인기|랭킹/i.test(line)).slice(0, 10),
    community: normalized.filter((line) => /토론|커뮤니티|관심|인기 종목/i.test(line)).slice(0, 10),
    sectors: normalized.filter((line) => /섹터|테마|모멘텀/i.test(line)).slice(0, 10),
  };
}

export async function collectScoutData({
  url = DEFAULT_TARGET_URL,
  screenerUrl = DEFAULT_SCREENER_URL,
  calendarUrl = DEFAULT_CALENDAR_URL,
  headless = process.env.PLAYWRIGHT_HEADLESS !== 'false',
  limit = 10,
  dryRun = false,
} = {}) {
  if (dryRun || process.env.SCOUT_MOCK === '1') {
    return buildMockPayload(limit);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
    const screenerPage = await browser.newPage();
    await screenerPage.setUserAgent(DEFAULT_USER_AGENT);
    await screenerPage.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
    screenerPage.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
    const calendarPage = await browser.newPage();
    await calendarPage.setUserAgent(DEFAULT_USER_AGENT);
    await calendarPage.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
    calendarPage.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);

    const [homeRaw, screenerRaw, calendarRaw] = await Promise.all([
      collectPageTexts(page, url, { limit: 220 }),
      collectPageTexts(screenerPage, screenerUrl, { waitForSelector: '[class*="screen"], table, [class*="strategy"]', limit: 260 }).catch(() => ({ title: '', texts: [] })),
      collectPageTexts(calendarPage, calendarUrl, { waitForSelector: '[class*="calendar"], [class*="event"]', limit: 220 }).catch(() => ({ title: '', texts: [] })),
    ]);

    const lines = uniqueTexts([
      homeRaw.title,
      ...(homeRaw.bodyLines || []),
      ...(homeRaw.texts || []),
      screenerRaw.title,
      ...(screenerRaw.bodyLines || []),
      ...(screenerRaw.texts || []),
      calendarRaw.title,
      ...(calendarRaw.bodyLines || []),
      ...(calendarRaw.texts || []),
    ], 220);
    const sections = classifySections(lines);
    const signals = extractSignalsFromTexts(lines, sections).slice(0, Math.max(1, limit));

    return {
      source: 'puppeteer',
      fetchedAt: new Date().toISOString(),
      targetUrl: url,
      pageTitle: normalizeText(homeRaw.title),
      urls: {
        home: url,
        screener: screenerUrl,
        calendar: calendarUrl,
      },
      sections,
      signals,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const asJson = args.includes('--json');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = Number(limitArg?.split('=')[1] || 10);

  await runCliMain({
    run: () => collectScoutData({ dryRun, limit }),
    onSuccess: async (result) => {
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`[scout-scraper] source=${result.source} signals=${result.signals.length}`);
      for (const [section, values] of Object.entries(result.sections || {})) {
        if (!Array.isArray(values) || values.length === 0) continue;
        console.log(`- ${section}: ${values.slice(0, 3).join(' | ')}`);
      }
    },
    onError: async (error) => {
      console.error(`[scout-scraper] 실패: ${error.message}`);
    },
  });
}
