'use strict';

/**
 * bots/worker/lib/auth.js — 인증 모듈
 *
 * hashPassword(plain)          → bcrypt hash (salt rounds 12)
 * verifyPassword(plain, hash)  → boolean
 * generateToken(user)          → JWT (24h)
 * verifyToken(token)           → { id, company_id, role }
 * validatePasswordPolicy(pw)   → { valid, reason }
 */

const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { getSecret } = require('./secrets');

const SALT_ROUNDS = 12;
const SECRETS_PATH = path.join(__dirname, '..', 'secrets.json');

// JWT 시크릿 — secrets.json 없으면 자동 생성 후 저장
function _getJwtSecret() {
  let secret = getSecret('worker_jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(48).toString('hex');
    // secrets.json이 없으면 생성, 있으면 worker_jwt_secret만 추가
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8')); } catch { /* 없음 */ }
    existing.worker_jwt_secret = secret;
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(existing, null, 2), { mode: 0o600 });
    console.log('[worker/auth] worker_jwt_secret 자동 생성 → secrets.json 저장');
  }
  return secret;
}

const JWT_SECRET  = _getJwtSecret();
const JWT_OPTIONS = { algorithm: 'HS256', expiresIn: '24h' };

// ── 비밀번호 ──────────────────────────────────────────────────────────

/**
 * KISA 비밀번호 정책 검증
 * 최소 8자 + 대문자/소문자/숫자/특수문자 중 3가지 이상
 */
function validatePasswordPolicy(password) {
  if (!password || password.length < 8) {
    return { valid: false, reason: '비밀번호는 최소 8자 이상이어야 합니다.' };
  }
  if (password.length > 72) {
    return { valid: false, reason: '비밀번호는 72자를 초과할 수 없습니다.' };
  }
  if (/\s/.test(password)) {
    return { valid: false, reason: '비밀번호에 공백을 포함할 수 없습니다.' };
  }
  const checks = [
    /[A-Z]/.test(password),        // 대문자
    /[a-z]/.test(password),        // 소문자
    /[0-9]/.test(password),        // 숫자
    /[^A-Za-z0-9]/.test(password), // 특수문자
  ];
  if (checks.filter(Boolean).length < 3) {
    return { valid: false, reason: '대문자, 소문자, 숫자, 특수문자 중 3가지 이상 포함해야 합니다.' };
  }
  return { valid: true, reason: null };
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  try { return await bcrypt.compare(plain, hash); }
  catch { return false; }
}

// ── JWT ───────────────────────────────────────────────────────────────

function generateToken(user) {
  const payload = { id: user.id, company_id: user.company_id, role: user.role };
  return jwt.sign(payload, JWT_SECRET, JWT_OPTIONS);
}

function verifyToken(token) {
  // throws on invalid/expired
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken, validatePasswordPolicy };
