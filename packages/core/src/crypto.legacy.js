'use strict';

/**
 * packages/core/src/crypto.js — AES-256-GCM 필드 암호화 + kiosk 해시 키
 *
 * bots/reservation/lib/crypto.js에서 secrets.js 의존성 제거하여 범용화
 * 사용 전 init(hexKey, pepper) 1회 호출 필요
 *
 * 알고리즘: AES-256-GCM (Node.js crypto 내장, 추가 패키지 없음)
 * 포맷: base64(iv[12B] + authTag[16B] + ciphertext)
 */

const crypto = require('crypto');

let _key = null;
let _pepper = '';

/**
 * init(hexKey, pepper) — 사용 전 1회 호출
 * @param {string} hexKey  64자 hex 문자열 (32 bytes)
 * @param {string} pepper  kiosk 해시용 pepper (선택)
 */
function init(hexKey, pepper = '') {
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('hexKey must be 64-char hex string');
  }
  _key = Buffer.from(hexKey, 'hex');
  _pepper = pepper;
}

function getKey() {
  if (!_key) throw new Error('crypto.init() must be called before using encrypt/decrypt');
  return _key;
}

/**
 * encrypt(text) → AES-256-GCM → base64 string
 * null/undefined 입력 → null 반환
 */
function encrypt(text) {
  if (text === null || text === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(text), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * decrypt(b64) → plaintext string
 * null/undefined 입력 → null 반환
 */
function decrypt(b64) {
  if (b64 === null || b64 === undefined) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv      = buf.slice(0, 12);
    const authTag = buf.slice(12, 28);
    const data    = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    return decipher.update(data) + decipher.final('utf8');
  } catch (err) {
    throw new Error(`decrypt 실패: ${err.message}`);
  }
}

/**
 * hashKioskKey(phoneRaw, date, start) → SHA256 hex
 * kiosk_blocks 테이블의 PRIMARY KEY용 불가역 해시
 */
function hashKioskKey(phoneRaw, date, start) {
  return crypto
    .createHash('sha256')
    .update(`${phoneRaw}|${date}|${start}${_pepper}`)
    .digest('hex');
}

module.exports = { init, encrypt, decrypt, hashKioskKey };
