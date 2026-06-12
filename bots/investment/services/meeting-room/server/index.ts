#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../../../shared/db.ts';
import { resolveAgentLLMRoute } from '../../../shared/agent-llm-routing.ts';
import { callViaHub } from '../../../shared/hub-llm-client.ts';
import { isDirectExecution } from '../../../shared/cli-runtime.ts';
import { buildMeetingPlanNote, buildMarketSegments } from './adapters/stack-adapter.ts';
import { runMeetingSession } from './orchestrator/meeting-session.ts';
import { applyMeetingDecisionAction } from './meeting-decision-actions.ts';
import { normalizeChair, normalizeMeetingType } from '../config/meeting.config.ts';

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.join(SERVICE_ROOT, 'web');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7791;
const MAX_BODY_BYTES = 1_000_000;
const ASK_LIMIT_PER_MINUTE = 2;
const ASK_LIMIT_PER_DAY = 20;
const STATIC_SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self' https://unpkg.com; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});
const JSON_SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
const AGENT_DISPLAY_LABELS = Object.freeze({
  luna: 'Luna',
  nemesis: 'Nemesis',
  aria: 'Aria',
  sophia: 'Sophia',
  argos: 'Argos',
  hermes: 'Hermes',
  oracle: 'Oracle',
  chronos: 'Chronos',
  zeus: 'Zeus',
  athena: 'Athena',
  sentinel: 'Sentinel',
  'adaptive-risk': 'Adaptive Risk',
  hephaestos: 'Hephaestos',
  hanul: 'Hanul',
  budget: 'Budget',
  scout: 'Scout',
  kairos: 'Kairos',
  'stock-flow': 'Stock Flow',
  sweeper: 'Sweeper',
  reporter: 'Reporter',
});
const AGENT_BRACKET_PATTERN = /\[(luna|nemesis|aria|sophia|argos|hermes|oracle|chronos|zeus|athena|sentinel|adaptive-risk|hephaestos|hanul|budget|scout|kairos|stock-flow|sweeper|reporter)\]/gi;

class HttpError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message || code);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function jsonResponse(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...JSON_SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function methodNotAllowed(res, allow = 'GET, HEAD') {
  jsonResponse(res, 405, { ok: false, error: 'method_not_allowed', message: '지원하지 않는 요청 방식입니다.' }, { allow });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body_too_large', '요청 본문이 너무 큽니다. 질문이나 메모를 줄여 주세요.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid_json', '요청 형식이 올바르지 않습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeSession(row = {}) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    chair: row.chair,
    segments: safeJson(row.segments, []),
    startedAt: row.started_at || row.startedAt,
    closedAt: row.closed_at || row.closedAt,
    summary: row.summary || '',
  };
}

function sessionStatusLabel(status) {
  return {
    open: '진행 중',
    running: '실행 중',
    completed: '완료',
    closed: '완료',
    failed: '실패',
  }[String(status || '').toLowerCase()] || '상태 미상';
}

function agendaLabel(key) {
  return {
    session: '세션',
    'market:domestic': '국내 장전 계획',
    'market:overseas': '미국 장후 평가',
    'market:crypto': '암호화폐 24시간 점검',
    'decision:regime-engine-hmm': 'C15 레짐 엔진 HMM',
    'decision:market-deployment-gate': 'C1 시장 배치 게이트',
    'decision:mapek': 'C15 MAPEK',
    'decision:meeting-room-orchestrator': '회의실 오케스트레이터',
    'decision:backtest-nextbar-execution': 'Next-bar 백테스트 실행',
    'alerts:circuit-locks': '서킷 잠금 알림',
    'debrief:g6-plan-vs-actual': '국내 마감 G6 대조표',
    'premarket:overseas-gate-regime': '미장 전 게이트·레짐 점검',
    'premarket:overseas-watch': '미장 전 감시 목록 점검',
    'weekly:shadow-stack-review': '주간 섀도 스택 리뷰',
  }[String(key || '')] || '안건';
}

function pendingDecisionCatchupLabel(row = {}) {
  const label = agendaLabel(row.agendaKey);
  let decision = String(row.decision || '').trim();
  decision = decision.replace(/^C15 결정 대기:\s*/u, '').trim();
  if (decision.startsWith(`${label}:`)) decision = decision.slice(label.length + 1).trim();
  return `${label}: ${decision || '마스터 확인 대기'}`;
}

function normalizeDecisionDisplayText(row = {}) {
  const label = agendaLabel(row.agenda_key || row.agendaKey);
  let decision = normalizeLegacyMinuteContent(row.decision);
  decision = decision.replace(/^C15 결정 대기:\s*/u, '').trim();
  if (label && label !== '안건' && decision.startsWith(`${label}:`)) {
    decision = decision.slice(label.length + 1).trim();
  }
  return decision || '마스터 확인 대기';
}

function componentLabel(key) {
  return {
    'regime-engine-hmm': 'C15 레짐 엔진 HMM',
    'C15 레짐 엔진 HMM': 'C15 레짐 엔진 HMM',
    'market-deployment-gate': 'C1 시장 배치 게이트',
    'C1 시장 배치 게이트': 'C1 시장 배치 게이트',
    mapek: 'C15 MAPEK',
    'C15 MAPEK': 'C15 MAPEK',
    'meeting-room-orchestrator': '회의실 오케스트레이터',
    '회의실 오케스트레이터': '회의실 오케스트레이터',
    'backtest-nextbar-execution': 'Next-bar 백테스트 실행',
    'Next-bar 백테스트 실행': 'Next-bar 백테스트 실행',
    'circuit-locks': '서킷 잠금 알림',
    '서킷 잠금 알림': '서킷 잠금 알림',
  }[String(key || '')] || '컴포넌트 미상';
}

function legacyMetricLabel(key) {
  return {
    brier_hmm_lt_fallback: 'Brier: HMM이 폴백보다 낮음',
    transition_alert_precision: '전이 경보 정밀도',
    halt_reduced_avoidance_delta: 'halt/reduced 회피 개선폭',
    nextbar_return_delta: 'Next-bar 수익률 차이',
    nextbar_trade_count_delta: 'Next-bar 거래 수 차이',
    placeholder: '임시 기준',
    durationWeeks: '관찰 주수',
    compareAgainst: '비교 기준',
    grillCoverage: '그릴 커버리지',
    decisionTracking: '결정 추적',
    completedMeetings: '완료 회의 수',
  }[key] || '지표';
}

function legacyDecisionTypeLabel(value, status) {
  const raw = String(value || status || '').trim();
  return {
    promotion_proposal: '승격 제안',
    halt_proposal: '중단 제안',
    stalled_report: '정체 보고',
    registry_review: '승격 검토',
    active: '승격 검토',
    stalled: '정체 보고',
    proposed: '승격 검토',
  }[raw] || raw || '검토';
}

function legacyComponentStateLabel(value) {
  const raw = String(value || '').trim();
  return {
    active: '활성',
    stalled: '정체',
    proposed: '제안',
    pending: '대기',
    unknown: '미정',
    'n/a': '정보 없음',
  }[raw] || raw || '정보 없음';
}

function legacyCriteriaValueLabel(value) {
  if (value === true) return '예';
  if (value === false) return '아니오';
  if (value == null) return '정보 없음';
  if (String(value) === 'unknown') return '미정';
  return String(value);
}

function legacyCriteriaSummary(criteria = {}) {
  const metrics = Array.isArray(criteria.metrics) ? criteria.metrics : [];
  const scalar = Object.keys(criteria || {})
    .filter((key) => key !== 'metrics')
    .map((key) => `${legacyMetricLabel(key)}=${legacyCriteriaValueLabel(criteria[key])}`);
  return [...metrics.map(legacyMetricLabel), ...scalar].join(', ') || '명시 기준 없음';
}

function legacyPendingDecisionSummary(row = {}) {
  const component = componentLabel(row.component || row.agenda_key || row.type || 'unknown-component');
  const current = row.currentMode || row.current_mode || row.mode || 'unknown';
  const target = row.targetMode || row.target_mode || row.target || 'unknown';
  const sampleCount = Number(row.sampleCount ?? row.sample_count ?? row.evidence?.sampleCount ?? 0);
  const criteria = row.criteria || row.promotion_criteria || row.evidence?.criteria || {};
  const recommendation = row.recommendation || row.summary || row.notes || '후속 판단 대기';
  return [
    `C15 검토: 컴포넌트=${component}`,
    `유형=${legacyDecisionTypeLabel(row.type, row.status)}, 상태=${legacyComponentStateLabel(row.status || 'n/a')}, 모드=${legacyComponentStateLabel(current)}→${legacyComponentStateLabel(target)}`,
    `표본=${sampleCount}건, 기준=${legacyCriteriaSummary(criteria)}`,
    `판정=${criteria.placeholder === true ? '미충족: 임시 기준' : '평가 대기'}`,
    `제안 요지=${recommendation}`,
  ].join('\n');
}

function normalizeC15PendingLabelNoise(content) {
  return String(content ?? '')
    .replace(/^(\[[^\]\n]+\]\s*)C15 결정 대기:\s*([^:\n]+)$/gm, '$1$2 검토')
    .replace(/^C15 결정 대기:\s*([^:\n]+):\s*/gm, '$1: ')
    .replace(/^C15 결정 대기:\s*컴포넌트=/gm, 'C15 검토: 컴포넌트=')
    .replace(/^C15 결정 대기 항목$/gm, 'C15 검토 항목')
    .replace(/^(\[[^\]\n]+\]\s*)C15 결정 대기\s+점검/gm, '$1C15 검토 점검')
    .replace(/^C15 결정 대기:\s*/gm, 'C15 검토: ');
}

function balancedJsonAt(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const ch = text[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString && ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function balancedJsonArrayAt(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const ch = text[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString && ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function summarizeLegacyCircuitLocks(rows = []) {
  const locks = Array.isArray(rows) ? rows : [];
  const lowProfit = locks.filter((row) => row?.circuit === 'low_profit_symbol' || row?.reason === 'cumulative_r_below_zero');
  const cooldown = locks.filter((row) => String(row?.circuit || row?.reason || '').includes('cooldown'));
  const symbols = [...new Set(locks.map((row) => row?.symbol).filter(Boolean))].slice(0, 5);
  return [
    `활성 서킷: ${locks.length}건(저수익 ${lowProfit.length}·쿨다운 ${cooldown.length})`,
    symbols.length ? `대표 심볼=${symbols.join(', ')}` : '',
    '상세 근거는 감사 로그에 보존',
  ].filter(Boolean).join('\n');
}

function transitionMarketLabel(value) {
  return { domestic: '국내', overseas: '미국', crypto: '암호화폐' }[String(value || '')] || '시장 미상';
}

function transitionRegimeLabel(value) {
  return { bull: '상승', bear: '하락', sideways: '수평', volatile: '변동' }[String(value || '')] || String(value || '미정');
}

function summarizeTransitionRows(field, rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  if (field === 'errors') {
    return items.length
      ? `오류: ${items.length}건 · 상세는 감사 로그에 보존`
      : '오류: 없음';
  }
  if (!items.length) return field === 'gate_transitions' ? '게이트 전이: 없음' : '레짐 전이: 없음';
  const summaries = items.slice(0, 6).map((row = {}) => {
    const market = transitionMarketLabel(row.market);
    const samples = Number(row.samples ?? row.sample_count ?? 0);
    if (field === 'gate_transitions') {
      const deployments = Array.isArray(row.deployments) ? row.deployments.join(', ') : String(row.deployment || '미정');
      const states = Number(row.deployment_states ?? row.states ?? 0);
      return `${market} ${samples}표본 · 배치상태 ${states || deployments.split(',').filter(Boolean).length}종(${deployments})`;
    }
    const regimes = Array.isArray(row.regimes) ? row.regimes.map(transitionRegimeLabel).join(', ') : transitionRegimeLabel(row.regime || row.current_regime);
    const states = Number(row.regime_states ?? row.states ?? 0);
    return `${market} ${samples}표본 · 레짐 ${states || regimes.split(',').filter(Boolean).length}종(${regimes})`;
  });
  const label = field === 'gate_transitions' ? '게이트 전이' : '레짐 전이';
  const suffix = items.length > summaries.length ? ` 외 ${items.length - summaries.length}건` : '';
  return `${label}: ${summaries.join(' / ')}${suffix}`;
}

function summarizePremarketEvidence(evidence = {}) {
  const lines = ['증거 요약'];
  const gate = evidence.gate || null;
  const regime = evidence.regime || null;
  const positions = Array.isArray(evidence.positions) ? evidence.positions : [];
  const strategySignals = Array.isArray(evidence.strategySignals) ? evidence.strategySignals : [];
  const circuitLocks = Array.isArray(evidence.circuitLocks) ? evidence.circuitLocks : [];
  if (gate) {
    const market = transitionMarketLabel(gate.market || 'overseas');
    const score = gate.score == null ? '점수 미상' : `${Number(gate.score).toFixed(1)}점`;
    const signalRows = Array.isArray(gate.signals?.signals) ? gate.signals.signals : [];
    const available = signalRows.filter((row) => row?.available !== false).length;
    lines.push(`게이트=${market} ${gate.deployment || '미정'} ${score}${signalRows.length ? ` · 신호 ${available}/${signalRows.length}개 사용` : ''}`);
  }
  if (regime) {
    const market = transitionMarketLabel(regime.market || 'overseas');
    const regimeValue = transitionRegimeLabel(regime.current_regime || regime.dominant);
    const probability = regime.dominant_probability ?? regime.confidence ?? null;
    const probabilityText = probability == null || Number.isNaN(Number(probability)) ? '' : `(${Number(probability).toFixed(2)})`;
    lines.push(`레짐=${market} ${regimeValue}${probabilityText} · 출처=${regime.source ? String(regime.source).toUpperCase() : '미상'}`);
  }
  if (strategySignals.length || circuitLocks.length || positions.length) {
    const entryCount = strategySignals.filter((row) => row?.signal_type === 'entry' || row?.signalType === 'entry').length;
    const positionSymbols = positions.map((row) => row?.symbol).filter(Boolean).slice(0, 5);
    lines.push(`전략 신호=${strategySignals.length}건(entry ${entryCount}건), 활성 서킷=${circuitLocks.length}건, 보유 포지션=${positions.length}건${positionSymbols.length ? `(${positionSymbols.join(', ')})` : ''}`);
  }
  if (lines.length === 1) lines.push('세부 항목 없음');
  lines.push('상세 JSON은 감사 로그에 보존');
  return lines.join('\n');
}

function replacePremarketEvidenceJson(content) {
  let next = String(content ?? '');
  if (!/(미국 프리마켓 게이트\/레짐|미국 보유\/예정 이벤트 점검)/.test(next)) return next;
  let searchFrom = 0;
  while (searchFrom < next.length) {
    const jsonStart = next.indexOf('{', searchFrom);
    if (jsonStart < 0) break;
    const jsonText = balancedJsonAt(next, jsonStart);
    let summary = '증거 요약\n상세 JSON은 감사 로그에 보존';
    let replaceEnd = next.length;
    if (jsonText) {
      try {
        summary = summarizePremarketEvidence(JSON.parse(jsonText));
      } catch {
        summary = '증거 요약\n상세 JSON은 감사 로그에 보존';
      }
      replaceEnd = jsonStart + jsonText.length;
    } else {
      const tailIndex = next.indexOf('\n실거래/파라미터', jsonStart);
      const truncatedIndex = next.indexOf('...[truncated]', jsonStart);
      if (tailIndex >= 0) replaceEnd = tailIndex;
      else if (truncatedIndex >= 0) replaceEnd = truncatedIndex + '...[truncated]'.length;
    }
    next = `${next.slice(0, jsonStart)}${summary}${next.slice(replaceEnd)}`;
    searchFrom = jsonStart + summary.length;
  }
  return next;
}

function replaceCompactArrayField(content, field) {
  let next = String(content ?? '');
  let searchFrom = 0;
  while (searchFrom < next.length) {
    const fieldIndex = next.indexOf(`${field}=`, searchFrom);
    if (fieldIndex < 0) break;
    const arrayStart = next.indexOf('[', fieldIndex);
    if (arrayStart < 0) break;
    const jsonText = balancedJsonArrayAt(next, arrayStart);
    if (!jsonText) {
      searchFrom = arrayStart + 1;
      continue;
    }
    try {
      const summary = summarizeTransitionRows(field, JSON.parse(jsonText));
      next = `${next.slice(0, fieldIndex)}${summary}${next.slice(arrayStart + jsonText.length)}`;
      searchFrom = fieldIndex + summary.length;
    } catch {
      const fallback = field === 'errors'
        ? '오류: 상세는 감사 로그에 보존'
        : `${field === 'gate_transitions' ? '게이트 전이' : '레짐 전이'}: 상세는 감사 로그에 보존`;
      next = `${next.slice(0, fieldIndex)}${fallback}${next.slice(arrayStart + jsonText.length)}`;
      searchFrom = fieldIndex + fallback.length;
    }
  }
  return next;
}

function normalizeCompactMeetingArrays(content) {
  return ['gate_transitions', 'regime_transitions', 'errors'].reduce(
    (text, field) => replaceCompactArrayField(text, field),
    String(content ?? ''),
  )
    .replace(/G6 대조표 날짜=([^\s]+)\s+degraded=true/g, 'G6 대조표 날짜=$1 · 데이터 보강 필요')
    .replace(/G6 대조표 날짜=([^\s]+)\s+degraded=false/g, 'G6 대조표 날짜=$1 · 정상')
    .replace(/morning=([^\s]+)\s+reason=same_day_morning_session_missing/g, '아침 회의=$1 · 사유=동일 날짜 아침 회의 없음')
    .replace(/morning=([^\s]+)\s+reason=ok/g, '아침 회의=$1 · 사유=정상')
    .replace(/signals=(\d+),\s*preflight=(\d+),\s*active_circuit=(\d+)/g, '전략 신호=$1건, 프리플라이트=$2건, 활성 서킷=$3건')
    .replace(/kis_trades=(\d+)/g, 'KIS 체결=$1건')
    .replace(/미발화 행=(\d+):\s*\[\]/g, '미발화 행=$1건');
}

function legacyDecisionAuditActionLabel(action) {
  return String(action || '').toLowerCase() === 'defer' ? '보류' : '확정';
}

function legacyDecisionAuditViaLabel(via) {
  return {
    telegram: '텔레그램',
    web: '웹',
  }[String(via || '').trim().toLowerCase()] || String(via || '웹');
}

function legacyDecisionAuditNoteLabel(note) {
  const trimmed = String(note || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'no note') return '메모 없음';
  return `메모=${trimmed}`;
}

function normalizeLegacyDecisionAuditContent(content) {
  return String(content ?? '')
    .replace(/^meeting decision\s+(confirm|defer)\s+via\s+([^:]+):\s*(.*)$/i, (_match, action, via, note) => (
      `결정 ${legacyDecisionAuditActionLabel(action)} 처리 · 경로=${legacyDecisionAuditViaLabel(via)} · ${legacyDecisionAuditNoteLabel(note)}`
    ))
    .replace(/^MR-B\s+(confirm|defer):\s*(.*)$/i, (_match, action, note) => (
      `결정 ${legacyDecisionAuditActionLabel(action)} 처리 · 경로=웹 · ${legacyDecisionAuditNoteLabel(note)}`
    ));
}

function normalizeLegacyMinuteContent(content) {
  const trimmed = String(content ?? '').trim().toLowerCase();
  if (trimmed === 'open') return '회의 시작';
  if (trimmed === 'closed') return '회의 종료';
  if (trimmed === 'close') return '회의 종료';
  const auditNormalized = normalizeLegacyDecisionAuditContent(content);
  const text = normalizeCompactMeetingArrays(replacePremarketEvidenceJson(auditNormalized)).replace(
    /\*{0,2}활성 서킷\*{0,2}\s*(?::|은)\s*(?:현재\s*)?\d+(?:개|건)?(?:의 서킷이 활성화되어 있습니다\.|입니다\.)?/g,
    '활성 서킷: 최신 데이터 영역 기준으로 봅니다',
  );
  let compactCircuitText = text;
  const circuitIndex = compactCircuitText.indexOf('활성 서킷');
  const arrayStart = circuitIndex >= 0 ? compactCircuitText.indexOf('[', circuitIndex) : -1;
  if (arrayStart >= 0) {
    const jsonText = balancedJsonArrayAt(compactCircuitText, arrayStart);
    const replaceStart = compactCircuitText.lastIndexOf('활성 서킷', arrayStart);
    const start = replaceStart >= 0 ? replaceStart : circuitIndex;
    if (jsonText) {
      try {
        compactCircuitText = `${compactCircuitText.slice(0, start)}${summarizeLegacyCircuitLocks(JSON.parse(jsonText))}${compactCircuitText.slice(arrayStart + jsonText.length)}`.trim();
      } catch {
        compactCircuitText = `${compactCircuitText.slice(0, start)}활성 서킷: 상세 근거는 감사 로그에 보존`;
      }
    } else {
      const tailIndex = compactCircuitText.indexOf('실거래/파라미터', arrayStart);
      const tail = tailIndex >= 0 ? `\n${compactCircuitText.slice(tailIndex)}` : '';
      compactCircuitText = `${compactCircuitText.slice(0, start)}활성 서킷: 상세 근거는 감사 로그에 보존${tail}`.trim();
    }
  }
  const readable = normalizeLegacyKoreanLlmNoise(compactCircuitText);
  const canonical = normalizeCanonicalStatusTokens(readable);
  const compacted = compactRepeatedSentences(normalizeLegacyBoilerplateHeadings(compactRepetitiveReportContent(canonical)));
  const marker = 'C15 결정 대기 항목';
  const markerIndex = compacted.indexOf(marker);
  if (markerIndex < 0) return normalizeC15PendingLabelNoise(compacted);
  const jsonStart = compacted.indexOf('{', markerIndex);
  if (jsonStart < 0) return normalizeC15PendingLabelNoise(compacted);
  const jsonText = balancedJsonAt(compacted, jsonStart);
  if (!jsonText) return normalizeC15PendingLabelNoise(compacted);
  try {
    const summary = legacyPendingDecisionSummary(JSON.parse(jsonText));
    return normalizeC15PendingLabelNoise(`${compacted.slice(0, markerIndex)}${summary}${compacted.slice(jsonStart + jsonText.length)}`.trim());
  } catch {
    return normalizeC15PendingLabelNoise(compacted);
  }
}

function normalizeCanonicalStatusTokens(content) {
  return String(content ?? '').split('\n').map((line) => {
    const isGateLine = /(?:G0\s*)?게이트|gate/i.test(line);
    const isMarketStatusLine = /시장.*상태/.test(line);
    const isMarketScoreLine = /시장.*(?:중단|감소|전체)\s*\(\d+(?:\.\d+)?점?\)/.test(line);
    const isAllMarketStatusSummary = /(?:국내|해외|미국|암호화폐|crypto).*(?:모두|각각).*(?:중단|감소|전체|halt|reduced|full)\s*상태/.test(line);
    const isMarketDeploymentLine = /(?:국내|해외|미국|암호화폐|crypto).*(?:중단|감소|전체|최대|halt|reduced|full)\s*상태/.test(line);
    if (!isGateLine && !isMarketStatusLine && !isMarketScoreLine && !isAllMarketStatusSummary && !isMarketDeploymentLine) return line;
    return line
      .replace(/['"“”‘’]할당['"“”‘’]\s*상태/g, 'halt 상태')
      .replace(/중단(?=\s*(?:,|，|\/|·|및|와|과|\(|상태|$))/g, 'halt')
      .replace(/감소(?=\s*(?:,|，|\/|·|및|와|과|\(|상태|$))/g, 'reduced')
      .replace(/전체(?=\s*(?:,|，|\/|·|및|와|과|\(|상태|$))/g, 'full')
      .replace(/최대(?=\s*(?:,|，|\/|·|및|와|과|\(|상태|$))/g, 'full');
  }).join('\n');
}

function canonicalDeploymentStatusToken(value) {
  const raw = String(value || '').trim();
  if (/^(?:중단|정지|할당|halt)$/i.test(raw)) return 'halt';
  if (/^(?:감소|줄인|reduced)$/i.test(raw)) return 'reduced';
  if (/^(?:전체|최대|full)$/i.test(raw)) return 'full';
  return raw || '미정';
}

function formatKstTimestampFromIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function agentDisplayLabel(value) {
  return AGENT_DISPLAY_LABELS[String(value || '').toLowerCase()] || '에이전트 미상';
}

function normalizeLegacyKoreanLlmNoise(content) {
  return String(content ?? '')
    .replace(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/g, (_match, iso) => formatKstTimestampFromIso(iso))
    .replace(/\bregime-engine-hmm\b/g, 'C15 레짐 엔진 HMM')
    .replace(/\bmarket-deployment-gate\b/g, 'C1 시장 배치 게이트')
    .replace(/\bmapek\b/g, 'C15 MAPEK')
    .replace(/\bmeeting-room-orchestrator\b/g, '회의실 오케스트레이터')
    .replace(/\bbacktest-nextbar-execution\b/g, 'Next-bar 백테스트 실행')
    .replace(/\bcircuit-locks\b/g, '서킷 잠금 알림')
    .replace(/\bcrypto\s+24h\s+점검/gi, '암호화폐 24시간 점검')
    .replace(/\bcrypto\s+24시간/gi, '암호화폐 24시간')
    .replace(/\bcrypto\s+요약/gi, '암호화폐 요약')
    .replace(/\bcrypto\s+시장/gi, '암호화폐 시장')
    .replace(/\bcrypto(?=\s*[:：])/gi, '암호화폐')
    .replace(/\bdomestic과/g, '국내와')
    .replace(/\bdomestic은/g, '국내는')
    .replace(/\bdomestic는/g, '국내는')
    .replace(/\bdomestic이/g, '국내가')
    .replace(/\bdomestic가/g, '국내가')
    .replace(/\boverseas과/g, '미국과')
    .replace(/\boverseas은/g, '미국은')
    .replace(/\boverseas는/g, '미국은')
    .replace(/\boverseas이/g, '미국이')
    .replace(/\boverseas가/g, '미국이')
    .replace(/\bcrypto과/g, '암호화폐와')
    .replace(/\bcrypto은/g, '암호화폐는')
    .replace(/\bcrypto는/g, '암호화폐는')
    .replace(/\bcrypto이/g, '암호화폐가')
    .replace(/\bcrypto가/g, '암호화폐가')
    .replace(/\bdomestic\b/g, '국내')
    .replace(/\boverseas\b/g, '미국')
    .replace(/\bcrypto\b/g, '암호화폐')
    .replace(/\badvisory\b/g, '자문')
    .replace(/\bplan-note와\s+shadow stack\b/g, '회의 데이터 요약과 섀도 스택')
    .replace(/\bplan-note\b/g, '회의 데이터 요약')
    .replace(/회의\s+회의 데이터 요약/g, '회의 데이터 요약')
    .replace(/회의 데이터 요약를/g, '회의 데이터 요약을')
    .replace(/(?:^|\n)segments:\s*\[[^\n]*\]\s*/g, '\n세그먼트: 상단 요약 기준입니다\n')
    .replace(/\bshadow stack\b/g, '섀도 스택')
    .replace(/\bread-only\b/g, '읽기 전용')
    .replace(/읽기\s+전용로/g, '읽기 전용으로')
    .replace(/\bregistry evidence\b/g, '레지스트리 근거')
    .replace(/\bgate_off_virtual\b/g, '게이트 비활성 가상 비교')
    .replace(/\bhalt_reduced_avoidance_delta\b/g, 'halt/reduced 회피 개선폭')
    .replace(/cost_guard_skipped:\s*max calls\s*(\d+)\s*reached/gi, '비용 가드: 최대 호출 $1회 도달로 발언 생략')
    .replace(/\bmax calls\b/gi, '최대 호출')
    .replace(/\bgate\/regime\/signal\/circuit\b/g, '게이트/레짐/신호/서킷')
    .replace(/해외/g, '미국')
    .replace(/미국\s+국내\s+시장/g, '국내 시장')
    .replace(/미국가/g, '미국이')
    .replace(/미국는/g, '미국은')
    .replace(/미국와/g, '미국과')
    .replace(/강세\s+상태/g, '상승 상태')
    .replace(/중립\s+상태/g, '수평 상태')
    .replace(/약세\s+상태/g, '하락 상태')
    .replace(/['"“”‘’]줄인['"“”‘’]\s*상태/g, 'reduced 상태')
    .replace(/줄인\s+상태/g, 'reduced 상태')
    .replace(/진행이\s*중단된\s*상태/g, 'halt 상태')
    .replace(/진행이\s*감소된\s*상태/g, 'reduced 상태')
    .replace(/중단된\s*상태/g, 'halt 상태')
    .replace(/완전한\s*상태/g, 'full 상태')
    .replace(/중단(?=\s*\(\d)/g, 'halt')
    .replace(/감소(?=\s*\(\d)/g, 'reduced')
    .replace(/전체(?=\s*\(\d)/g, 'full')
    .replace(/게이트가\s*정지\s*상태/g, '게이트가 halt 상태')
    .replace(/게이트가\s*감소(?:한)?\s*상태/g, '게이트가 reduced 상태')
    .replace(/정지\s*상태로\s*halt/gi, 'halt 상태로')
    .replace(/정지\s*상태\s*halt/gi, 'halt 상태')
    .replace(/정지\s*상태/g, 'halt 상태')
    .replace(/감소(?:한)?\s*상태로\s*reduced/gi, 'reduced 상태로')
    .replace(/감소(?:한)?\s*상태\s*reduced/gi, 'reduced 상태')
    .replace(/감소(?:한)?\s*상태/g, 'reduced 상태')
    .replace(/레짐=bull/g, '레짐=상승')
    .replace(/레짐=bear/g, '레짐=하락')
    .replace(/레짐=sideways/g, '레짐=수평')
    .replace(/레짐=volatile/g, '레짐=변동')
    .replace(/국내 시장은 상승 추세를 유지하고 있으며,\s*\d+(?:\.\d+)?의 점수가 기록되고 있습니다\.?/g, '국내 시장은 상승 레짐입니다.')
    .replace(/미국 시장은 중립적인 추세를 유지하고 있으며,\s*0\.\s*암호화폐 시장은 하락 추세를 유지하고 있으며,\s*0\.?/g, '미국 시장은 수평 레짐입니다. 암호화폐 시장은 하락 레짐입니다.')
    .replace(/미국 시장은 중립적인 추세를 유지하고 있으며,\s*\d+(?:\.\d+)?의 점수가 기록되고 있습니다\.?/g, '미국 시장은 수평 레짐입니다.')
    .replace(/암호화폐 시장은 하락 추세를 유지하고 있으며,\s*\d+(?:\.\d+)?의 점수가 기록되고 있습니다\.?/g, '암호화폐 시장은 하락 레짐입니다.')
    .replace(/\bbull\(([^)]+)\)/g, '상승($1)')
    .replace(/\bbear\(([^)]+)\)/g, '하락($1)')
    .replace(/\bsideways\(([^)]+)\)/g, '수평($1)')
    .replace(/\bvolatile\(([^)]+)\)/g, '변동($1)')
    .replace(/(국내|미국|암호화폐)\s+bull\b/g, '$1 상승')
    .replace(/(국내|미국|암호화폐)\s+bear\b/g, '$1 하락')
    .replace(/(국내|미국|암호화폐)\s+sideways\b/g, '$1 수평')
    .replace(/(국내|미국|암호화폐)\s+volatile\b/g, '$1 변동')
    .replace(AGENT_BRACKET_PATTERN, (_match, agent) => `[${agentDisplayLabel(agent)}]`)
    .replace(/\bscore=/g, '점수=')
    .replace(/\bsource=/g, '출처=')
    .replace(/출처=hmm/g, '출처=HMM')
    .replace(/상태=active/g, '상태=활성')
    .replace(/상태=unknown/g, '상태=미정')
    .replace(/모드=unknown→unknown/g, '모드=미정→미정')
    .replace(/placeholder 기준=true/g, '임시 기준=예')
    .replace(/placeholder 기준=false/g, '임시 기준=아니오')
    .replace(/placeholder 기준=예/g, '임시 기준=예')
    .replace(/placeholder 기준=아니오/g, '임시 기준=아니오')
    .replace(/미충족:\s*placeholder 기준/g, '미충족: 임시 기준')
    .replace(/Brier:\s*HMM<폴백/g, 'Brier: HMM이 폴백보다 낮음')
    .replace(/\bsame_bar_close\b/g, '동일봉 종가')
    .replace(/그릴 커버리지=true/g, '그릴 커버리지=예')
    .replace(/그릴 커버리지=false/g, '그릴 커버리지=아니오')
    .replace(/결정 추적=true/g, '결정 추적=예')
    .replace(/결정 추적=false/g, '결정 추적=아니오')
    .replace(/\badvisory\s+기록/g, '자문 기록')
    .replace(/ADR recorded:\s*c_master\/pending_master/g, 'ADR 기록: C 마스터 확인 / 마스터 액션 대기')
    .replace(
      /\*{0,2}결정 대기\*{0,2}\s*[:：]\s*(?:현재\s*)?\d+(?:개|건)(?:의\s*결정이\s*대기\s*중(?:입니다)?\.?|(?:\s*남아있다\.?)?)?/g,
      '결정 대기: 상단 캐치업 기준입니다',
    )
    .replace(
      /결정 대기[는가]?\s*\d+건(?:이)?\s*(?:대기\s*중(?:입니다)?|남아있다)\.?/g,
      '결정 대기: 상단 캐치업 기준입니다',
    )
    .replace(
      /결정 대기\s*중인\s*서킷은\s*\d+건(?:입니다)?\.?/g,
      '결정 대기: 상단 캐치업 기준입니다',
    )
    .replace(/활성 서킷:\s*최신 데이터 영역 기준으로 확인하세요/g, '활성 서킷: 최신 데이터 영역 기준으로 봅니다')
    .replace(/결정 대기:\s*상단 캐치업 기준으로 확인하세요/g, '결정 대기: 상단 캐치업 기준입니다')
    .replace(/전략군\s+24시간\s+동안\s+0건의\s+거래가\s+발생했습니다\.?/g, '전략군 24시간 신호 0건입니다.')
    .replace(/전략군\s+24시간\s+동안\s+(\d+)건의\s+입장\s*\(Entry\s*(\d+)\)\s*이 발생(?:하였으며|했습니다)?/gi, '전략군 24시간 신호 $1건(entry $2건)입니다')
    .replace(/입니다,\s*현재/g, '입니다. 현재')
    .replace(/프로\s*k?si/gi, '프록시')
    .replace(/프로끼/g, '프록시')
    .replace(/저평가\s+상태/g, '배치 halt 상태')
    .replace(/(\*{0,2}전략군\s+24시간\*{0,2}\s*:\s*0건\s*\()입장(\s*(?:없음|0)\))/g, '$1진입$2')
    .replace(/전략군\s+24시간:\s*0건\s*\(입장\s*0\)/g, '전략군 24시간: 0건(진입 0)')
    .replace(/전략군\s+24시간:\s*0건\s*\(입장\s*없음\)/g, '전략군 24시간: 0건(진입 없음)')
    .replace(/입장한\s+거래/g, '진입한 거래')
    .replace(/입장\s*\(Entry\s*0\)/gi, '진입(entry 0건)')
    .replace(/전략군은 현재 입장하지 않았으며/g, '전략군은 현재 진입하지 않았으며')
    .replace(/전략군의 입장을 고려/g, '전략군 진입을 고려')
    .replace(
      /((?:국내|미국|암호화폐) 시장은 현재 )(중단|감소|전체|최대|halt|reduced|full) 상태(?:로|이며),\s*(\d+(?:\.\d+)?)%의 활성 세그먼트가 유지되고 있습니다\.?/gi,
      (_match, prefix, status, score) => `${prefix}${canonicalDeploymentStatusToken(status)} 상태이며, 점수는 ${score}점입니다.`,
    )
    .replace(/(\d+(?:\.\d+)?)개의 이벤트가 진행 중입니다/g, '점수는 $1점입니다')
    .replace(/(확인하세요|기준입니다|봅니다)이며/g, '$1. ')
    .replace(/확인하세요\s+결과적으로,/g, '확인하세요. ')
    .replace(/(확인하세요|기준입니다|봅니다)\.\s*,\s*/g, '$1. ')
    .replace(/(확인하세요|기준입니다|봅니다)\.(?=[가-힣A-Za-z0-9])/g, '$1. ')
    .replace(/기준입니다(?=\s+[가-힣A-Za-z0-9])/g, '기준입니다.')
    .replace(/봅니다(?=\s+[가-힣A-Za-z0-9])/g, '봅니다.')
    .replace(/(기준입니다|봅니다)(?=[가-힣A-Za-z0-9])/g, '$1. ')
    .replace(/기준입니다\.(?=[가-힣A-Za-z0-9])/g, '기준입니다. ')
    .replace(/봅니다\.(?=[가-힣A-Za-z0-9])/g, '봅니다. ')
    .replace(/([^.\n。!?]+?)에 대한 분석 결과입니다\./g, '$1 분석입니다.')
    .replace(
      /(?:결과적으로,\s*)?[^。.!?\n]*?분석 결과는 다음과 같이 요약할 수 있습니다\.\s*/g,
      '',
    )
    .replace(
      /따라서,\s*[^.。!?]*?다음 조치를 취해야 합니다:\s*[^.。!?]*?(?:추가 분석을 수행하고,\s*)?[^.。!?]*?최종 결정을 내릴 수 있도록 하십시오\.?/g,
      '후속 조치는 마스터 확인 후 기록합니다.',
    )
    .replace(/따라서\s*최종 결정을 내릴 수 있도록 하십시오\.?/g, '후속 조치는 마스터 확인 후 기록합니다.')
    .replace(/따라서,\s*현 시점에서 추가적인 조치가 필요합니다\.?/g, '후속 조치는 마스터 확인 후 기록합니다.')
    .replace(/결과적으로,\s*현 시점에서 추가적인 조치가 필요하며,\s*[^.。!?\n]*?(?:필요합니다|권장됩니다)\.?/g, '')
    .replace(/후속 조치는 마스터 확인 후 기록합니다\.\s*(?:\n+)?후속 조치는 마스터 확인 후 기록합니다\./g, '후속 조치는 마스터 확인 후 기록합니다.')
    .replace(/(확인하세요|기준입니다|봅니다)이며/g, '$1. ')
    .replace(/(확인하세요|기준입니다|봅니다)\.\s*,\s*/g, '$1. ')
    .replace(/(기준입니다|봅니다)(?=[가-힣A-Za-z0-9])/g, '$1. ')
    .replace(/(확인하세요|기준입니다|봅니다)\.(?=[가-힣A-Za-z0-9])/g, '$1. ');
}

function compactRepetitiveReportContent(content) {
  const text = String(content ?? '');
  const phrase = '이러한 결과를 기반으로';
  if ((text.match(new RegExp(phrase, 'g')) || []).length < 2) return text;
  const paragraphs = text.split(/\n{2,}/);
  const kept = [];
  let seenPhrase = false;
  let removed = 0;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (paragraph.includes(phrase)) {
      if (seenPhrase) {
        removed += 1;
        const next = paragraphs[index + 1] || '';
        if (/^\s*-\s+/.test(next)) {
          index += 1;
          removed += 1;
        }
        continue;
      }
      seenPhrase = true;
    }
    kept.push(paragraph);
  }
  if (!removed) return text;
  return [
    kept.join('\n\n').trim(),
    `[표시 보정] 반복 결론 문단 ${removed}개를 축약했습니다. 원문은 감사 로그에 보존됩니다.`,
  ].filter(Boolean).join('\n\n');
}

function compactRepeatedSentences(content, minCount = 3) {
  const text = String(content ?? '');
  const sentencePattern = /[^.!?。！？\n]+[.!?。！？]+|[^.!?。！？\n]+(?=\n|$)/gu;
  const sentences = text.match(sentencePattern) || [];
  const counts = new Map();
  for (const rawSentence of sentences) {
    const sentence = rawSentence
      .replace(/^[\s>*\-•\d.)]+/u, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (sentence.length < 12) continue;
    counts.set(sentence, (counts.get(sentence) || 0) + 1);
  }
  const repeated = Array.from(counts.entries()).filter(([, count]) => count >= minCount);
  if (!repeated.length) return text;

  let compacted = text;
  let removed = 0;
  for (const [sentence, count] of repeated) {
    let seen = false;
    compacted = compacted.replace(sentencePattern, (rawSentence) => {
      const normalized = rawSentence
        .replace(/^[\s>*\-•\d.)]+/u, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized !== sentence) return rawSentence;
      if (!seen) {
        seen = true;
        return rawSentence;
      }
      removed += 1;
      return '';
    });
    if (count > 1) compacted = compacted.replace(/\n{3,}/g, '\n\n');
  }
  if (!removed) return text;
  return [
    compacted.trim(),
    `[표시 보정] 반복 문장 ${removed}개를 축약했습니다. 원문은 감사 로그에 보존됩니다.`,
  ].filter(Boolean).join('\n\n');
}

function normalizeLegacyBoilerplateHeadings(content) {
  return String(content ?? '')
    .replace(/이러한 결과를 기반으로,\s*최종 결론은 다음과 같습니다\.?/g, '요약 결론입니다.')
    .replace(/이러한 결과를 기반으로,\s*([^.\n]*?)에 대한 최종 결론은 다음과 같습니다\.?/g, '$1 요약 결론입니다.')
    .replace(/이러한 결과를 기반으로,\s*Luna 회의에서는 최종 결론을 다음과 같이 제시할 수 있습니다\.?/g, '요약 결론입니다.');
}

function normalizeMinute(row = {}) {
  return {
    id: row.id,
    sessionId: row.session_id || row.sessionId,
    seq: row.seq,
    agendaKey: row.agenda_key || row.agendaKey,
    speaker: row.speaker,
    role: row.role,
    content: normalizeLegacyMinuteContent(row.content),
    meta: safeJson(row.meta),
    createdAt: row.created_at || row.createdAt,
  };
}

function normalizeDecision(row = {}) {
  return {
    id: row.id,
    sessionId: row.session_id || row.sessionId,
    agendaKey: row.agenda_key || row.agendaKey,
    decision: normalizeDecisionDisplayText(row),
    grade: row.grade,
    status: row.status,
    dueAt: row.due_at || row.dueAt,
    evidence: safeJson(row.evidence),
    createdAt: row.created_at || row.createdAt,
  };
}

function getDeps(deps = {}) {
  return {
    queryFn: deps.queryFn || db.query,
    runFn: deps.runFn || db.run,
    withTransactionFn: deps.withTransactionFn || db.withTransaction,
    runMeetingSessionFn: deps.runMeetingSessionFn || runMeetingSession,
    buildMeetingPlanNoteFn: deps.buildMeetingPlanNoteFn || buildMeetingPlanNote,
    buildMarketSegmentsFn: deps.buildMarketSegmentsFn || buildMarketSegments,
    resolveAgentLLMRouteFn: deps.resolveAgentLLMRouteFn || resolveAgentLLMRoute,
    callViaHubFn: deps.callViaHubFn || callViaHub,
    meetingStore: deps.meetingStore || null,
  };
}

async function listMeetings(limit, deps) {
  if (deps.meetingStore?.listMeetings) return deps.meetingStore.listMeetings(limit);
  const rows = await deps.queryFn(
    `SELECT id, type, status, chair, segments, started_at, closed_at, summary
       FROM luna_meeting_sessions
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );
  return rows.map(normalizeSession);
}

function isNumericMeetingId(id) {
  return /^\d+$/.test(String(id ?? ''));
}

function allowedMethodsForApiPath(pathname, parts) {
  if (pathname === '/api/health') return 'GET';
  if (pathname === '/api/meetings') return 'GET';
  if (pathname === '/api/meetings/start') return 'POST';
  if (parts[0] === 'api' && parts[1] === 'meetings' && parts[2]) return 'GET';
  if (parts[0] === 'api' && parts[1] === 'catchup' && parts[2]) return 'GET';
  if (pathname === '/api/decisions/pending') return 'GET';
  if (parts[0] === 'api' && parts[1] === 'decisions' && parts[2]) return 'POST';
  if (pathname === '/api/agents/ask') return 'POST';
  return null;
}

async function getMeeting(id, deps) {
  if (deps.meetingStore?.getMeeting) {
    const stored = await deps.meetingStore.getMeeting(id);
    return {
      ...stored,
      session: normalizeSession(stored.session || {}),
      minutes: (stored.minutes || []).map(normalizeMinute),
      decisions: (stored.decisions || []).map(normalizeDecision),
    };
  }
  if (!isNumericMeetingId(id)) {
    throw new HttpError(404, 'meeting_not_found', `회의 ${id}를 찾을 수 없습니다.`);
  }
  const sessionRows = await deps.queryFn(
    `SELECT id, type, status, chair, segments, started_at, closed_at, summary
       FROM luna_meeting_sessions
      WHERE id = $1`,
    [id],
  );
  if (!sessionRows?.[0]) throw new HttpError(404, 'meeting_not_found', `회의 ${id}를 찾을 수 없습니다.`);
  const minuteRows = await deps.queryFn(
    `SELECT id, session_id, seq, agenda_key, speaker, role, content, meta, created_at
       FROM luna_meeting_minutes
      WHERE session_id = $1
      ORDER BY seq ASC`,
    [id],
  );
  const decisionRows = await deps.queryFn(
    `SELECT id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at
       FROM luna_meeting_decisions
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC`,
    [id],
  );
  return {
    ok: true,
    session: normalizeSession(sessionRows[0]),
    minutes: minuteRows.map(normalizeMinute),
    decisions: decisionRows.map(normalizeDecision),
  };
}

async function listPendingDecisions(deps) {
  if (deps.meetingStore?.listPendingDecisions) {
    return (await deps.meetingStore.listPendingDecisions()).map(normalizeDecision);
  }
  const rows = await deps.queryFn(
    `SELECT d.id, d.session_id, d.agenda_key, d.decision, d.grade, d.status, d.due_at, d.evidence, d.created_at,
            s.type AS session_type, s.started_at AS session_started_at
       FROM luna_meeting_decisions d
       JOIN luna_meeting_sessions s ON s.id = d.session_id
      WHERE d.status = 'pending_master'
      ORDER BY d.due_at ASC NULLS LAST, d.created_at DESC
      LIMIT 100`,
  );
  return rows.map((row) => ({
    ...normalizeDecision(row),
    sessionType: row.session_type,
    sessionStartedAt: row.session_started_at,
  }));
}

async function hasOpenMeetingType(type, deps) {
  if (deps.meetingStore?.hasOpenMeetingType) return deps.meetingStore.hasOpenMeetingType(type);
  const rows = await deps.queryFn(
    `SELECT id
       FROM luna_meeting_sessions
      WHERE type = $1 AND status = 'open'
      LIMIT 1`,
    [type],
  );
  return Boolean(rows?.[0]);
}

function buildCatchupFromDetail(detail) {
  const decisions = detail.decisions || [];
  const confirmed = decisions.filter((row) => row.status === 'confirmed');
  const deferred = decisions.filter((row) => row.status === 'deferred');
  const pending = decisions.filter((row) => row.status === 'pending_master');
  const next = pending.slice(0, 3).map(pendingDecisionCatchupLabel).join(' / ') || '없음';
  const sessionLabel = detail.session?.id ? `회의 ${detail.session.id}` : '회의 정보 없음';
  return [
    `확정 ${confirmed.length}건, 보류 ${deferred.length}건, 대기 ${pending.length}건`,
    `마스터 액션 필요: ${next}`,
    `${sessionLabel} · 회의록 ${(detail.minutes || []).length}행 · 최신 상태 ${sessionStatusLabel(detail.session?.status)}`,
  ];
}

function validateMeetingStart(type, now = new Date(), deps = {}) {
  const segments = (deps.buildMarketSegmentsFn || buildMarketSegments)(now);
  const domestic = segments.find((row) => row.market === 'domestic');
  const overseas = segments.find((row) => row.market === 'overseas');
  if (type === 'domestic_debrief' && domestic?.skipped) {
    throw new HttpError(409, 'segment_closed', '국내 시장 세그먼트가 휴장/비활성 상태입니다.', { segment: domestic });
  }
  if (type === 'us_premarket' && overseas?.skipped) {
    throw new HttpError(409, 'segment_closed', '미국 시장 세그먼트가 휴장/비활성 상태입니다.', { segment: overseas });
  }
  return segments;
}

async function updateDecision(id, action, note, deps) {
  if (deps.meetingStore?.updateDecision) return deps.meetingStore.updateDecision(id, action, note);
  return applyMeetingDecisionAction({
    id,
    action,
    note,
    changedVia: 'web',
  }, {
    withTransactionFn: deps.withTransactionFn,
  });
}

function createAskLimiter() {
  return { minuteBucket: '', minuteCount: 0, dayBucket: '', dayCount: 0 };
}

function checkAskRateLimit(limiter, now = new Date()) {
  const minuteBucket = now.toISOString().slice(0, 16);
  const dayBucket = now.toISOString().slice(0, 10);
  if (limiter.minuteBucket !== minuteBucket) {
    limiter.minuteBucket = minuteBucket;
    limiter.minuteCount = 0;
  }
  if (limiter.dayBucket !== dayBucket) {
    limiter.dayBucket = dayBucket;
    limiter.dayCount = 0;
  }
  if (limiter.minuteCount >= ASK_LIMIT_PER_MINUTE) {
    throw new HttpError(429, 'ask_rate_limited_minute', '분당 질의 한도에 도달했습니다. 1분 후 다시 시도하세요.');
  }
  if (limiter.dayCount >= ASK_LIMIT_PER_DAY) {
    throw new HttpError(429, 'ask_rate_limited_day', '일일 질의 한도에 도달했습니다. 다음 운영일에 다시 시도하세요.');
  }
  limiter.minuteCount += 1;
  limiter.dayCount += 1;
}

function agentAskFailureMessage() {
  return '에이전트 응답 생성에 실패했습니다. 잠시 후 다시 시도하세요.';
}

function deploymentLabel(value) {
  const raw = String(value || '').trim();
  return raw || '정보 없음';
}

function summarizeRuleBasedGates(planNote = {}) {
  return (Array.isArray(planNote.gates) ? planNote.gates : [])
    .slice(0, 3)
    .map((row = {}) => {
      const score = Number.isFinite(Number(row.score)) ? ` ${Number(row.score).toFixed(0)}점` : '';
      return `${transitionMarketLabel(row.market)} ${deploymentLabel(row.deployment)}${score}`;
    })
    .filter(Boolean);
}

function summarizeRuleBasedRegimes(planNote = {}) {
  return (Array.isArray(planNote.regimes) ? planNote.regimes : [])
    .slice(0, 3)
    .map((row = {}) => {
      const dominant = row.current_regime || row.dominant;
      return `${transitionMarketLabel(row.market)} ${transitionRegimeLabel(dominant)}`;
    })
    .filter(Boolean);
}

function summarizeRuleBasedSegments(planNote = {}) {
  return (Array.isArray(planNote.segments) ? planNote.segments : [])
    .filter((segment = {}) => segment.skipped || segment.active === false)
    .slice(0, 3)
    .map((segment = {}) => `${transitionMarketLabel(segment.market)} 비활성`);
}

function inferAskIntent(question) {
  const text = String(question || '').toLowerCase();
  if (/(시장\s*게이트|게이트|market gate|deployment)/u.test(text)) return 'gate';
  if (/(레짐|regime|hmm|전이)/u.test(text)) return 'regime';
  if (/(서킷|잠금|lock|circuit|쿨다운|cooldown)/u.test(text)) return 'circuit';
  if (/(전략|신호|signal|entry|진입)/u.test(text)) return 'strategy';
  if (/(결정|대기함|pending|confirm|defer|승인|보류)/u.test(text)) return 'decision';
  return 'general';
}

function orderRuleBasedPriorities(items, intent) {
  const orderByIntent = {
    gate: ['gate', 'regime', 'globalPending', 'circuit', 'registryPending', 'strategy', 'segment'],
    regime: ['regime', 'gate', 'circuit', 'globalPending', 'registryPending', 'strategy', 'segment'],
    circuit: ['circuit', 'globalPending', 'gate', 'regime', 'registryPending', 'strategy', 'segment'],
    strategy: ['strategy', 'regime', 'gate', 'globalPending', 'circuit', 'registryPending', 'segment'],
    decision: ['globalPending', 'registryPending', 'circuit', 'gate', 'regime', 'strategy', 'segment'],
    general: ['globalPending', 'registryPending', 'circuit', 'gate', 'regime', 'strategy', 'segment'],
  }[intent] || ['globalPending', 'registryPending', 'circuit', 'gate', 'regime', 'strategy', 'segment'];
  const weight = new Map(orderByIntent.map((key, index) => [key, index]));
  return [...items].sort((a, b) => (weight.get(a.key) ?? 99) - (weight.get(b.key) ?? 99));
}

function ruleBasedActionForIntent(intent, hasBlockingContext, context = {}) {
  if (intent === 'gate') {
    return hasBlockingContext
      ? '먼저 halt/reduced 시장의 근거와 관련 pending 결정을 대조하고, full 전환 전까지 신규 적용은 보수적으로 보세요.'
      : '시장 게이트가 바뀔 때까지 관찰을 유지하고, full/reduced/halt 전이가 생기면 다시 점검하세요.';
  }
  if (intent === 'regime') {
    return hasBlockingContext
      ? '레짐 전이와 시장 게이트가 같은 방향인지 확인하고, 충돌하면 신규 적용보다 관찰을 우선하세요.'
      : '레짐 확률 변화가 누적될 때까지 관찰하고, dominant 변경 시 다시 판단하세요.';
  }
  if (intent === 'circuit') {
    return hasBlockingContext
      ? '활성 서킷의 symbol·reason·lock_until을 먼저 확인하고, 잠금 해제 전 신규 적용을 보류하세요.'
      : '활성 서킷이 없으면 다음 회의까지 관찰을 유지하세요.';
  }
  if (intent === 'strategy') {
    if (Number(context.strategySignalCount || 0) === 0) {
      return '전략 신호가 부족하면 새 조치보다 데이터 축적을 우선하세요.';
    }
    if (Number(context.entryCount || 0) === 0) {
      return '최근 전략 신호 중 entry가 없으므로 신규 진입보다 exit/invalidate/관찰 신호인지 먼저 확인하세요.';
    }
    return hasBlockingContext
      ? '전략 entry 신호는 레짐·게이트·서킷과 함께 확인하고, 충돌하는 신호는 관찰 대상으로만 두세요.'
      : '전략 신호가 부족하면 새 조치보다 데이터 축적을 우선하세요.';
  }
  return hasBlockingContext
    ? '먼저 대기 결정의 근거 JSON과 활성 서킷 근거를 확인하고, 신규 적용보다 관찰 지속 여부를 결정하세요.'
    : '현재는 새 조치보다 다음 회의까지 관찰을 유지하고, 게이트·레짐 변화가 생기면 재질의하세요.';
}

function renderPendingDecisionContext(decisions = []) {
  const rows = Array.isArray(decisions) ? decisions : [];
  if (!rows.length) return '- 전역 결정 대기함: 0건';
  const examples = rows.slice(0, 5).map((row = {}) => {
    const label = agendaLabel(row.agendaKey);
    const decision = normalizeLegacyMinuteContent(row.decision || '').replace(/\s+/g, ' ').slice(0, 90);
    return `  - 결정 #${row.id} ${label}: ${decision || '마스터 확인 대기'}`;
  });
  const suffix = rows.length > examples.length ? `  - 외 ${rows.length - examples.length}건` : '';
  return [`- 전역 결정 대기함: ${rows.length}건`, ...examples, suffix].filter(Boolean).join('\n');
}

async function safeListPendingDecisions(deps) {
  try {
    return await listPendingDecisions(deps);
  } catch {
    return [];
  }
}

function buildRuleBasedAgentAnswer(agent, question, planNote = {}, globalPendingDecisions = []) {
  const intent = inferAskIntent(question);
  const globalPendingCount = Array.isArray(globalPendingDecisions) ? globalPendingDecisions.length : 0;
  const registryPendingCount = Array.isArray(planNote.pendingDecisions) ? planNote.pendingDecisions.length : 0;
  const lockCount = Array.isArray(planNote.circuitLocks) ? planNote.circuitLocks.length : 0;
  const signals = Array.isArray(planNote.strategySignals) ? planNote.strategySignals : [];
  const entryCount = signals.filter((row = {}) => row.signal_type === 'entry' || row.signalType === 'entry').length;
  const strategySignalCount = signals.length;
  const gates = summarizeRuleBasedGates(planNote);
  const regimes = summarizeRuleBasedRegimes(planNote);
  const inactiveSegments = summarizeRuleBasedSegments(planNote);
  const focus = {
    aria: '기술 관점',
    hephaestos: '체결 관점',
    budget: '자금 관점',
    sentinel: '위험 관점',
    luna: '운영 총괄 관점',
  }[agent] || '회의실 관점';
  const priorities = orderRuleBasedPriorities([
    globalPendingCount > 0 ? { key: 'globalPending', text: `전역 결정 대기 ${globalPendingCount}건` } : null,
    registryPendingCount > 0 ? { key: 'registryPending', text: `C15 검토 대기 ${registryPendingCount}건` } : null,
    lockCount > 0 ? { key: 'circuit', text: `활성 서킷 ${lockCount}건` } : null,
    gates.length ? { key: 'gate', text: `시장 게이트 ${gates.join(' · ')}` } : null,
    regimes.length ? { key: 'regime', text: `레짐 ${regimes.join(' · ')}` } : null,
    (intent === 'strategy' || strategySignalCount > 0) ? { key: 'strategy', text: `최근 전략 신호 ${strategySignalCount}건(entry ${entryCount}건)` } : null,
    inactiveSegments.length ? { key: 'segment', text: `비활성 세그먼트 ${inactiveSegments.join(' · ')}` } : null,
  ].filter(Boolean), intent).map((item) => item.text);
  const topPriority = priorities.length ? priorities.slice(0, 3).join(' / ') : '즉시 눈에 띄는 경보 없음';
  const action = ruleBasedActionForIntent(intent, globalPendingCount > 0 || registryPendingCount > 0 || lockCount > 0, {
    entryCount,
    strategySignalCount,
  });
  return [
    `[${agentDisplayLabel(agent)}] 비용 없는 규칙 기반 자문입니다.`,
    `${focus} 우선 확인: ${topPriority}.`,
    `권장 다음 행동: ${action}`,
    `질문 요지: ${String(question || '').slice(0, 160)}`,
  ].join('\n');
}

function normalizeAskAgentName(value) {
  const agent = String(value || 'luna').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(AGENT_DISPLAY_LABELS, agent)) return agent;
  throw new HttpError(400, 'invalid_agent', '지원하지 않는 에이전트입니다. 목록에서 에이전트를 선택하세요.');
}

async function askAgent(body, deps, limiter) {
  const agent = normalizeAskAgentName(body.agent);
  const question = String(body.question || '').trim();
  if (!question) throw new HttpError(400, 'question_required', '질문을 입력하세요.');
  checkAskRateLimit(limiter);

  const route = deps.resolveAgentLLMRouteFn(agent, 'any', 'meeting_room');
  const planNote = await deps.buildMeetingPlanNoteFn({
    type: 'morning',
    queryFn: deps.queryFn,
  });
  const globalPendingDecisions = await safeListPendingDecisions(deps);
  const globalPendingContext = renderPendingDecisionContext(globalPendingDecisions);
  if (route?.noLLM) {
    return {
      ok: true,
      skipped: true,
      agent,
      provider: 'rule_based',
      text: buildRuleBasedAgentAnswer(agent, question, planNote, globalPendingDecisions),
    };
  }

  try {
    const result = await deps.callViaHubFn(
      agent,
      'You are a Luna meeting-room agent. Answer in Korean. Use only the provided meeting context. Advisory only. Keep the response concise, avoid greetings and repeated conclusions, and do not translate status values such as halt/reduced/full.',
      [
        `Question: ${question}`,
        '',
        globalPendingContext,
        '',
        'Meeting context:',
        planNote.briefMarkdown || 'plan-note unavailable',
      ].join('\n'),
      {
        maxTokens: 512,
        market: 'any',
        taskType: 'meeting_room',
        callerTeam: 'luna',
        urgency: 'low',
        timeoutMs: 45_000,
      },
    );
    return {
      ok: result?.ok === true,
      agent,
      provider: result?.provider || null,
      text: normalizeLegacyMinuteContent(result?.text || ''),
      error: result?.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      agent,
      text: '',
      error: agentAskFailureMessage(),
      errorCode: 'agent_ask_failed',
    };
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  }[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res);
  const parsed = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(parsed.pathname === '/' ? '/index.html' : parsed.pathname);
  const target = path.resolve(WEB_ROOT, `.${pathname}`);
  if (target !== WEB_ROOT && !target.startsWith(`${WEB_ROOT}${path.sep}`)) {
    jsonResponse(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    jsonResponse(res, 404, { ok: false, error: 'not_found', message: '요청한 회의실 리소스를 찾을 수 없습니다.' });
    return;
  }
  if (!stat.isFile()) {
    jsonResponse(res, 404, { ok: false, error: 'not_found', message: '요청한 회의실 리소스를 찾을 수 없습니다.' });
    return;
  }
  res.writeHead(200, {
    'content-type': contentType(target),
    'content-length': stat.size,
    ...STATIC_SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

function assertAuthorized(req, token) {
  if (!token) return;
  const expected = `Bearer ${token}`;
  if (req.headers.authorization !== expected) {
    throw new HttpError(401, 'unauthorized', '토큰이 없거나 올바르지 않습니다.');
  }
}

function parseArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function createMeetingRoomWebServer(options = {}, rawDeps = {}) {
  const deps = getDeps(rawDeps);
  const token = options.token ?? process.env.MEETING_ROOM_TOKEN ?? '';
  const activeRuns = new Map();
  const activeTypes = new Map();
  const askLimiter = createAskLimiter();

  async function handleApi(req, res) {
    assertAuthorized(req, token);
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const parts = parsed.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && parsed.pathname === '/api/health') {
      return jsonResponse(res, 200, { ok: true, service: 'luna-meeting-room-web', shadowOnly: true });
    }

    if (req.method === 'GET' && parsed.pathname === '/api/meetings') {
      const meetings = await listMeetings(parsed.searchParams.get('limit') || 20, deps);
      return jsonResponse(res, 200, {
        ok: true,
        meetings,
        activeRuns: Array.from(activeRuns.values())
          .filter((run) => run.status === 'running')
          .map((run) => ({ ...run, promise: undefined })),
        segments: deps.buildMarketSegmentsFn(new Date()),
      });
    }

    if (parsed.pathname === '/api/meetings/start' && req.method !== 'POST') {
      return methodNotAllowed(res, 'POST');
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'meetings' && parts[2]) {
      const id = parts[2];
      if (activeRuns.has(id)) {
        const run = activeRuns.get(id);
        return jsonResponse(res, 200, { ok: true, run: { ...run, promise: undefined } });
      }
      return jsonResponse(res, 200, await getMeeting(id, deps));
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'catchup' && parts[2]) {
      const detail = activeRuns.has(parts[2])
        ? { session: activeRuns.get(parts[2]), minutes: [], decisions: [] }
        : await getMeeting(parts[2], deps);
      return jsonResponse(res, 200, { ok: true, lines: buildCatchupFromDetail(detail), meeting: detail.session });
    }

    if (req.method === 'GET' && parsed.pathname === '/api/decisions/pending') {
      return jsonResponse(res, 200, { ok: true, decisions: await listPendingDecisions(deps) });
    }

    if (req.method === 'POST' && parsed.pathname === '/api/meetings/start') {
      const body = await readBody(req);
      const type = normalizeMeetingType(body.type || 'morning');
      const chair = normalizeChair(body.chair || 'luna');
      validateMeetingStart(type, new Date(), deps);
      if (activeTypes.has(type) || await hasOpenMeetingType(type, deps)) {
        throw new HttpError(409, 'meeting_already_open', '이미 진행 중인 같은 타입 회의가 있습니다.');
      }
      const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const run = { id: runId, type, chair, status: 'running', startedAt: nowIso(), shadowOnly: true };
      activeRuns.set(runId, run);
      activeTypes.set(type, runId);
      run.promise = Promise.resolve()
        .then(() => deps.runMeetingSessionFn({
          type,
          chair,
          apply: true,
          dryRun: false,
          noLlm: body.noLlm !== false,
          outputPath: body.outputPath || null,
        }, rawDeps))
        .then((result) => {
          Object.assign(run, {
            status: 'completed',
            completedAt: nowIso(),
            sessionId: result?.session?.id || null,
            minutes: result?.minutes?.length || 0,
            decisions: result?.decisions?.length || 0,
            markdownPath: result?.markdownPath || null,
          });
          activeTypes.delete(type);
          return result;
        })
        .catch((error) => {
          Object.assign(run, { status: 'failed', completedAt: nowIso(), error: error?.message || String(error) });
          activeTypes.delete(type);
          return null;
        });
      return jsonResponse(res, 202, { ok: true, run: { ...run, promise: undefined } });
    }

    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'decisions' && parts[2]) {
      const body = await readBody(req);
      const action = String(body.action || '').trim();
      if (!['confirm', 'defer'].includes(action)) {
        throw new HttpError(400, 'invalid_action', '지원하지 않는 결정 처리 요청입니다.');
      }
      return jsonResponse(res, 200, await updateDecision(parts[2], action, body.note || '', deps));
    }

    if (req.method === 'POST' && parsed.pathname === '/api/agents/ask') {
      const body = await readBody(req);
      return jsonResponse(res, 200, await askAgent(body, deps, askLimiter));
    }

    const allowed = allowedMethodsForApiPath(parsed.pathname, parts);
    if (allowed) return methodNotAllowed(res, allowed);

    jsonResponse(res, 404, { ok: false, error: 'not_found', message: '요청한 회의실 리소스를 찾을 수 없습니다.' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if ((req.url || '/').startsWith('/api/')) return await handleApi(req, res);
      return serveStatic(req, res);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error?.statusCode || 500;
      jsonResponse(res, status, {
        ok: false,
        error: error?.code || 'internal_error',
        message: error?.message || String(error),
        details: error?.details || null,
      });
    }
  });

  return { server, activeRuns, activeTypes, askLimiter };
}

export function startMeetingRoomWebServer(options = {}, deps = {}) {
  const host = options.host || process.env.MEETING_ROOM_HOST || DEFAULT_HOST;
  const port = Number(options.port ?? process.env.MEETING_ROOM_PORT ?? DEFAULT_PORT);
  const created = createMeetingRoomWebServer(options, deps);
  return new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(port, host, () => {
      created.server.off('error', reject);
      resolve({ ...created, host, port: created.server.address()?.port || port });
    });
  });
}

if (isDirectExecution(import.meta.url)) {
  const host = parseArg('host', process.env.MEETING_ROOM_HOST || DEFAULT_HOST);
  const port = Number(parseArg('port', process.env.MEETING_ROOM_PORT || DEFAULT_PORT));
  const started = await startMeetingRoomWebServer({ host, port });
  console.log(`[luna-meeting-room-web] listening on http://${started.host}:${started.port}`);
  process.on('SIGTERM', () => started.server.close(() => process.exit(0)));
  process.on('SIGINT', () => started.server.close(() => process.exit(0)));
}

export default {
  createMeetingRoomWebServer,
  startMeetingRoomWebServer,
};

export {
  normalizeDecision,
  normalizeLegacyMinuteContent,
  normalizeMinute,
};

export const _testOnly = {
  agendaLabel,
  agentDisplayLabel,
  componentLabel,
  compactRepetitiveReportContent,
  legacyMetricLabel,
  normalizeCanonicalStatusTokens,
  normalizeLegacyMinuteContent,
  normalizeMinute,
  sessionStatusLabel,
};
