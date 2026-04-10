'use strict';

/**
 * lib/secrets.js — reservation 시크릿 로더
 *
 * 원칙:
 *   - 1순위: Hub API
 *   - 2순위: bots/hub/secrets-store.json
 *   - 실패 시: 빈 객체
 */

const fs   = require('fs');
const path = require('path');
const { fetchHubSecrets } = require('../../../packages/core/lib/hub-client');
const env = require('../../../packages/core/lib/env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots/hub/secrets-store.json');

let _cache = null;
let _hubSharedInitDone = false;

// ─── 로드 ───────────────────────────────────────────────────────────

function loadStoreSecrets() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    return raw?.reservation || {};
  } catch {
    return {};
  }
}

function loadSecrets() {
  if (_cache) return _cache;
  const store = loadStoreSecrets();
  _cache = Object.keys(store).length > 0 ? store : {};
  return _cache;
}

/**
 * Hub에서 reservation 키를 가져와 로컬 시크릿에 병합.
 * @returns {Promise<boolean>} Hub 로드 성공 여부
 */
async function initHubSecrets() {
  if (_hubSharedInitDone) return !!_cache;

  const store = loadStoreSecrets();
  const base = Object.keys(store).length > 0 ? store : {};
  try {
    const hubData = await fetchHubSecrets('reservation');
    if (hubData) {
      _cache = { ...base, ...hubData };
      _hubSharedInitDone = true;
      return true;
    }
    const sharedData = await fetchHubSecrets('reservation-shared');
    if (sharedData) {
      _cache = { ...base, ...sharedData };
      _hubSharedInitDone = true;
      return true;
    }
  } catch (e) {
    console.warn(`[reservation/secrets] Hub 시크릿 로드 실패: ${e.message}`);
  }

  _cache = base;
  _hubSharedInitDone = true;
  return false;
}

async function initHubSharedSecrets() {
  return initHubSecrets();
}

// ─── 키 접근 헬퍼 ───────────────────────────────────────────────────

/**
 * 치명적 키 접근 — 없으면 에러 메시지 출력 후 종료
 * @param {string} key
 * @returns {string}
 */
function requireSecret(key) {
  const val = loadSecrets()[key];
  if (!val) {
    console.error(`❌ 필수 설정 누락: reservation secrets의 "${key}" 값이 없습니다.`);
    console.error('   Hub secrets-store.json 또는 Hub API 구성을 확인한 후 다시 시작하세요.');
    process.exit(1);
  }
  return val;
}

/**
 * 키 존재 여부 확인 (종료하지 않음)
 * @param {string} key
 * @returns {boolean}
 */
function hasSecret(key) {
  const val = loadSecrets()[key];
  return !!val && String(val).trim().length > 0;
}

/**
 * 키 값 반환 — 없으면 fallback 반환 (종료하지 않음)
 * @param {string} key
 * @param {*} fallback
 */
function getSecret(key, fallback = null) {
  return loadSecrets()[key] ?? fallback;
}

// ─── 도메인 헬퍼 ────────────────────────────────────────────────────

/** 텔레그램 활성화 여부 */
function isTelegramEnabled() {
  return hasSecret('telegram_bot_token');
}

/** 네이버 로그인 자격증명 (없으면 즉시 종료) */
function getNaverCreds() {
  return {
    id: requireSecret('naver_id'),
    pw: requireSecret('naver_pw'),
  };
}

/** 픽코 로그인 자격증명 (없으면 즉시 종료) */
function getPickkoCreds() {
  return {
    id: requireSecret('pickko_id'),
    pw: requireSecret('pickko_pw'),
  };
}

/** DB 암호화 키 (없으면 즉시 종료) */
function getDbKeys() {
  return {
    encryptionKey: requireSecret('db_encryption_key'),
    pepper:        requireSecret('db_key_pepper'),
  };
}

/** data.go.kr API 키 유효 여부 확인 */
function hasDataGokrKeys() {
  return hasSecret('datagokr_holiday_key');
}

module.exports = {
  loadSecrets,
  initHubSecrets,
  initHubSharedSecrets,
  requireSecret,
  hasSecret,
  getSecret,
  isTelegramEnabled,
  getNaverCreds,
  getPickkoCreds,
  getDbKeys,
  hasDataGokrKeys,
};
