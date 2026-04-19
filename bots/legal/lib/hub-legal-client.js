'use strict';

/**
 * hub-legal-client.js — Hub API를 통한 사건 관리 클라이언트
 *
 * 외부 도구(n8n, 텔레그램 봇 등)가 Hub API를 통해 저스틴팀 사건을
 * 관리할 수 있도록 하는 경량 클라이언트.
 *
 * 내부 에이전트(justin.js 등)는 appraisal-store.js를 직접 사용.
 */

const env = require('../../../packages/core/lib/env');

const DEFAULT_TIMEOUT_MS = 8000;

async function hubPost(path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const baseUrl = env.HUB_BASE_URL;
  const token = env.HUB_AUTH_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('[hub-legal-client] HUB_BASE_URL 또는 HUB_AUTH_TOKEN 미설정');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function hubGet(path, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const baseUrl = env.HUB_BASE_URL;
  const token = env.HUB_AUTH_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('[hub-legal-client] HUB_BASE_URL 또는 HUB_AUTH_TOKEN 미설정');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 새 사건 접수
 * @param {{ case_number, court, case_type, plaintiff, defendant, appraisal_items?, deadline?, notes? }} input
 */
async function createCase(input) {
  return hubPost('/hub/legal/case', input);
}

/**
 * 사건 목록 조회
 * @param {{ status?: string, limit?: number, offset?: number }} options
 */
async function listCases({ status = null, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return hubGet(`/hub/legal/cases?${params}`);
}

/**
 * 사건 상세 조회
 * @param {number} id
 */
async function getCase(id) {
  return hubGet(`/hub/legal/case/${id}`);
}

/**
 * 사건 진행 상태 요약 조회
 * @param {number} id
 */
async function getCaseStatus(id) {
  return hubGet(`/hub/legal/case/${id}/status`);
}

/**
 * 마스터 승인 — 다음 단계로 전환
 * @param {number} id
 */
async function advanceCase(id) {
  return hubPost(`/hub/legal/case/${id}/approve`, { action: 'advance' });
}

/**
 * 마스터 승인 — 특정 status로 직접 전환
 * @param {number} id
 * @param {string} targetStatus
 */
async function setCaseStatus(id, targetStatus) {
  return hubPost(`/hub/legal/case/${id}/approve`, { action: 'status', target_status: targetStatus });
}

/**
 * 판결 피드백 등록 (Phase 6 피드백 루프)
 * @param {number} id
 * @param {{ court_decision: string, appraisal_accuracy: number, notes?: string }} feedback
 */
async function submitFeedback(id, feedback) {
  return hubPost(`/hub/legal/case/${id}/feedback`, feedback);
}

/**
 * 최신 감정서 조회
 * @param {number} id
 * @param {string} type 'final' | 'inception_plan' | ...
 */
async function getReport(id, type = 'final') {
  return hubGet(`/hub/legal/case/${id}/report?type=${encodeURIComponent(type)}`);
}

module.exports = {
  createCase,
  listCases,
  getCase,
  getCaseStatus,
  advanceCase,
  setCaseStatus,
  submitFeedback,
  getReport,
};
