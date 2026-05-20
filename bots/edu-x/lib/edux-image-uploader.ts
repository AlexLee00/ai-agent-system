// @ts-nocheck
'use strict';

/**
 * edux-image-uploader.ts — Edu-X 이미지 업로드 (2단계!)
 *
 * 흐름:
 *   1. uploadImage(filePath) → POST /api/community/upload → { url }
 *   2. EduxClient.post(..., imageUrl: url)
 *
 * Rate Limit 준수: 순차 업로드 (병렬 X)
 * 응답 url은 상대경로일 수 있음 → base_url 합성
 */

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { getEduxClient } = require('./edux-client');
const { fetchHubSecrets } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/hub-client'));

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRY = 3;
const BETWEEN_UPLOAD_DELAY_MS = 1500;

async function getBaseUrl() {
  try {
    const secrets = await fetchHubSecrets('edux', 5000);
    return String(secrets?.base_url || 'https://edu-x.io').replace(/\/$/, '');
  } catch {
    return 'https://edu-x.io';
  }
}

function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) return rawUrl;
  if (rawUrl.startsWith('/')) return `${baseUrl}${rawUrl}`;
  return `${baseUrl}/${rawUrl}`;
}

/**
 * 단일 이미지 업로드
 * @param {string} filePath - 로컬 파일 경로
 * @returns {Promise<string | null>} - Edu-X 이미지 URL 또는 null
 */
async function uploadImage(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[edu-x/uploader] 파일 없음: ${filePath}`);
    return null;
  }

  const client = getEduxClient();
  const initialized = await client.init();
  if (!initialized) return null;
  if (!client._accessToken) {
    const ok = await client.login();
    if (!ok) return null;
  }

  const baseUrl = await getBaseUrl();
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png';

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append('file', blob, fileName);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      let resp;
      try {
        resp = await fetch(`${baseUrl}/api/community/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${client._accessToken}` },
          body: formData,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (resp.status === 401) {
        const refreshed = await client.refreshAccess();
        if (!refreshed) return null;
        continue;
      }

      if (resp.status === 429) {
        let data = {};
        try { data = await resp.json(); } catch {}
        const wait = Number(data?.retryAfter || 5) * 1000;
        console.warn(`[edu-x/uploader] 429 → ${wait / 1000}s 대기`);
        if (attempt < MAX_RETRY - 1) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        return null;
      }

      if (!resp.ok) {
        let data = {};
        try { data = await resp.json(); } catch {}
        console.error(`[edu-x/uploader] 업로드 실패 HTTP ${resp.status}:`, JSON.stringify(data));
        return null;
      }

      const data = await resp.json();
      const rawUrl = data?.url || data?.imageUrl || null;
      const fullUrl = normalizeUrl(rawUrl, baseUrl);
      if (!fullUrl) {
        console.error('[edu-x/uploader] 응답에 url 없음:', JSON.stringify(data));
        return null;
      }
      console.log(`[edu-x/uploader] 업로드 성공: ${fileName} → ${fullUrl}`);
      return fullUrl;
    } catch (err) {
      if (attempt < MAX_RETRY - 1) {
        console.warn(`[edu-x/uploader] 예외 (재시도 ${attempt + 1}/${MAX_RETRY}):`, err?.message);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.error('[edu-x/uploader] 업로드 최종 실패:', err?.message);
      return null;
    }
  }
  return null;
}

/**
 * 복수 이미지 순차 업로드
 * @param {string[]} filePaths
 * @returns {Promise<string[]>} - 성공한 URL 배열
 */
async function uploadMultiple(filePaths) {
  const results = [];
  for (const filePath of filePaths) {
    const url = await uploadImage(filePath);
    if (url) results.push(url);
    if (filePaths.indexOf(filePath) < filePaths.length - 1) {
      await new Promise((r) => setTimeout(r, BETWEEN_UPLOAD_DELAY_MS));
    }
  }
  return results;
}

module.exports = { uploadImage, uploadMultiple };
