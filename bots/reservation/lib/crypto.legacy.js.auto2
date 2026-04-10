'use strict';

/**
 * lib/crypto.js — AES-256-GCM 필드 암호화 + kiosk 해시 키
 *
 * 알고리즘: AES-256-GCM (Node.js crypto 내장, 추가 패키지 없음)
 * 키 위치: secrets.json → db_encryption_key (64자 hex = 32 bytes)
 * Pepper: secrets.json → db_key_pepper (kiosk_blocks 해시 키용)
 *
 * 포맷: base64(iv[12B] + authTag[16B] + ciphertext)
 */

const crypto = require('crypto');
const { loadSecrets } = require('./secrets');

let _key = null;

function getKey() {
  if (!_key) {
    const secrets = loadSecrets();
    const hex = secrets.db_encryption_key;
    if (!hex || hex.length !== 64) {
      throw new Error('db_encryption_key must be 64-char hex in secrets.json');
    }
    _key = Buffer.from(hex, 'hex');
  }
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
  // iv(12) + authTag(16) + ciphertext → base64
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

function _normalizeKioskKeyPart(value) {
  return String(value || '').trim();
}

/**
 * legacy 키: phone|date|start
 */
function hashKioskKeyLegacy(phoneRaw, date, start) {
  const secrets = loadSecrets();
  const pepper = secrets.db_key_pepper || '';
  return crypto
    .createHash('sha256')
    .update(`${_normalizeKioskKeyPart(phoneRaw)}|${_normalizeKioskKeyPart(date)}|${_normalizeKioskKeyPart(start)}${pepper}`)
    .digest('hex');
}

/**
 * v2 키: phone|date|start|end|room
 * 재예약/부분 시간 변경 충돌을 줄이기 위한 kiosk_blocks PRIMARY KEY용 불가역 해시
 */
function hashKioskKey(phoneRaw, date, start, end, room) {
  const secrets = loadSecrets();
  const pepper = secrets.db_key_pepper || '';
  return crypto
    .createHash('sha256')
    .update(
      [
        _normalizeKioskKeyPart(phoneRaw),
        _normalizeKioskKeyPart(date),
        _normalizeKioskKeyPart(start),
        _normalizeKioskKeyPart(end),
        _normalizeKioskKeyPart(room),
      ].join('|') + pepper
    )
    .digest('hex');
}

module.exports = { encrypt, decrypt, hashKioskKey, hashKioskKeyLegacy };
