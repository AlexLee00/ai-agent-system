'use strict';

/**
 * packages/core/lib/billing-guard.js — LLM 긴급 차단 공통 모듈
 *
 * 파일 기반 차단 플래그 (.llm-emergency-stop):
 *   - 프로세스 재시작 없이 즉시 적용
 *   - 모든 봇이 공유하는 단일 상태
 *   - 해제: rm .llm-emergency-stop (마스터만)
 */

const fs   = require('fs');
const path = require('path');

const STOP_FILE = path.join(__dirname, '../../../.llm-emergency-stop');

/** 차단 중인지 확인 */
function isBlocked() {
  return fs.existsSync(STOP_FILE);
}

/** 차단 사유 조회 */
function getBlockReason() {
  if (!isBlocked()) return null;
  try {
    return JSON.parse(fs.readFileSync(STOP_FILE, 'utf8'));
  } catch {
    return { reason: '알 수 없음' };
  }
}

/** 긴급 차단 활성화 */
function activate(reason, costUsd, activatedBy = 'billing-guard') {
  const data = {
    activated_at:  new Date().toISOString(),
    reason,
    cost_usd:      costUsd,
    activated_by:  activatedBy,
    release:       '마스터만 해제 가능: rm .llm-emergency-stop',
  };
  fs.writeFileSync(STOP_FILE, JSON.stringify(data, null, 2));
  console.error(`🚨 [billing-guard] LLM 긴급 차단: ${reason}`);
  return data;
}

/** 차단 해제 (마스터 명령 처리용) */
function deactivate() {
  if (fs.existsSync(STOP_FILE)) {
    fs.unlinkSync(STOP_FILE);
    console.log('[billing-guard] LLM 긴급 차단 해제');
    return true;
  }
  return false;
}

module.exports = { isBlocked, getBlockReason, activate, deactivate, STOP_FILE };
