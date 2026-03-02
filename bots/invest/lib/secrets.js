'use strict';

/**
 * lib/secrets.js — secrets.json 로드 + 드라이런 감지
 *
 * API 키 없음 → 자동 DRY_RUN=true
 * secrets.json.dry_run=true → 강제 드라이런
 */

const fs = require('fs');
const path = require('path');

let _secrets = null;

function loadSecrets() {
  if (_secrets) return _secrets;
  const p = path.join(__dirname, '..', 'secrets.json');
  try {
    _secrets = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    // secrets.json 없으면 드라이런 모드로 기본값 사용
    console.warn('⚠️ secrets.json 없음 — 드라이런 모드 사용');
    _secrets = {
      telegram_bot_token: '',
      telegram_chat_id: '***REMOVED***',
      binance_api_key: '',
      binance_api_secret: '',
      binance_testnet: false,
      upbit_access_key: '',
      upbit_secret_key: '',
      dry_run: true,
      anthropic_api_key: '',
    };
  }
  return _secrets;
}

/**
 * 드라이런 여부 판단:
 * - secrets.dry_run === true → 강제 드라이런
 * - binance_api_key 없음 → 자동 드라이런
 * - 환경변수 DRY_RUN=true → 드라이런
 */
function isDryRun() {
  if (process.env.DRY_RUN === 'true') return true;
  const s = loadSecrets();
  if (s.dry_run === true) return true;
  if (!s.binance_api_key) return true;
  return false;
}

function isTestnet() {
  const s = loadSecrets();
  return s.binance_testnet === true || process.env.BINANCE_TESTNET === 'true';
}

// ─── KIS 헬퍼 ──────────────────────────────────────────────────────

/** 모의투자 여부 (기본값: true) */
function isKisPaper() {
  const s = loadSecrets();
  return s.kis_paper_trading !== false;
}

/**
 * KIS 계좌번호 파싱 ("12345678-01" → {cano, acntPrdtCd})
 * - 모의투자: kis_paper_account_number
 * - 실전:     kis_account_number
 */
function getKisAccount() {
  const s = loadSecrets();
  const raw = isKisPaper()
    ? (s.kis_paper_account_number || s.kis_account_number || '')
    : (s.kis_account_number || '');
  const [cano, acntPrdtCd] = raw.split('-');
  return { cano: cano || '', acntPrdtCd: acntPrdtCd || '01' };
}

/**
 * KIS API 키 설정 여부
 * - 모의투자: kis_paper_app_key 존재 여부
 * - 실전:     kis_app_key 존재 여부
 */
function hasKisApiKey() {
  const s = loadSecrets();
  if (isKisPaper()) {
    return !!(s.kis_paper_app_key && s.kis_paper_app_key.length > 5);
  }
  return !!(s.kis_app_key && s.kis_app_key.length > 5);
}

/**
 * 현재 모드에 맞는 KIS APP_KEY 반환
 * - 모의투자: kis_paper_app_key
 * - 실전:     kis_app_key
 */
function getKisAppKey() {
  const s = loadSecrets();
  return isKisPaper()
    ? (s.kis_paper_app_key || '')
    : (s.kis_app_key || '');
}

/**
 * 현재 모드에 맞는 KIS APP_SECRET 반환
 * - 모의투자: kis_paper_app_secret
 * - 실전:     kis_app_secret
 */
function getKisAppSecret() {
  const s = loadSecrets();
  return isKisPaper()
    ? (s.kis_paper_app_secret || '')
    : (s.kis_app_secret || '');
}

/** KIS 분석 대상 종목 (기본: 삼성전자, SK하이닉스) */
function getKisSymbols() {
  const s = loadSecrets();
  return s.kis_symbols || ['005930', '000660'];
}

/** KIS 해외주식 분석 대상 심볼 (기본: AAPL, TSLA, NVDA) */
function getKisOverseasSymbols() {
  const s = loadSecrets();
  return s.kis_overseas_symbols || ['AAPL', 'TSLA', 'NVDA'];
}

/** 바이낸스 분석 대상 심볼 (기본: BTC/USDT, ETH/USDT, SOL/USDT, BNB/USDT) */
function getSymbols() {
  const s = loadSecrets();
  return s.binance_symbols || ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
}

/**
 * 한국 주식시장 장 중 여부
 * KST 09:00~15:30, 평일만 (UTC+9 기준)
 * @returns {boolean}
 */
function isKisMarketOpen() {
  const now = new Date();
  const kstOffset = 9 * 60; // KST = UTC+9
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);
  const kstDay = new Date(now.getTime() + kstOffset * 60000).getUTCDay(); // 0=일, 6=토

  if (kstDay === 0 || kstDay === 6) return false; // 주말
  return kstMinutes >= 9 * 60 && kstMinutes < 15 * 60 + 30; // 09:00~15:30
}

/**
 * 미국 주식시장 장 중 여부 (서머타임 자동 반영)
 * NY EDT(UTC-4): 09:30~16:00 → UTC 13:30~20:00
 * NY EST(UTC-5): 09:30~16:00 → UTC 14:30~21:00
 * 서머타임 근사: 4~10월 = EDT, 나머지 = EST
 * @returns {boolean}
 */
function isKisOverseasMarketOpen() {
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const utcDay     = now.getUTCDay(); // 0=일, 6=토

  if (utcDay === 0 || utcDay === 6) return false; // 주말

  const month  = now.getUTCMonth() + 1;
  const isDST  = month >= 4 && month <= 10; // 서머타임 근사 (4~10월 = EDT)

  const openUtc  = isDST ? 13 * 60 + 30 : 14 * 60 + 30; // EDT: 13:30 / EST: 14:30
  const closeUtc = isDST ? 20 * 60       : 21 * 60;       // EDT: 20:00 / EST: 21:00

  return utcMinutes >= openUtc && utcMinutes < closeUtc;
}

module.exports = {
  loadSecrets,
  isDryRun,
  isTestnet,
  isKisPaper,
  getKisAccount,
  hasKisApiKey,
  getKisAppKey,
  getKisAppSecret,
  getKisSymbols,
  getKisOverseasSymbols,
  getSymbols,
  isKisMarketOpen,
  isKisOverseasMarketOpen,
};
