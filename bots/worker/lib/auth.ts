// @ts-nocheck
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
const { initHubSecrets, getSecret } = require('./secrets');

const SALT_ROUNDS = 12;

// JWT 시크릿 — Hub / secrets-store에 존재해야 함
async function getJwtSecret() {
  await initHubSecrets();
  const secret = getSecret('worker_jwt_secret');
  if (!secret) {
    throw new Error(
      '[worker/auth] worker_jwt_secret 누락 — Hub secrets-store 확인 필요',
    );
  }
  return secret;
}

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

async function generateToken(user) {
  const payload = { id: user.id, company_id: user.company_id, role: user.role };
  const JWT_SECRET = await getJwtSecret();
  return jwt.sign(payload, JWT_SECRET, JWT_OPTIONS);
}

async function verifyToken(token) {
  // throws on invalid/expired
  const JWT_SECRET = await getJwtSecret();
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken, validatePasswordPolicy, getJwtSecret };
