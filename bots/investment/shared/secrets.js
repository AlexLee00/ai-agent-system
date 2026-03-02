'use strict';

/**
 * shared/secrets.js — secrets.json 로드 + PAPER_MODE 감지
 *
 * 신규 키 추가 (bots/invest/lib/secrets.js 대비):
 *   xai_api_key, naver_client_id/secret, dart_api_key,
 *   cryptopanic_api_key, alpha_vantage_api_key
 *
 * 기존 DRY_RUN → PAPER_MODE 로 리네임 (의미 명확화)
 */

const fs   = require('fs');
const path = require('path');

let _secrets = null;

function loadSecrets() {
  if (_secrets) return _secrets;
  const p = path.join(__dirname, '..', 'secrets.json');
  try {
    _secrets = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    console.warn('⚠️ secrets.json 없음 — PAPER_MODE=true 기본값');
    _secrets = {
      telegram_bot_token: '',
      telegram_chat_id:   '***REMOVED***',
      // 바이낸스
      binance_api_key:    '',
      binance_api_secret: '',
      binance_testnet:    false,
      // 업비트
      upbit_access_key:   '',
      upbit_secret_key:   '',
      // KIS
      kis_app_key:         '',
      kis_app_secret:      '',
      kis_paper_app_key:   '',
      kis_paper_app_secret: '',
      kis_account_number:       '',
      kis_paper_account_number: '',
      kis_paper_trading:   true,
      // LLM — 무료
      groq_api_key:        '',
      cerebras_api_key:    '',
      sambanova_api_key:   '',
      // LLM — 유료
      anthropic_api_key:   '',
      xai_api_key:         '', // xAI x_search — 없으면 SambaNova/Groq fallback
      // 뉴스/공시
      naver_client_id:     '', // 네이버 뉴스 API (없으면 RSS fallback)
      naver_client_secret: '',
      dart_api_key:        '', // DART 공시 API (없으면 스킵)
      // 감성
      cryptopanic_api_key:  '', // CryptoPanic (없으면 스킵)
      alpha_vantage_api_key: '', // Alpha Vantage 뉴스 감성 (없으면 스킵)
      // 모드
      paper_mode: true,
    };
  }
  return _secrets;
}

/**
 * PAPER_MODE 여부
 * true  → 신호 생성·DB 저장·텔레그램만 (실주문 없음) ← Phase 3-A 기본값
 * false → 실주문 실행 (Phase 3-C, 사용자 최종 승인 필수)
 */
function isPaperMode() {
  if (process.env.PAPER_MODE === 'false') return false;
  if (process.env.PAPER_MODE === 'true')  return true;
  const s = loadSecrets();
  if (s.paper_mode === false) return false;
  if (!s.binance_api_key)    return true;
  return true; // 기본값: PAPER_MODE
}

function isTestnet() {
  const s = loadSecrets();
  return s.binance_testnet === true || process.env.BINANCE_TESTNET === 'true';
}

// ─── 심볼 헬퍼 ─────────────────────────────────────────────────────

/** 바이낸스 암호화폐 심볼 목록 */
function getSymbols() {
  const s = loadSecrets();
  return s.binance_symbols || ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
}

/** KIS 국내주식 심볼 목록 */
function getKisSymbols() {
  const s = loadSecrets();
  return s.kis_symbols || ['005930', '000660'];
}

/** KIS 해외주식(미국) 심볼 목록 */
function getKisOverseasSymbols() {
  const s = loadSecrets();
  return s.kis_overseas_symbols || ['AAPL', 'TSLA', 'NVDA'];
}

// ─── 시장 오픈 여부 ─────────────────────────────────────────────────

/** 한국 주식시장 장중 여부 (KST 09:00~15:30, 평일) */
function isKisMarketOpen() {
  const now        = new Date();
  const kstOffset  = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);
  const kstDay     = new Date(now.getTime() + kstOffset * 60000).getUTCDay();
  if (kstDay === 0 || kstDay === 6) return false;
  return kstMinutes >= 9 * 60 && kstMinutes < 15 * 60 + 30;
}

/** 미국 주식시장 장중 여부 (서머타임 자동 반영) */
function isKisOverseasMarketOpen() {
  const now        = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const utcDay     = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return false;
  const month  = now.getUTCMonth() + 1;
  const isDST  = month >= 4 && month <= 10;
  const openUtc  = isDST ? 13 * 60 + 30 : 14 * 60 + 30;
  const closeUtc = isDST ? 20 * 60       : 21 * 60;
  return utcMinutes >= openUtc && utcMinutes < closeUtc;
}

// ─── KIS 헬퍼 ───────────────────────────────────────────────────────

function isKisPaper() {
  const s = loadSecrets();
  return s.kis_paper_trading !== false;
}

function getKisAccount() {
  const s   = loadSecrets();
  const raw = isKisPaper()
    ? (s.kis_paper_account_number || s.kis_account_number || '')
    : (s.kis_account_number || '');
  const [cano, acntPrdtCd] = raw.split('-');
  return { cano: cano || '', acntPrdtCd: acntPrdtCd || '01' };
}

function hasKisApiKey() {
  const s = loadSecrets();
  if (isKisPaper()) return !!(s.kis_paper_app_key && s.kis_paper_app_key.length > 5);
  return !!(s.kis_app_key && s.kis_app_key.length > 5);
}

function getKisAppKey() {
  const s = loadSecrets();
  return isKisPaper() ? (s.kis_paper_app_key || '') : (s.kis_app_key || '');
}

function getKisAppSecret() {
  const s = loadSecrets();
  return isKisPaper() ? (s.kis_paper_app_secret || '') : (s.kis_app_secret || '');
}

module.exports = {
  loadSecrets,
  isPaperMode, isTestnet,
  getSymbols, getKisSymbols, getKisOverseasSymbols,
  isKisMarketOpen, isKisOverseasMarketOpen,
  isKisPaper, getKisAccount, hasKisApiKey, getKisAppKey, getKisAppSecret,
};
