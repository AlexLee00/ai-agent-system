// @ts-nocheck
/**
 * scripts/chart-vision.ts — 멀티모달 차트 패턴 분석 (Part J)
 *
 * Puppeteer로 차트 스크린샷 → GPT-4o Vision으로 패턴 분석
 * 비용 제한: 하루 최대 5회 (Vision API 고비용)
 *
 * 반환: { symbol, pattern, signal, confidence, reasoning, screenshotPath }
 *
 * 실행: node scripts/chart-vision.ts --symbol=BTC/USDT --exchange=binance
 *       node scripts/chart-vision.ts --symbol=AAPL --exchange=kis_overseas --dry-run
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { loadSecrets } from '../shared/secrets.ts';
import { parseJSON } from '../shared/llm-client.ts';
import { getChartVisionRuntimeConfig } from '../shared/runtime-config.ts';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

// ─── 비용 제한 설정 ────────────────────────────────────────────────────

const CHART_VISION_RUNTIME = getChartVisionRuntimeConfig();
const MAX_DAILY_CALLS = Math.max(1, Number(CHART_VISION_RUNTIME.maxDailyCalls || 5));
const USAGE_FILE = path.join(os.homedir(), '.jay', 'chart-vision-usage.json');

function ensureUsageDir() {
  const dir = path.dirname(USAGE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadUsage() {
  try {
    ensureUsageDir();
    if (!fs.existsSync(USAGE_FILE)) return { date: '', count: 0 };
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return { date: '', count: 0 };
  }
}

function saveUsage(usage) {
  ensureUsageDir();
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}

function getTodayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function checkDailyLimit() {
  const usage = loadUsage();
  const today = getTodayKST();
  if (usage.date !== today) return { allowed: true, remaining: MAX_DAILY_CALLS };
  const remaining = MAX_DAILY_CALLS - (usage.count || 0);
  return { allowed: remaining > 0, remaining, count: usage.count };
}

function incrementUsage() {
  const today = getTodayKST();
  const usage = loadUsage();
  if (usage.date !== today) {
    saveUsage({ date: today, count: 1 });
  } else {
    saveUsage({ date: today, count: (usage.count || 0) + 1 });
  }
}

// ─── 차트 URL 생성 ─────────────────────────────────────────────────────

/**
 * TradingView lightweight chart URL (embed)
 * 암호화폐: BINANCE:BTCUSDT  국내주식: KRX:005930  미국주식: NASDAQ:AAPL
 */
function buildChartUrl(symbol, exchange) {
  let tvSymbol;
  if (exchange === 'binance') {
    // BTC/USDT → BINANCE:BTCUSDT
    tvSymbol = `BINANCE:${symbol.replace('/', '')}`;
  } else if (exchange === 'kis') {
    // 005930 → KRX:005930
    tvSymbol = `KRX:${symbol}`;
  } else {
    // AAPL → NASDAQ:AAPL (fallback: AAPL)
    tvSymbol = symbol;
  }

  const params = new URLSearchParams({
    symbol: tvSymbol,
    interval: 'D',
    theme: 'dark',
    style: '1',
    locale: 'en',
    toolbar_bg: '#f1f3f6',
    enable_publishing: '0',
    hide_top_toolbar: '0',
    hide_legend: '0',
    save_image: '0',
    container_id: 'tv_chart',
  });
  return `https://www.tradingview.com/widgetembed/?${params.toString()}`;
}

// ─── 스크린샷 캡처 ────────────────────────────────────────────────────

const SCREENSHOT_DIR = path.join(os.tmpdir(), 'chart-vision');
const TIMEOUT_MS = 30000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

async function captureChartScreenshot(symbol, exchange) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const safeSymbol = symbol.replace(/\//g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
  const screenshotPath = path.join(SCREENSHOT_DIR, `${safeSymbol}-${exchange}-${Date.now()}.png`);
  const url = buildChartUrl(symbol, exchange);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(TIMEOUT_MS);

    console.log(`  📸 [차트비전] 차트 로드 중: ${url.slice(0, 80)}...`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: TIMEOUT_MS });
    // 차트 렌더링 대기
    await new Promise(r => setTimeout(r, 4000));

    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`  📸 [차트비전] 스크린샷 저장: ${screenshotPath}`);
    return screenshotPath;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── GPT-4o Vision 분석 ───────────────────────────────────────────────

const VISION_SYSTEM_PROMPT = `당신은 전문 차트 패턴 분석가입니다.
제공된 TradingView 차트 스크린샷을 분석하고 기술적 패턴을 파악합니다.

응답 형식 (JSON만, 마크다운 없음):
{
  "pattern": "패턴명 (영어, 예: double_bottom, head_and_shoulders, ascending_triangle, bullish_flag, none)",
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0~1.0,
  "reasoning": "근거 1~2문장 (한국어)",
  "key_levels": { "support": null|number, "resistance": null|number }
}

규칙:
- 명확한 패턴이 없으면 pattern="none", signal="HOLD"
- 신뢰도 0.5 미만이면 반드시 HOLD
- 패턴명은 snake_case 영어`;

async function analyzeChartWithVision(screenshotPath, symbol, dryRun = false) {
  if (dryRun) {
    console.log(`  🔍 [차트비전] dry-run 모드 — Vision API 스킵`);
    return {
      pattern: 'dry_run',
      signal: 'HOLD',
      confidence: 0.0,
      reasoning: 'dry-run 모드: Vision API 호출 없음',
      key_levels: { support: null, resistance: null },
    };
  }

  const secrets = loadSecrets();
  const apiKey = secrets.openai_api_key || '';
  if (!apiKey) throw new Error('OpenAI API 키 없음 — Hub secrets openai_api_key 설정 필요');

  const OpenAI = (() => {
    const mod = require('openai');
    return mod.default || mod;
  })();
  const client = new OpenAI({ apiKey, timeout: 30000, maxRetries: 1 });

  const imageBuffer = fs.readFileSync(screenshotPath);
  const base64Image = imageBuffer.toString('base64');

  console.log(`  🤖 [차트비전] GPT-4o Vision 분석 중...`);
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 300,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `심볼: ${symbol}\n위 차트를 분석하고 기술적 패턴과 매매 신호를 JSON으로 반환하세요.`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${base64Image}`,
              detail: 'low', // 비용 절감: low detail
            },
          },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content || '';
  const parsed = parseJSON(text);
  if (!parsed?.signal) {
    console.warn(`  ⚠️ [차트비전] Vision 응답 파싱 실패: ${text.slice(0, 80)}`);
    return { pattern: 'parse_error', signal: 'HOLD', confidence: 0.0, reasoning: text.slice(0, 100), key_levels: {} };
  }
  return parsed;
}

// ─── 메인 분석 ────────────────────────────────────────────────────────

/**
 * 차트 스크린샷 + GPT-4o Vision 패턴 분석
 *
 * @param {string} symbol
 * @param {'binance'|'kis'|'kis_overseas'} exchange
 * @param {{ dryRun?: boolean }} options
 * @returns {Promise<{
 *   symbol, exchange, pattern, signal, confidence, reasoning,
 *   key_levels, screenshotPath, skipped, skipReason
 * }>}
 */
export async function analyzeChartVision(symbol, exchange = 'binance', options = {}) {
  const { dryRun = false } = options;

  if (!dryRun) {
    const limit = checkDailyLimit();
    if (!limit.allowed) {
      const msg = `하루 최대 ${MAX_DAILY_CALLS}회 초과 — 차트비전 스킵`;
      console.log(`  ⏭️ [차트비전] ${symbol}: ${msg}`);
      return { symbol, exchange, skipped: true, skipReason: msg };
    }
    console.log(`  ℹ️ [차트비전] 오늘 남은 호출: ${limit.remaining}/${MAX_DAILY_CALLS}`);
  }

  let screenshotPath = null;
  try {
    screenshotPath = await captureChartScreenshot(symbol, exchange);
  } catch (e) {
    console.warn(`  ⚠️ [차트비전] 스크린샷 실패: ${e.message}`);
    return { symbol, exchange, skipped: true, skipReason: `스크린샷 실패: ${e.message}` };
  }

  let visionResult;
  try {
    if (!dryRun) incrementUsage();
    visionResult = await analyzeChartWithVision(screenshotPath, symbol, dryRun);
  } catch (e) {
    console.warn(`  ⚠️ [차트비전] Vision 분석 실패: ${e.message}`);
    return { symbol, exchange, skipped: true, skipReason: `Vision 실패: ${e.message}`, screenshotPath };
  }

  const result = {
    symbol,
    exchange,
    pattern:      visionResult.pattern || 'none',
    signal:       visionResult.signal  || 'HOLD',
    confidence:   visionResult.confidence ?? 0.0,
    reasoning:    visionResult.reasoning || '',
    key_levels:   visionResult.key_levels || {},
    screenshotPath,
    skipped:      false,
    skipReason:   null,
  };

  console.log(`  ✅ [차트비전] ${symbol}: ${result.pattern} → ${result.signal} (${(result.confidence * 100).toFixed(0)}%) | ${result.reasoning.slice(0, 60)}`);
  return result;
}

// ─── CLI 실행 ──────────────────────────────────────────────────────────

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args     = process.argv.slice(2);
      const symbol   = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';
      const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';
      const dryRun   = args.includes('--dry-run');
      const jsonMode = args.includes('--json');
      const status   = args.includes('--status');

      if (status) {
        const usage = loadUsage();
        const today = getTodayKST();
        const count = usage.date === today ? usage.count : 0;
        const payload = { today, count, max: MAX_DAILY_CALLS, remaining: MAX_DAILY_CALLS - count };
        if (jsonMode) console.log(JSON.stringify(payload, null, 2));
        else console.log(`[차트비전] 오늘(${today}) 사용: ${count}/${MAX_DAILY_CALLS} (남은: ${payload.remaining})`);
        return payload;
      }

      const result = await analyzeChartVision(symbol, exchange, { dryRun });

      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return result;
      }

      if (result.skipped) {
        console.log(`⏭️ 스킵: ${result.skipReason}`);
      } else {
        console.log(`\n✅ 차트비전 분석 완료:`);
        console.log(`  심볼:      ${result.symbol}`);
        console.log(`  패턴:      ${result.pattern}`);
        console.log(`  신호:      ${result.signal} (${(result.confidence * 100).toFixed(0)}%)`);
        console.log(`  근거:      ${result.reasoning}`);
        console.log(`  지지/저항: ${JSON.stringify(result.key_levels)}`);
        console.log(`  스크린샷: ${result.screenshotPath}`);
      }
      return result;
    },
    onSuccess: () => {},
    errorPrefix: '❌ 차트비전 오류:',
  });
}
