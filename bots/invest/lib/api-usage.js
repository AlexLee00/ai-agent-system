'use strict';

/**
 * lib/api-usage.js — LLM API 사용량 기록기
 *
 * 목적: 무료 API 일일 할당량 추적 + 동시사용 패턴 분석
 * 형식: JSONL (줄당 JSON 1개, append-only)
 * 경로: ~/.openclaw/api-usage.jsonl
 *
 * 각 항목:
 *   ts                — ISO 8601 타임스탬프 (KST 기준)
 *   provider          — 'groq' | 'anthropic' | 'gemini' | 'cerebras' | 'sambanova'
 *   model             — 모델 ID
 *   prompt_tokens     — 입력 토큰 수
 *   completion_tokens — 출력 토큰 수
 *   total_tokens      — 합계
 *   latency_ms        — API 응답 시간 (ms)
 *   caller            — 호출 모듈 (예: 'news-analyst', 'signal-aggregator')
 *   success           — true | false
 *
 * 무료 API 일일 한도 참고:
 *   groq/llama-3.1-8b-instant:    500,000 TPD, 30 RPM
 *   groq/llama-3.3-70b-versatile: 100,000 TPD, 30 RPM
 *   Anthropic haiku:              유료 (사용량 모니터링)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG_FILE = path.join(os.homedir(), '.openclaw', 'api-usage.jsonl');

/**
 * API 호출 1건 기록
 * @param {object} entry
 * @param {string} entry.provider          — 프로바이더 이름
 * @param {string} entry.model             — 모델 ID
 * @param {number} [entry.promptTokens]    — 입력 토큰
 * @param {number} [entry.completionTokens]— 출력 토큰
 * @param {number} [entry.totalTokens]     — 합계 토큰
 * @param {number} [entry.latencyMs]       — 응답 시간 ms
 * @param {string} [entry.caller]          — 호출 모듈명
 * @param {boolean}[entry.success]         — 성공 여부
 */
function logUsage({
  provider,
  model,
  promptTokens     = 0,
  completionTokens = 0,
  totalTokens      = 0,
  latencyMs        = 0,
  caller           = '',
  success          = true,
}) {
  const record = {
    ts:                new Date().toISOString(),
    provider,
    model,
    prompt_tokens:     promptTokens,
    completion_tokens: completionTokens,
    total_tokens:      totalTokens || (promptTokens + completionTokens),
    latency_ms:        latencyMs,
    caller,
    success,
  };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch {
    // 로그 실패는 메인 로직에 영향 없음
  }
}

/**
 * 오늘(KST 기준) 사용량 요약
 * @returns {{ byProvider: object, total: object }}
 */
function todaySummary() {
  if (!fs.existsSync(LOG_FILE)) return { byProvider: {}, total: { calls: 0, tokens: 0 } };

  const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const lines    = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);

  const byProvider = {};
  let totalCalls = 0, totalTokens = 0;

  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      // KST 날짜 비교 (UTC+9)
      const dateKST = new Date(new Date(r.ts).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      if (dateKST !== todayKST) continue;

      const key = `${r.provider}/${r.model}`;
      if (!byProvider[key]) byProvider[key] = { calls: 0, tokens: 0, failedCalls: 0, avgLatencyMs: 0, _latSum: 0 };

      byProvider[key].calls++;
      byProvider[key].tokens      += r.total_tokens || 0;
      byProvider[key]._latSum     += r.latency_ms   || 0;
      byProvider[key].avgLatencyMs = Math.round(byProvider[key]._latSum / byProvider[key].calls);
      if (!r.success) byProvider[key].failedCalls++;

      totalCalls  += 1;
      totalTokens += r.total_tokens || 0;
    } catch { /* 파싱 실패 무시 */ }
  }

  // 내부 집계 필드 제거
  for (const k of Object.keys(byProvider)) delete byProvider[k]._latSum;

  return { byProvider, total: { calls: totalCalls, tokens: totalTokens } };
}

module.exports = { logUsage, todaySummary, LOG_FILE };
