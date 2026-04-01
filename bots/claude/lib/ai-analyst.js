'use strict';

/**
 * lib/ai-analyst.js — 덱스터 AI 종합 분석 레이어
 *
 * 체크 완료 후 OpenAI로 종합 진단 + 과거 인사이트 컨텍스트 제공
 * - alert_level 4 (critical): gpt-4o
 * - alert_level 2~3 (warn/error): gpt-4o-mini
 * - 이슈 없을 때: LLM 미호출
 *
 * 인사이트 저장소: ~/.openclaw/workspace/dexter-insights.json (최대 20개 FIFO)
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const { callWithFallback }          = require('../../../packages/core/lib/llm-fallback');
const { selectLLMChain }            = require('../../../packages/core/lib/llm-model-selector');
const { getPatterns, getNewErrors } = require('./error-history');
const cfg = require('./config');

const INSIGHTS_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'dexter-insights.json');
const MAX_INSIGHTS  = 20;

// KST 타임스탬프
function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// ── 인사이트 파일 I/O ────────────────────────────────────────────────

function loadInsights() {
  try {
    if (!fs.existsSync(INSIGHTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(INSIGHTS_FILE, 'utf8')) || [];
  } catch { return []; }
}

function saveInsight(insight) {
  try {
    const dir = path.dirname(INSIGHTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const list = loadInsights();
    list.push(insight);
    // FIFO: 최대 MAX_INSIGHTS개 보관
    const trimmed = list.slice(-MAX_INSIGHTS);
    fs.writeFileSync(INSIGHTS_FILE, JSON.stringify(trimmed, null, 2));
  } catch { /* 저장 실패 무시 */ }
}

// ── 프롬프트 ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 AI 에이전트 시스템의 시스템 진단 전문가입니다.
덱스터(Dexter)가 수집한 시스템 체크 결과를 분석하여 종합 진단을 제공합니다.
중요 원칙:
- 실제 체크 결과보다 과장하지 마세요.
- critical이 없고 error/warn 수가 적으면 보수적으로 표현하세요.
- 메모리, swap, 반복 오류는 "의심"과 "확정"을 구분하세요.
- 근거가 약하면 root_cause, prediction, action은 null로 두세요.
- trend는 분명한 악화 근거가 있을 때만 degrading을 사용하세요.
반드시 아래 JSON 형식으로만 응답하세요 (추가 텍스트 없이):

{
  "diagnosis":  "전체 상태 한줄 진단 (50자 이내)",
  "root_cause": "근본 원인 추정 (80자 이내, 판단 불가 시 null)",
  "trend":      "improving 또는 stable 또는 degrading",
  "prediction": "1~6시간 내 예상 위험 (80자 이내, 없으면 null)",
  "action":     "권장 조치 (80자 이내, 없으면 null)",
  "confidence": 0.0~1.0 사이 숫자
}`;

function buildUserPrompt(issues, patterns, newErrors, prevInsights, elapsedMs, summary) {
  const parts = [];

  parts.push(`## 판단 가드레일`);
  parts.push(`- critical=${summary.criticalCount}, error=${summary.errorCount}, warn=${summary.warnCount}`);
  parts.push(`- critical이 0이고 error 1건 이하, warn 2건 이하이면 과장된 진단을 피하고 stable 또는 제한적 위험만 사용`);
  parts.push(`- "시스템 안정성 저하", "추가 오류 발생 가능성 높음" 같은 강한 표현은 critical 또는 다중 반복 오류일 때만 사용`);

  parts.push(`## 현재 이슈 (${issues.length}건)`);
  if (issues.length > 0) {
    parts.push(issues.join('\n'));
  } else {
    parts.push('(없음)');
  }

  parts.push(`\n## 반복 오류 패턴 (최근 7일)`);
  if (patterns.length > 0) {
    parts.push(patterns.map(p => `[${p.check_name}] ${p.label}: ${p.cnt}회 반복 (최근: ${p.last_seen})`).join('\n'));
  } else {
    parts.push('(없음)');
  }

  parts.push(`\n## 신규 등장 오류 (최근 8시간)`);
  if (newErrors.length > 0) {
    parts.push(newErrors.map(e => `[${e.check_name}] ${e.label} (${e.status}): ${e.detail || '-'}`).join('\n'));
  } else {
    parts.push('(없음)');
  }

  if (prevInsights) {
    parts.push(`\n## 이전 진단 이력`);
    parts.push(prevInsights);
  }

  parts.push(`\n## 점검 소요 시간: ${(elapsedMs / 1000).toFixed(1)}초`);

  return parts.join('\n');
}

// ── 메인 분석 함수 ───────────────────────────────────────────────────

/**
 * OpenAI로 덱스터 체크 결과 종합 분석
 * @param {Array}  results   dexter check results
 * @param {number} elapsed   점검 소요 시간 (ms)
 * @param {number} level     alert_level (2=warn, 3=error, 4=critical)
 * @returns {Object|null}    insight 객체 or null (이슈 없거나 키 없을 때)
 */
function normalizeInsight(parsed, summary) {
  const insight = { ...parsed };
  const lowSeverityWindow =
    summary.criticalCount === 0 &&
    summary.errorCount <= 1 &&
    summary.warnCount <= 2;

  if (lowSeverityWindow) {
    if (insight.trend === 'degrading') insight.trend = 'stable';
    if (typeof insight.prediction === 'string' && insight.prediction.trim()) insight.prediction = null;
    if (typeof insight.diagnosis === 'string') {
      insight.diagnosis = insight.diagnosis
        .replace(/시스템 안정성 저하/g, '제한적 운영 경고')
        .replace(/심각한|높은|고위험/g, '주의 필요');
      if (insight.diagnosis.length > 50) insight.diagnosis = '제한적 운영 경고 및 확인 필요';
    }
  }

  if (!['improving', 'stable', 'degrading'].includes(insight.trend)) {
    insight.trend = lowSeverityWindow ? 'stable' : 'degrading';
  }

  if (typeof insight.confidence !== 'number' || Number.isNaN(insight.confidence)) {
    insight.confidence = lowSeverityWindow ? 0.45 : 0.65;
  }

  return insight;
}

async function analyzeWithAI(results, elapsed, level) {
  const policyOverride = cfg.RUNTIME?.llmSelectorOverrides?.['claude.dexter.ai_analyst'];
  const chain = selectLLMChain('claude.dexter.ai_analyst', {
    level,
    policyOverride,
  });
  const model  = chain[0]?.model || 'gpt-5.4';

  // 1. 이슈 항목 추출
  const issues = results.flatMap(r =>
    (r.items || [])
      .filter(i => i.status !== 'ok')
      .map(i => `[${r.name}] ${i.label}: ${i.detail || '-'} (${i.status})`)
  );

  if (issues.length === 0) return null;

  // 2. error-history 패턴·신규 오류
  const patterns  = getPatterns(7, 3);
  const newErrors = getNewErrors(8, 7);
  const summary = {
    criticalCount: results.filter(r => r.status === 'critical').length,
    errorCount: results.filter(r => r.status === 'error').length,
    warnCount: results.filter(r => r.status === 'warn').length,
  };

  // 3. 이전 인사이트 (최근 3개)
  const prevInsights = loadInsights().slice(-3)
    .map(i => `${i.timestamp}: ${i.diagnosis} (${i.trend})`).join('\n') || null;

  // 4. LLM 호출
  const { text } = await callWithFallback({
    chain,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(issues, patterns, newErrors, prevInsights, elapsed, summary),
    logMeta: { team: 'claude', bot: 'dexter', requestType: 'system_diagnosis' },
  });

  let parsed;
  try {
    parsed = JSON.parse(String(text || '{}'));
  } catch {
    return null;
  }
  if (!parsed.diagnosis) return null;
  parsed = normalizeInsight(parsed, summary);

  const insight = {
    ...parsed,
    model,
    timestamp:  kstNow(),
    issueCount: issues.length,
  };

  saveInsight(insight);
  return insight;
}

module.exports = { analyzeWithAI };
