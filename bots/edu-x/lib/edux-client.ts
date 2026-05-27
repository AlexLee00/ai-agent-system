// @ts-nocheck
'use strict';

/**
 * edux-client.ts — Edu-X 커뮤니티 JWT 인증 + 게시 클라이언트
 *
 * 인증: JWT Bearer (access + refresh rotation)
 * 401 → refreshAccess() → 실패 시 login() 재호출
 * 429 → retryAfter 백오프, 최대 3회 재시도
 * category: "free" 고정 (activity 카테고리 사용 금지)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { fetchHubSecrets } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/hub-client'));

const MAX_RETRY = 3;
const DEFAULT_TIMEOUT_MS = 15000;
const EDUX_CATEGORY = 'free';
const REQUIRED_SECRET_KEYS = ['base_url', 'bot_email', 'bot_password'];
const IMAGE_ATTACHMENTS_ENV = 'EDUX_IMAGE_ATTACHMENTS_ENABLED';

function imageAttachmentsEnabled() {
  return String(process.env[IMAGE_ATTACHMENTS_ENV] || 'false').trim().toLowerCase() === 'true';
}

function normalizeEduxCredentials(raw, source = 'unknown') {
  if (!raw || typeof raw !== 'object') return null;
  const baseUrl = String(raw.base_url || '').trim().replace(/\/$/, '');
  const botEmail = String(raw.bot_email || '').trim();
  const botPassword = String(raw.bot_password || '');
  if (!baseUrl || !botEmail || !botPassword) return null;
  return {
    base_url: baseUrl,
    bot_email: botEmail,
    bot_password: botPassword,
    _source: source,
  };
}

/** @returns {Promise<{base_url: string, bot_email: string, bot_password: string, _source?: string} | null>} */
async function getEduxSecrets() {
  try {
    const hubSecrets = normalizeEduxCredentials(await fetchHubSecrets('edux', 5000), 'hub:edux');
    if (hubSecrets) return hubSecrets;
  } catch (err) {
    console.warn('[edu-x] Hub credentials 조회 실패:', err?.message);
  }

  console.error('[edu-x] Hub secret edux 설정 없음 (base_url, bot_email, bot_password 필요)');
  return null;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonSafe(resp) {
  try {
    return await resp.json();
  } catch {
    return {};
  }
}

class EduxClient {
  constructor(opts = {}) {
    this._baseUrl = null;
    this._email = null;
    this._password = null;
    this._accessToken = null;
    this._refreshToken = null;
    this._initialized = false;
    this._fetch = opts.fetchImpl || fetch;
    this._sleep = opts.sleep || sleep;
    this._secrets = opts.secrets || null;
  }

  async init() {
    if (this._initialized) return true;
    const secrets = this._secrets || await getEduxSecrets();
    if (!secrets) return false;
    this._baseUrl = String(secrets.base_url).replace(/\/$/, '');
    this._email = secrets.bot_email;
    this._password = secrets.bot_password;
    this._initialized = true;
    return true;
  }

  getBaseUrl() {
    return this._baseUrl || 'https://edu-x.io';
  }

  getAccessToken() {
    return this._accessToken || null;
  }

  async ensureAuthenticated() {
    if (!this._accessToken) return await this.login();
    return true;
  }

  /** POST /api/auth/login */
  async login() {
    const ok = await this.init();
    if (!ok) return false;
    try {
      const resp = await fetchWithTimeout(`${this._baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this._email, password: this._password }),
      }, DEFAULT_TIMEOUT_MS, this._fetch);
      if (!resp.ok) {
        const data = await parseJsonSafe(resp);
        console.error('[edu-x] login 실패:', resp.status, JSON.stringify(data));
        return false;
      }
      const data = await resp.json();
      this._accessToken = data.accessToken;
      this._refreshToken = data.refreshToken;
      console.log('[edu-x] login 성공');
      return true;
    } catch (err) {
      console.error('[edu-x] login 예외:', err?.message);
      return false;
    }
  }

  /** POST /api/auth/refresh — rotation 방식 */
  async refreshAccess() {
    if (!this._refreshToken) return await this.login();
    try {
      const resp = await fetchWithTimeout(`${this._baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this._refreshToken }),
      }, DEFAULT_TIMEOUT_MS, this._fetch);
      if (resp.status === 401) {
        console.warn('[edu-x] refresh 토큰 만료 → 재로그인');
        this._refreshToken = null;
        return await this.login();
      }
      if (!resp.ok) return false;
      const data = await resp.json();
      this._accessToken = data.accessToken;
      this._refreshToken = data.refreshToken;
      return true;
    } catch (err) {
      console.error('[edu-x] refreshAccess 예외:', err?.message);
      return false;
    }
  }

  /** GET /api/auth/me — 토큰 헬스체크 */
  async health() {
    const data = await this.request('GET', '/api/auth/me');
    return data !== null;
  }

  /** POST /api/auth/logout */
  async logout() {
    try {
      await this.request('POST', '/api/auth/logout');
    } catch {
      // logout 실패는 무시
    }
  }

  /**
   * 인증 헤더 포함 범용 요청
   * @param {'GET'|'POST'|'PUT'|'DELETE'} method
   * @param {string} path
   * @param {{body?: any, timeoutMs?: number}} [opts]
   * @returns {Promise<any | null>}
   */
  async request(method, urlPath, opts = {}) {
    if (!this._accessToken) {
      const ok = await this.login();
      if (!ok) return null;
    }

    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const fetchOpts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._accessToken}`,
      },
    };
    if (opts.body !== undefined) {
      fetchOpts.body = JSON.stringify(opts.body);
    }

    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      try {
        const resp = await fetchWithTimeout(`${this._baseUrl}${urlPath}`, fetchOpts, timeoutMs, this._fetch);

        if (resp.status === 401) {
          const refreshed = await this.refreshAccess();
          if (!refreshed) return null;
          fetchOpts.headers.Authorization = `Bearer ${this._accessToken}`;
          continue;
        }

        if (resp.status === 429) {
          const data = await parseJsonSafe(resp);
          const wait = Number(data?.retryAfter || 5) * 1000;
          console.warn(`[edu-x] 429 Rate Limit — ${wait / 1000}s 대기 (시도 ${attempt + 1}/${MAX_RETRY})`);
          if (attempt < MAX_RETRY - 1) {
            await this._sleep(wait);
            continue;
          }
          return null;
        }

        if (!resp.ok) {
          const data = await parseJsonSafe(resp);
          console.error(`[edu-x] HTTP ${resp.status}:`, JSON.stringify(data));
          return null;
        }

        return await resp.json().catch(() => ({}));
      } catch (err) {
        if (attempt < MAX_RETRY - 1) {
          console.warn(`[edu-x] request 예외 (재시도 ${attempt + 1}/${MAX_RETRY}):`, err?.message);
          await this._sleep(2000);
          continue;
        }
        console.error('[edu-x] request 최종 실패:', err?.message);
        return null;
      }
    }
    return null;
  }

  /**
   * POST /api/community/posts — 게시글 작성
   * @param {{title?: string, content: string, imageUrl?: string}} param0
   * @returns {Promise<{id: string, [key: string]: any} | null>}
   */
  async post({ title, content, imageUrl = null }) {
    if (!content) {
      console.error('[edu-x] content 필수');
      return null;
    }
    if (content.length > 20000) {
      console.warn('[edu-x] content 20000자 초과 → 자름');
      content = content.slice(0, 20000);
    }
    if (title && title.length > 200) {
      title = title.slice(0, 200);
    }
    const body = { title: title || null, content, category: EDUX_CATEGORY };
    if (imageUrl && imageAttachmentsEnabled()) body.imageUrl = imageUrl;
    return this.request('POST', '/api/community/posts', { body });
  }

  /**
   * GET /api/community/posts — 목록 조회 (발행 확인용)
   * @param {{limit?: number, sort?: string}} [opts]
   */
  async listPosts(opts = {}) {
    const limit = opts.limit || 10;
    const sort = opts.sort || 'new';
    return this.request('GET', `/api/community/posts?limit=${limit}&sort=${sort}`);
  }

  /**
   * GET /api/community/posts/:id — 상세 조회
   * @param {string} postId
   */
  async getPost(postId) {
    return this.request('GET', `/api/community/posts/${postId}`);
  }

  /**
   * DELETE /api/community/posts/:id — 테스트 게시글 정리
   * @param {string} postId
   */
  async deletePost(postId) {
    if (!postId) {
      console.error('[edu-x] postId 필수');
      return null;
    }
    return this.request('DELETE', `/api/community/posts/${postId}`);
  }
}

/** 싱글턴 인스턴스 */
let _instance = null;

/** @returns {EduxClient} */
function getEduxClient() {
  if (!_instance) _instance = new EduxClient();
  return _instance;
}

module.exports = {
  EduxClient,
  getEduxClient,
  EDUX_CATEGORY,
  REQUIRED_SECRET_KEYS,
  imageAttachmentsEnabled,
  normalizeEduxCredentials,
  getEduxSecrets,
  fetchWithTimeout,
  parseJsonSafe,
};
