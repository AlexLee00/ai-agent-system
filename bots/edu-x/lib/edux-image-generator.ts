// @ts-nocheck
'use strict';

/**
 * edux-image-generator.ts — 차트 이미지 생성
 *
 * ① matplotlib 차트: python/chart-generator.py subprocess 호출
 * ② TradingView 캡처: 루나팀 tradingview-ws 위젯 스크린샷 (선택)
 *
 * 저장 위치: /tmp/edux-images/{date}/{slot}_{type}.png
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

const EDU_X_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');
const CHART_SCRIPT = path.join(EDU_X_ROOT, 'python', 'chart-generator.py');
const PYTHON_BIN = process.env.EDUX_PYTHON_BIN || '/usr/bin/python3';
const CHART_TIMEOUT_MS = 30000;
const TRADINGVIEW_METRICS_BASE = process.env.EDUX_TRADINGVIEW_WS_HTTP_BASE || 'http://127.0.0.1:8083';
const TRADINGVIEW_TIMEOUT_MS = 2500;

/** @returns {string} YYYYMMDD */
function todayStr() {
  const d = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);
  return String(d).replace(/-/g, '');
}

/** @param {string} slot - '0600' | '0900' | '1400' | '2200' | '2230' */
function getImageDir(slot) {
  return `/tmp/edux-images/${todayStr()}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * matplotlib 차트 생성
 * @param {'crypto_bar'|'crypto_line'|'kis_sector'|'kis_index_line'|'overseas_bar'|'overseas_mag7'} chartType
 * @param {object} data
 * @param {string} outPath
 * @returns {Promise<boolean>}
 */
async function generateMatplotlibChart(chartType, data, outPath) {
  return new Promise((resolve) => {
    const dataJson = JSON.stringify(data || {});
    const args = [CHART_SCRIPT, '--type', chartType, '--data', dataJson, '--out', outPath];

    ensureDir(path.dirname(outPath));

    const child = execFile(PYTHON_BIN, args, { timeout: CHART_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[edu-x/img-gen] matplotlib 실패 (${chartType}):`, err.message);
        if (stderr) console.error('[edu-x/img-gen] stderr:', stderr.slice(0, 300));
        resolve(false);
        return;
      }
      if (stdout) console.log(`[edu-x/img-gen] matplotlib: ${stdout.trim()}`);
      console.log(`[edu-x/img-gen] 차트 생성 완료: ${outPath}`);
      resolve(true);
    });

    child.on('error', (err) => {
      console.error('[edu-x/img-gen] subprocess 오류:', err.message);
      resolve(false);
    });
  });
}

async function fetchTradingViewLatestBars({ symbols = ['BINANCE:BTCUSDT'], timeframes = ['60'] } = {}) {
  const url = new URL('/latest', TRADINGVIEW_METRICS_BASE);
  url.searchParams.set('symbols', symbols.join(','));
  url.searchParams.set('timeframes', timeframes.join(','));
  url.searchParams.set('requireReal', 'false');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRADINGVIEW_TIMEOUT_MS);
    let data;
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } finally {
      clearTimeout(timer);
    }
    return Array.isArray(data?.bars) ? data.bars : [];
  } catch (err) {
    console.warn('[edu-x/img-gen] TradingView read-only bars unavailable, matplotlib fallback 사용:', err?.message);
    return [];
  }
}

function ohlcvFromTradingViewBars(rows = []) {
  const sorted = [...rows]
    .filter((item) => item?.bar?.close)
    .sort((a, b) => Number(a.bar.timestamp || 0) - Number(b.bar.timestamp || 0));
  if (!sorted.length) return {};
  return {
    prices: sorted.map((item) => Number(item.bar.close)),
    times: sorted.map((item) => {
      const ts = Number(item.bar.timestamp || 0);
      if (!ts) return item.timeframe || '';
      return new Date(ts).toISOString().slice(11, 16);
    }),
    source: sorted.some((item) => item.fallbackReason) ? 'tradingview_ws_binance_fallback' : 'tradingview_ws',
  };
}

/**
 * 암호화폐 이미지 2장 생성
 * @param {string} slot
 * @param {{marketData: object, ohlcvData: object}} params
 * @returns {Promise<string[]>} - 생성된 PNG 경로 배열
 */
async function generateCryptoImages(slot, { marketData = {}, ohlcvData = {} } = {}) {
  const dir = getImageDir(slot);
  const barPath = path.join(dir, `${slot}_crypto_bar.png`);
  const linePath = path.join(dir, `${slot}_crypto_line.png`);
  let lineData = ohlcvData;
  if (!lineData?.prices?.length && process.env.EDUX_DISABLE_TRADINGVIEW_READONLY !== 'true') {
    const tvBars = await fetchTradingViewLatestBars({ symbols: ['BINANCE:BTCUSDT'], timeframes: ['60'] });
    lineData = ohlcvFromTradingViewBars(tvBars);
  }

  const results = await Promise.allSettled([
    generateMatplotlibChart('crypto_bar', { coins: marketData?.top_coins || [] }, barPath),
    generateMatplotlibChart('crypto_line', { prices: lineData?.prices || [], times: lineData?.times || [] }, linePath),
  ]);

  const paths = [];
  if (results[0].status === 'fulfilled' && results[0].value && fs.existsSync(barPath)) {
    paths.push(barPath);
  }
  if (results[1].status === 'fulfilled' && results[1].value && fs.existsSync(linePath)) {
    paths.push(linePath);
  }

  console.log(`[edu-x/img-gen] crypto 이미지 ${paths.length}장 생성 (슬롯: ${slot})`);
  return paths;
}

/**
 * 국내주식 이미지 2장 생성
 * @param {{marketData: object}} params
 * @returns {Promise<string[]>}
 */
async function generateKisImages({ marketData = {} } = {}) {
  const slot = '0900';
  const dir = getImageDir(slot);
  const sectorPath = path.join(dir, `${slot}_kis_sector.png`);
  const indexPath = path.join(dir, `${slot}_kis_index_line.png`);

  const results = await Promise.allSettled([
    generateMatplotlibChart('kis_sector', { sectors: marketData?.sectors || [] }, sectorPath),
    generateMatplotlibChart('kis_index_line', { series: marketData?.indexSeries || {} }, indexPath),
  ]);

  const paths = [];
  if (results[0].status === 'fulfilled' && results[0].value && fs.existsSync(sectorPath)) paths.push(sectorPath);
  if (results[1].status === 'fulfilled' && results[1].value && fs.existsSync(indexPath)) paths.push(indexPath);
  console.log(`[edu-x/img-gen] KIS 이미지 ${paths.length}장 생성`);
  return paths;
}

/**
 * 해외주식 이미지 2장 생성
 * @param {{marketData: object}} params
 * @returns {Promise<string[]>}
 */
async function generateOverseasImages({ marketData = {} } = {}) {
  const slot = '2200';
  const dir = getImageDir(slot);
  const barPath = path.join(dir, `${slot}_overseas_bar.png`);
  const mag7Path = path.join(dir, `${slot}_overseas_mag7.png`);

  const results = await Promise.allSettled([
    generateMatplotlibChart('overseas_bar', { coins: marketData?.top_etfs || [] }, barPath),
    generateMatplotlibChart('overseas_mag7', { mag7: marketData?.mag7 || [] }, mag7Path),
  ]);

  const paths = [];
  if (results[0].status === 'fulfilled' && results[0].value && fs.existsSync(barPath)) paths.push(barPath);
  if (results[1].status === 'fulfilled' && results[1].value && fs.existsSync(mag7Path)) paths.push(mag7Path);
  console.log(`[edu-x/img-gen] overseas 이미지 ${paths.length}장 생성`);
  return paths;
}

/**
 * /tmp/edux-images/ 7일 이전 폴더 정리
 */
function cleanupOldImages() {
  const baseDir = '/tmp/edux-images';
  if (!fs.existsSync(baseDir)) return;
  const today = Number(todayStr());
  try {
    const dirs = fs.readdirSync(baseDir);
    for (const d of dirs) {
      const dNum = Number(d);
      if (Number.isFinite(dNum) && today - dNum > 7) {
        fs.rmSync(path.join(baseDir, d), { recursive: true, force: true });
        console.log(`[edu-x/img-gen] 오래된 이미지 삭제: ${d}`);
      }
    }
  } catch (err) {
    console.warn('[edu-x/img-gen] 정리 실패:', err?.message);
  }
}

module.exports = {
  generateCryptoImages,
  generateKisImages,
  generateOverseasImages,
  cleanupOldImages,
  fetchTradingViewLatestBars,
};
