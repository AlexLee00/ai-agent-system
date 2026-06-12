// @ts-nocheck

import * as db from '../../../../shared/db.ts';
import { createRequire } from 'module';
import { executeInvestmentSkill } from '../../../../shared/skill-registry.ts';
import { resolveAgentLLMRoute } from '../../../../shared/agent-llm-routing.ts';
import { callViaHub } from '../../../../shared/hub-llm-client.ts';
import { buildMeetingPlanNote } from '../adapters/stack-adapter.ts';
import { meetingRoomConfig, normalizeChair, normalizeMeetingType } from '../../config/meeting.config.ts';
import { writeMeetingMinutesMarkdown } from '../minutes.ts';

const require = createRequire(import.meta.url);
const { postAlarm } = require('../../../../../../packages/core/lib/hub-alarm-client.js');

function iso(value: any = Date.now()) {
  return new Date(value).toISOString();
}

function compact(value: any, max = 1600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

const METRIC_LABELS = Object.freeze({
  brier_hmm_lt_fallback: 'Brier: HMM이 폴백보다 낮음',
  transition_alert_precision: '전이 경보 정밀도',
  halt_reduced_avoidance_delta: 'halt/reduced 회피 개선폭',
  nextbar_return_delta: 'Next-bar 수익률 차이',
  nextbar_trade_count_delta: 'Next-bar 거래 수 차이',
  grillCoverage: '그릴 커버리지',
  decisionTracking: '결정 추적',
  completedMeetings: '완료 회의 수',
  readyForPromotion: '승격 준비',
  haltRecommended: '중단 권고',
  minTrades: '최소 거래 수',
  placeholder: '임시 기준',
  durationWeeks: '관찰 주수',
  compareAgainst: '비교 기준',
});

const COMPONENT_LABELS = Object.freeze({
  'regime-engine-hmm': 'C15 레짐 엔진 HMM',
  'market-deployment-gate': 'C1 시장 배치 게이트',
  mapek: 'C15 MAPEK',
  'meeting-room-orchestrator': '회의실 오케스트레이터',
  'backtest-nextbar-execution': 'Next-bar 백테스트 실행',
  'circuit-locks': '서킷 잠금 알림',
});

function safeText(value: any, fallback = 'n/a') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function componentLabel(value: any) {
  const raw = safeText(value, 'unknown-component');
  return COMPONENT_LABELS[raw] || raw;
}

function humanProposalType(value: any, status: any = null) {
  const raw = String(value || status || '').trim();
  return {
    promotion_proposal: '승격 제안',
    halt_proposal: '중단 제안',
    stalled_report: '정체 보고',
    registry_review: '승격 검토',
    proposed: '승격 검토',
    stalled: '정체 보고',
    active: '승격 검토',
  }[raw] || safeText(raw, '검토');
}

function metricLabel(key: string) {
  return METRIC_LABELS[key] || key;
}

function criteriaSummary(criteria: any = {}) {
  const metrics = Array.isArray(criteria.metrics) ? criteria.metrics : [];
  const keyLabels = Object.keys(criteria || {})
    .filter((key) => !['metrics'].includes(key))
    .map((key) => `${metricLabel(key)}=${String(criteria[key])}`);
  const labels = [
    ...metrics.map(metricLabel),
    ...keyLabels,
  ];
  return labels.length ? labels.join(', ') : '명시 기준 없음';
}

function criteriaState(criteria: any = {}) {
  if (criteria.haltRecommended === true) return '중단 조건 충족';
  if (criteria.readyForPromotion === true) return '승격 조건 일부 충족';
  if (criteria.placeholder === true) return '미충족: 임시 기준';
  return '평가 대기';
}

function formatModeTransition(row: any = {}) {
  const current = row.currentMode || row.current_mode || row.mode || 'unknown';
  const target = row.targetMode || row.target_mode || row.target || 'unknown';
  const label = (value: any) => ({ unknown: '미정', active: '활성', stalled: '정체', proposed: '제안' }[String(value)] || String(value));
  return `${label(current)}→${label(target)}`;
}

function sampleCountForDecision(row: any = {}) {
  return Number(row.sampleCount ?? row.sample_count ?? row.evidence?.sampleCount ?? 0);
}

function criteriaForDecision(row: any = {}) {
  return row.criteria || row.promotion_criteria || row.evidence?.criteria || {};
}

function regimeLabel(value: any) {
  return {
    bull: '상승',
    bear: '하락',
    sideways: '수평',
    volatile: '변동',
  }[String(value || '')] || safeText(value, '없음');
}

function marketLabel(value: any) {
  return {
    domestic: '국내',
    overseas: '미국',
    crypto: '암호화폐',
  }[String(value || '')] || '시장 미상';
}

function segmentReasonLabel(value: any) {
  return {
    weekend: '주말',
    holiday: '휴장일',
    market_closed: '장 마감',
    kis_market_closed: '장 마감',
    crypto_24h: '24시간 운영',
    market_open: '정상 운영',
  }[String(value || '')] || (value ? '사유 확인 필요' : '사유 없음');
}

function summarizeGateTransitions(rows: any[] = []) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return '게이트 전이: 없음';
  return `게이트 전이: ${items.slice(0, 6).map((row: any = {}) => {
    const deployments = Array.isArray(row.deployments) ? row.deployments.join(', ') : safeText(row.deployment, '미정');
    const states = Number(row.deployment_states ?? row.states ?? 0) || deployments.split(',').filter(Boolean).length;
    return `${marketLabel(row.market)} ${Number(row.samples ?? 0)}표본 · 배치상태 ${states}종(${deployments})`;
  }).join(' / ')}${items.length > 6 ? ` 외 ${items.length - 6}건` : ''}`;
}

function summarizeRegimeTransitions(rows: any[] = []) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return '레짐 전이: 없음';
  return `레짐 전이: ${items.slice(0, 6).map((row: any = {}) => {
    const regimes = Array.isArray(row.regimes) ? row.regimes.map(regimeLabel).join(', ') : regimeLabel(row.regime || row.current_regime);
    const states = Number(row.regime_states ?? row.states ?? 0) || regimes.split(',').filter(Boolean).length;
    return `${marketLabel(row.market)} ${Number(row.samples ?? 0)}표본 · 레짐 ${states}종(${regimes})`;
  }).join(' / ')}${items.length > 6 ? ` 외 ${items.length - 6}건` : ''}`;
}

function summarizeUsPremarketEvidence(evidence: any = {}) {
  const lines = ['게이트/레짐/포지션/예정 이벤트를 읽기 전용으로 점검합니다.'];
  const gate = evidence.gate || null;
  const regime = evidence.regime || null;
  const positions = Array.isArray(evidence.positions) ? evidence.positions : [];
  const strategySignals = Array.isArray(evidence.strategySignals) ? evidence.strategySignals : [];
  const circuitLocks = Array.isArray(evidence.circuitLocks) ? evidence.circuitLocks : [];
  if (gate) {
    const score = gate.score == null ? '점수 미상' : `${Number(gate.score).toFixed(1)}점`;
    const signalRows = Array.isArray(gate.signals?.signals) ? gate.signals.signals : [];
    const available = signalRows.filter((row: any) => row?.available !== false).length;
    lines.push(`게이트=${gate.deployment || '미정'} ${score}${signalRows.length ? ` · 신호 ${available}/${signalRows.length}개 사용` : ''}`);
  }
  if (regime) {
    const probability = regime.dominant_probability ?? regime.confidence ?? null;
    const probabilityText = probability == null || Number.isNaN(Number(probability)) ? '' : `(${Number(probability).toFixed(2)})`;
    lines.push(`레짐=${regimeLabel(regime.current_regime || regime.dominant)}${probabilityText} · 출처=${regime.source ? String(regime.source).toUpperCase() : '미상'}`);
  }
  const entryCount = strategySignals.filter((row: any) => row?.signal_type === 'entry' || row?.signalType === 'entry').length;
  const positionSymbols = positions.map((row: any) => row?.symbol).filter(Boolean).slice(0, 5);
  lines.push(`전략 신호=${strategySignals.length}건(entry ${entryCount}건), 활성 서킷=${circuitLocks.length}건, 보유 포지션=${positions.length}건${positionSymbols.length ? `(${positionSymbols.join(', ')})` : ''}`);
  lines.push('상세 JSON은 감사 로그에 보존');
  return lines.join('\n');
}

function summarizeMeetingErrors(errors: any[] = []) {
  const items = Array.isArray(errors) ? errors : [];
  return items.length ? `오류: ${items.length}건 · 상세는 감사 로그에 보존` : '';
}

function debriefReasonLabel(value: any) {
  return {
    ok: '정상',
    same_day_morning_session_missing: '동일 날짜 아침 회의 없음',
  }[String(value || '')] || safeText(value, '확인 필요');
}

function summarizePendingDecision(row: any = {}) {
  const component = componentLabel(row.component || row.agenda_key || row.type);
  const criteria = criteriaForDecision(row);
  const type = humanProposalType(row.type, row.status);
  const sampleCount = sampleCountForDecision(row);
  const recommendation = row.recommendation || row.summary || row.notes || '후속 판단 대기';
  return [
    `C15 검토: 컴포넌트=${component}`,
    `유형=${type}, 상태=${safeText(row.status, 'n/a')}, 모드=${formatModeTransition(row)}`,
    `표본=${sampleCount}건, 기준=${criteriaSummary(criteria)}`,
    `판정=${criteriaState(criteria)}`,
    `제안 요지=${safeText(recommendation, '후속 판단 대기')}`,
  ].join('\n');
}

function summarizeCircuitLocks(rows: any[] = []) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = [
      row.market || 'unknown',
      row.symbol || '__market__',
      row.circuit || 'unknown',
    ].join('\u0001');
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const locks = Array.from(byKey.values());
  const lowProfit = locks.filter((row) => row.circuit === 'low_profit_symbol' || row.reason === 'cumulative_r_below_zero');
  const cooldown = locks.filter((row) => String(row.circuit || row.reason || '').includes('cooldown'));
  const lowProfitSymbols = [...new Set(lowProfit.map((row) => row.symbol).filter(Boolean))].slice(0, 5);
  const maxLockUntil = locks
    .map((row) => row.lock_until || row.lockUntil)
    .filter(Boolean)
    .sort()
    .at(-1) || 'n/a';
  return [
    `활성 잠금 ${locks.length}건(저수익 ${lowProfit.length}·쿨다운 ${cooldown.length})${lowProfitSymbols.length ? ` — 저수익 심볼 ${lowProfitSymbols.join(', ')}` : ''}`,
    `최장 잠금 만료=${maxLockUntil}`,
  ].join('\n');
}

function agendaKeyForSegment(segment: any) {
  return `market:${segment.market}`;
}

export function buildMorningMeetingAgendas(planNote: any = {}) {
  const agendas = [];
  for (const segment of planNote.segments || []) {
    agendas.push({
      key: agendaKeyForSegment(segment),
      kind: 'market_segment',
      title: segment.label || segment.market,
      market: segment.market,
      segment,
      evidence: {
        gate: (planNote.gates || []).find((row) => row.market === segment.market) || null,
        regime: (planNote.regimes || []).find((row) => row.market === segment.market) || null,
        strategySignals: (planNote.strategySignals || []).filter((row) => row.market === segment.market).slice(0, 20),
        circuitLocks: (planNote.circuitLocks || []).filter((row) => row.market === segment.market).slice(0, 20),
      },
    });
  }
  for (const decision of (planNote.pendingDecisions || []).slice(0, 8)) {
    const component = decision.component || decision.agenda_key || decision.type || 'pending';
    const componentTitle = componentLabel(component);
    agendas.push({
      key: `decision:${component}`,
      kind: 'pending_decision',
      title: `C15 결정 대기: ${componentTitle}`,
      market: 'any',
      evidence: decision,
      defaultGrade: 'c_master',
      defaultStatus: 'pending_master',
    });
  }
  const transitionAlerts = (planNote.regimes || []).filter((row) => row.transitionAlert);
  if (transitionAlerts.length > 0) {
    agendas.push({
      key: 'alerts:regime-transition',
      kind: 'transition_alert',
      title: '레짐 전이 경보',
      market: 'any',
      evidence: transitionAlerts,
      defaultGrade: 'c_master',
      defaultStatus: 'pending_master',
    });
  }
  if ((planNote.circuitLocks || []).length > 0) {
    agendas.push({
      key: 'alerts:circuit-locks',
      kind: 'circuit_locks',
      title: '활성 서킷 점검',
      market: 'any',
      evidence: planNote.circuitLocks,
      defaultGrade: 'c_master',
      defaultStatus: 'pending_master',
    });
  }
  return agendas;
}

export function buildDomesticDebriefAgendas(planNote: any = {}) {
  const debrief = planNote.debrief || {};
  return [{
    key: 'debrief:g6-plan-vs-actual',
    kind: 'domestic_debrief',
    title: '국내 마감 G6 대조표',
    market: 'domestic',
    evidence: debrief,
    defaultGrade: debrief.degraded ? 'c_master' : 'b_boundary',
    defaultStatus: 'pending_master',
  }];
}

export function buildUsPremarketAgendas(planNote: any = {}) {
  const segments = (planNote.segments || []).filter((row: any) => row.market === 'overseas');
  const overseasSegment = segments[0] || { market: 'overseas', label: '미국 프리마켓', active: true };
  const positions = (planNote.positions || []).filter((row: any) => String(row.exchange || row.market || '').includes('overseas') || row.market === 'overseas');
  return [
    {
      key: 'premarket:overseas-gate-regime',
      kind: 'us_premarket',
      title: '미국 프리마켓 게이트/레짐',
      market: 'overseas',
      segment: overseasSegment,
      evidence: {
        gate: (planNote.gates || []).find((row: any) => row.market === 'overseas') || null,
        regime: (planNote.regimes || []).find((row: any) => row.market === 'overseas') || null,
        positions: positions.slice(0, 20),
      },
      defaultGrade: 'b_boundary',
      defaultStatus: 'pending_master',
    },
    {
      key: 'premarket:overseas-watch',
      kind: 'us_premarket',
      title: '미국 보유/예정 이벤트 점검',
      market: 'overseas',
      evidence: {
        strategySignals: (planNote.strategySignals || []).filter((row: any) => row.market === 'overseas').slice(0, 20),
        circuitLocks: (planNote.circuitLocks || []).filter((row: any) => row.market === 'overseas').slice(0, 20),
        positions: positions.slice(0, 20),
      },
      defaultGrade: 'c_master',
      defaultStatus: 'pending_master',
    },
  ].slice(0, 2);
}

export function buildWeeklyMeetingAgendas(planNote: any = {}) {
  return [{
    key: 'weekly:shadow-stack-review',
    kind: 'weekly_review',
    title: '주간 Luna shadow stack/ADR 점검',
    market: 'any',
    evidence: planNote.weekly || {},
    defaultGrade: 'c_master',
    defaultStatus: 'pending_master',
  }];
}

export function buildMeetingAgendasForType(type: string, planNote: any = {}) {
  if (type === 'domestic_debrief') return buildDomesticDebriefAgendas(planNote);
  if (type === 'us_premarket') return buildUsPremarketAgendas(planNote);
  if (type === 'weekly') return buildWeeklyMeetingAgendas(planNote);
  return buildMorningMeetingAgendas(planNote);
}

function dataBriefForAgenda(agenda: any, planNote: any) {
  if (agenda.kind === 'market_segment') {
    const segment = agenda.segment || {};
    const gate = agenda.evidence?.gate;
    const regime = agenda.evidence?.regime;
    const signalCount = agenda.evidence?.strategySignals?.length || 0;
    const circuitCount = agenda.evidence?.circuitLocks?.length || 0;
    return [
      `${agenda.title}: ${segment.skipped ? `스킵(${segmentReasonLabel(segment.reason)})` : '진행'}`,
      `게이트=${gate ? `${gate.deployment} score=${Number(gate.score ?? 0).toFixed(1)}` : '없음'}`,
      `레짐=${regime ? `${regimeLabel(regime.current_regime || regime.dominant)} source=${regime.source ? String(regime.source).toUpperCase() : '없음'}` : '없음'}`,
      `전략신호=${signalCount}건, 서킷=${circuitCount}건`,
    ].join('\n');
  }
  if (agenda.kind === 'pending_decision') return summarizePendingDecision(agenda.evidence || {});
  if (agenda.kind === 'transition_alert') return `레짐 전이 경보\n${compact(agenda.evidence, 900)}`;
  if (agenda.kind === 'circuit_locks') return summarizeCircuitLocks(agenda.evidence || []);
  if (agenda.kind === 'domestic_debrief') {
    const evidence = agenda.evidence || {};
    return [
      `G6 대조표 날짜=${evidence.dateKst || 'n/a'} · ${evidence.degraded === true ? '데이터 보강 필요' : '정상'}`,
      `아침 회의=${evidence.morningSession?.id || '없음'} · 사유=${debriefReasonLabel(evidence.degradeReason || 'ok')}`,
      `전략 신호=${evidence.strategySignals?.length || 0}건, 프리플라이트=${evidence.preflights?.length || 0}건, 활성 서킷=${evidence.activeCircuits?.length || 0}건`,
      summarizeGateTransitions(evidence.gateTransitions || []),
      summarizeRegimeTransitions(evidence.regimeTransitions || []),
      `KIS 체결=${evidence.kisTrades?.length || 0}건`,
      `미발화 행=${evidence.unspokenEntries?.length || 0}건`,
      summarizeMeetingErrors(evidence.errors || []),
    ].filter(Boolean).join('\n');
  }
  if (agenda.kind === 'us_premarket') {
    return [
      `${agenda.title}`,
      summarizeUsPremarketEvidence(agenda.evidence || {}),
    ].join('\n');
  }
  if (agenda.kind === 'weekly_review') {
    const evidence = agenda.evidence || {};
    return [
      `주간 통계 as_of=${evidence.asOfKst || 'n/a'}`,
      `signals=${compact(evidence.signals || [], 700)}`,
      `preflight=${compact(evidence.preflight || [], 700)}`,
      `circuit=${compact(evidence.circuit || [], 700)}`,
      `brier=${compact(evidence.brier || [], 700)}`,
      `registry=${compact(evidence.registry || [], 500)}`,
      `ADR=${compact(evidence.adr || [], 500)} overdue=${evidence.overdueAdr?.length || 0}`,
      summarizeMeetingErrors(evidence.errors || []),
    ].filter(Boolean).join('\n');
  }
  return planNote.briefMarkdown || 'plan-note 없음';
}

function deterministicAnalysis(agenda: any, planNote: any, agent = 'luna') {
  return [
    `[${agent}] ${agenda.title}`,
    '계산된 회의 데이터 요약만 사용한 자문 분석입니다.',
    dataBriefForAgenda(agenda, planNote),
    '실거래/파라미터 변경 제안은 기록만 하며 적용하지 않습니다.',
  ].join('\n');
}

function deterministicGrill(agenda: any, insufficient = false) {
  const suffix = insufficient ? '근거 부족: 마스터 확인 필요.' : '근거: 회의 데이터 요약과 섀도 스택.';
  return [
    `1. 최강 반대 논거: 표본과 최근 상태가 불충분하면 결정을 보류해야 한다. ${suffix}`,
    `2. 무효화 데이터: 최신 게이트/레짐/신호/서킷이 반대로 바뀌면 무효다. ${suffix}`,
    `3. 마스터 질문: 이 결정을 오늘 적용해야 하는가, 아니면 관찰만 충분한가? ${suffix}`,
    `4. 긴급성: 경계급이 아니면 즉시 실행보다 기록과 추적이 우선이다. ${suffix}`,
    `5. 과거 결과: 동유형 ADR/레지스트리 근거를 확인해야 한다. ${suffix}`,
  ].join('\n');
}

function grillIsInsufficient(content: string) {
  const text = String(content || '').toLowerCase();
  const hasFive = [1, 2, 3, 4, 5].every((n) => text.includes(`${n}.`));
  return !hasFive || /insufficient|unknown|근거 부족|모름|불충분/.test(text);
}

function draftDecision(agenda: any, grillContent: string, options: any = {}) {
  const insufficient = grillIsInsufficient(grillContent);
  const grade = insufficient ? 'c_master' : (agenda.defaultGrade || 'a_rule');
  const status = grade === 'c_master' ? 'pending_master' : (agenda.defaultStatus || 'advisory');
  const dueAt = new Date(Date.parse(options.now || new Date().toISOString()) + Number(options.decisionDueHours || 24) * 3_600_000).toISOString();
  return {
    agendaKey: agenda.key,
    decision: insufficient
      ? `${agenda.title}: 자문 기록 후 마스터 확인 대기`
      : `${agenda.title}: 섀도/자문 상태로 관찰 지속`,
    grade,
    status,
    dueAt,
    evidence: {
      agendaKind: agenda.kind,
      title: agenda.title,
      grillInsufficient: insufficient,
      evidenceExcerpt: agenda.evidence || null,
      shadowOnly: true,
    },
  };
}

async function callAnalysisLLM(agenda: any, planNote: any, agent: string, context: any, deps: any = {}) {
  const route = (deps.resolveAgentLLMRoute || resolveAgentLLMRoute)(agent, agenda.market || 'any', agent === 'aria' ? 'technical_analysis' : 'sentiment');
  if (context.noLlm || route.noLLM) {
    context.skippedLlmCalls += 1;
    return { text: deterministicAnalysis(agenda, planNote, agent), skipped: true, reason: context.noLlm ? 'no_llm' : 'route_no_llm' };
  }
  if (context.dryRun && !context.allowDryRunLlm && typeof deps.callViaHub !== 'function') {
    context.skippedLlmCalls += 1;
    return { text: deterministicAnalysis(agenda, planNote, agent), skipped: true, reason: 'dry_run_llm_disabled' };
  }
  if (context.llmCalls >= context.config.maxLlmCallsPerMeeting) {
    context.skippedLlmCalls += 1;
    return { text: `cost_guard_skipped: max calls ${context.config.maxLlmCallsPerMeeting} reached`, skipped: true, reason: 'cost_guard_skipped' };
  }
  context.llmCalls += 1;
  try {
    const result = await (deps.callViaHub || callViaHub)(
      agent,
        'You are a Luna meeting-room research analyst. Use only the provided computed metrics. Reply in natural Korean reporting style. Keep score/status values unchanged; do not translate halt/reduced/full. Do not quote raw JSON or code blocks; express numbers in prose. Avoid greetings, filler transitions, repeated conclusions, and repeated bullet groups. Prefer one concise finding list plus one final action sentence.',
      [
        `안건: ${agenda.title}`,
        'Plan-note excerpt:',
        compact({ brief: planNote.briefMarkdown, evidence: agenda.evidence }, 1800),
      ].join('\n'),
      {
        maxTokens: context.config.maxTokensPerUtterance,
        market: agenda.market || 'any',
        taskType: agent === 'aria' ? 'technical_analysis' : 'sentiment',
        callerTeam: 'luna',
        urgency: 'low',
        timeoutMs: context.config.llmTimeoutMs,
      },
    );
    if (!result?.ok || !result.text) {
      context.skippedLlmCalls += 1;
      return { text: `${agent} LLM skipped: ${result?.error || 'empty_response'}`, skipped: true, reason: result?.error || 'llm_failed' };
    }
    return { text: result.text, skipped: false, provider: result.provider };
  } catch (error) {
    context.skippedLlmCalls += 1;
    return { text: `${agent} LLM skipped: ${error?.message || String(error)}`, skipped: true, reason: 'llm_exception' };
  }
}

function skillNameForAgenda(agenda: any, decisionGrade: string) {
  return decisionGrade === 'a_rule' ? 'grill-me' : 'grill-with-docs';
}

async function callGrill(agenda: any, planNote: any, context: any, deps: any = {}) {
  const candidateGrade = agenda.defaultGrade || 'a_rule';
  const skillName = skillNameForAgenda(agenda, candidateGrade);
  const executeSkill = deps.executeInvestmentSkill || executeInvestmentSkill;
  try {
    const result = await executeSkill('luna', skillName, {
      agenda,
      planNote: {
        type: planNote.type,
        generatedAt: planNote.generatedAt,
        briefMarkdown: planNote.briefMarkdown,
      },
      evidence: agenda.evidence || null,
      requirements: context.config.grillQuestions,
      hallucinationGuard: 'Use only provided plan-note/evidence. Do not invent citations.',
    }, {
      caller: 'luna-meeting-room',
      shadowOnly: true,
    });
    const text = result?.text || result?.content || result?.output || result?.markdown || '';
    if (result?.ok && String(text).trim()) {
      return { text: String(text), skillName, fallback: false, result };
    }
    return { text: deterministicGrill(agenda, context.forceInsufficientGrill), skillName, fallback: true, result };
  } catch (error) {
    return {
      text: deterministicGrill(agenda, context.forceInsufficientGrill),
      skillName,
      fallback: true,
      error: error?.message || String(error),
    };
  }
}

function buildMeetingDecisionCallbackData(decisionId: any, action: string) {
  const data = `luna_meeting:${decisionId}:${action}`;
  if (Buffer.byteLength(data, 'utf8') > 64) throw new Error('luna_meeting_callback_data_too_long');
  return data;
}

export function buildMeetingDecisionInlineKeyboard(decisions: any[] = []) {
  return decisions.slice(0, 9).map((decision: any) => ([
    { text: `✓확정 #${decision.id}`, callback_data: buildMeetingDecisionCallbackData(decision.id, 'confirm') },
    { text: `↻보류 #${decision.id}`, callback_data: buildMeetingDecisionCallbackData(decision.id, 'defer') },
  ]));
}

function buildTelegramMessage(result: any, pending: any[]) {
  const webUrl = process.env.MEETING_ROOM_PUBLIC_URL || process.env.MEETING_ROOM_URL || 'http://127.0.0.1:7791';
  const hidden = Math.max(0, pending.length - 9);
  return [
    `Luna 회의 ${result.type} 완료: pending_master ${pending.length}건`,
    `session=${result.session?.id || 'n/a'} minutes=${result.minutes?.length || 0}`,
    hidden > 0 ? `버튼은 상위 9건만 표시, 추가 ${hidden}건은 웹에서 처리` : '',
    `웹: ${webUrl}`,
  ].filter(Boolean).join('\n');
}

async function sendPendingMasterTelegram(result: any, deps: any = {}) {
  const pending = (result.decisions || []).filter((row: any) => row.status === 'pending_master' && row.id != null);
  if (!result.apply || result.dryRun || pending.length === 0) {
    return { attempted: false, ok: false, sentCount: 0, pendingCount: pending.length };
  }
  const inlineKeyboard = buildMeetingDecisionInlineKeyboard(pending);
  const postAlarmFn = deps.postAlarm || postAlarm;
  try {
    const sent = await postAlarmFn({
      message: buildTelegramMessage(result, pending),
      team: 'luna',
      alertLevel: 2,
      fromBot: 'luna-meeting-room',
      alarmType: 'work',
      visibility: 'human_action',
      actionability: 'needs_approval',
      eventType: 'luna_meeting_pending_master',
      incidentKey: `luna-meeting-${result.session?.id || result.startedAt}`,
      payload: {
        sessionId: result.session?.id || null,
        type: result.type,
        pendingDecisionIds: pending.map((row: any) => row.id),
        shadowOnly: true,
      },
      inlineKeyboard,
    });
    return {
      attempted: true,
      ok: sent?.ok === true,
      sentCount: sent?.ok === true ? 1 : 0,
      pendingCount: pending.length,
      result: sent,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      sentCount: 0,
      pendingCount: pending.length,
      error: error?.message || String(error),
    };
  }
}

async function persistMeeting(result: any, deps: any = {}) {
  if (!deps.runFn && typeof db.withTransaction === 'function') {
    return db.withTransaction(async (tx: any) => persistMeeting(result, { ...deps, runFn: tx.run }));
  }
  const runFn = deps.runFn || db.run;
  const sessionInsert = await runFn(
    `INSERT INTO luna_meeting_sessions (type, status, chair, segments, started_at, closed_at, summary)
     VALUES ($1,'closed',$2,$3::jsonb,$4,$5,$6)
     RETURNING id`,
    [
      result.session.type,
      result.session.chair,
      JSON.stringify(result.planNote?.segments || []),
      result.session.startedAt,
      result.session.closedAt,
      result.session.summary,
    ],
  );
  const sessionId = sessionInsert?.rows?.[0]?.id;
  if (!sessionId) throw new Error('luna_meeting_room_session_insert_failed');
  for (const row of result.minutes || []) {
    await runFn(
      `INSERT INTO luna_meeting_minutes (session_id, seq, agenda_key, speaker, role, content, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [sessionId, row.seq, row.agendaKey, row.speaker, row.role, row.content, JSON.stringify(row.meta || {})],
    );
  }
  const persistedDecisions = [];
  for (const row of result.decisions || []) {
    const inserted = await runFn(
      `INSERT INTO luna_meeting_decisions (session_id, agenda_key, decision, grade, status, due_at, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at`,
      [sessionId, row.agendaKey, row.decision, row.grade, row.status, row.dueAt, JSON.stringify(row.evidence || {})],
    );
    persistedDecisions.push(inserted?.rows?.[0] || row);
  }
  return { sessionId, decisions: persistedDecisions };
}

export async function runMeetingSession(options: any = {}, deps: any = {}) {
  const config = meetingRoomConfig(options.config || options);
  const type = normalizeMeetingType(options.type || config.type);
  const chair = normalizeChair(options.chair || config.chair);
  const dryRun = options.dryRun !== false || options.apply !== true;
  const startedAt = iso(options.now || Date.now());
  const planNote = options.planNote || await (deps.buildMeetingPlanNote || buildMeetingPlanNote)({
    type,
    now: startedAt,
    queryFn: deps.queryFn || options.queryFn || db.query,
    proposalPath: options.proposalPath,
  }, deps);
  const agendas = options.agendas || buildMeetingAgendasForType(type, planNote);
  const minutes = [];
  const decisions = [];
  const context = {
    config,
    noLlm: options.noLlm === true,
    dryRun,
    allowDryRunLlm: options.allowDryRunLlm === true,
    llmCalls: 0,
    skippedLlmCalls: 0,
    forceInsufficientGrill: options.forceInsufficientGrill === true,
  };
  if (type === 'us_premarket') {
    context.config.maxLlmCallsPerMeeting = Math.min(Number(context.config.maxLlmCallsPerMeeting || 0), 2);
  }
  let seq = 1;

  minutes.push({
    seq: seq++,
    agendaKey: 'session',
    speaker: 'system',
    role: 'system',
    content: 'open',
    meta: { state: 'open', type, chair },
  });

  for (const agenda of agendas) {
    const dataBrief = dataBriefForAgenda(agenda, planNote);
    minutes.push({
      seq: seq++,
      agendaKey: agenda.key,
      speaker: 'stack-adapter',
      role: 'data',
      content: dataBrief,
      meta: { state: 'data_brief', kind: agenda.kind, evidence: agenda.evidence || null },
    });

    for (const agent of (config.analysisAgents || []).slice(0, 2)) {
      const analysis = await callAnalysisLLM(agenda, planNote, agent, context, deps);
      minutes.push({
        seq: seq++,
        agendaKey: agenda.key,
        speaker: agent,
        role: analysis.reason === 'cost_guard_skipped' ? 'system' : 'analysis',
        content: analysis.text,
        meta: { state: 'analysis', skipped: analysis.skipped === true, reason: analysis.reason || null, provider: analysis.provider || null },
      });
    }

    context.forceInsufficientGrill = options.forceInsufficientGrill === true || agenda.forceInsufficientGrill === true;
    const grillResult = await callGrill(agenda, planNote, context, deps);
    const grill = grillResult.text;
    minutes.push({
      seq: seq++,
      agendaKey: agenda.key,
      speaker: 'luna',
      role: 'grill',
      content: grill,
      meta: {
        state: 'grill',
        questions: config.grillQuestions,
        skillName: grillResult.skillName,
        fallback: grillResult.fallback === true,
        error: grillResult.error || null,
      },
    });

    const decision = draftDecision(agenda, grill, { now: startedAt, decisionDueHours: config.decisionDueHours });
    decisions.push(decision);
    minutes.push({
      seq: seq++,
      agendaKey: agenda.key,
      speaker: 'luna',
      role: 'decision',
      content: decision.decision,
      meta: { state: 'decision_draft', grade: decision.grade, status: decision.status },
    });
    minutes.push({
      seq: seq++,
      agendaKey: agenda.key,
      speaker: 'adr',
      role: 'decision',
      content: `ADR recorded: ${decision.grade}/${decision.status}`,
      meta: { state: 'adr', evidence: decision.evidence },
    });
  }

  const closedAt = iso(options.closedAt || Date.now());
  const summary = `${type} 회의 완료: 안건 ${agendas.length}건, ADR ${decisions.length}건, LLM ${context.llmCalls}회`;
  minutes.push({ seq: seq++, agendaKey: 'session', speaker: 'system', role: 'system', content: 'close', meta: { state: 'close', summary } });
  const result = {
    ok: true,
    type,
    dryRun,
    apply: options.apply === true,
    startedAt,
    closedAt,
    session: { id: dryRun ? 'dry-run' : null, type, status: 'closed', chair, startedAt, closedAt, summary },
    planNote,
    agendas,
    minutes,
    decisions,
    llmCalls: context.llmCalls,
    skippedLlmCalls: context.skippedLlmCalls,
    shadowOnly: true,
    liveMutation: false,
    protectedPidMutation: false,
  };

  if (!dryRun) {
    const persisted = await persistMeeting(result, deps);
    result.session.id = persisted.sessionId;
    result.decisions = (persisted.decisions || result.decisions).map((row: any) => ({
      id: row.id,
      sessionId: row.session_id || row.sessionId || result.session.id,
      agendaKey: row.agenda_key || row.agendaKey,
      decision: row.decision,
      grade: row.grade,
      status: row.status,
      dueAt: row.due_at || row.dueAt,
      evidence: row.evidence || {},
      createdAt: row.created_at || row.createdAt,
    }));
  }
  result.telegram = await sendPendingMasterTelegram(result, deps);
  const written = await writeMeetingMinutesMarkdown(result, options.outputPath);
  return { ...result, markdownPath: written.path, markdown: written.markdown };
}

export default {
  runMeetingSession,
  buildMorningMeetingAgendas,
  buildDomesticDebriefAgendas,
  buildUsPremarketAgendas,
  buildWeeklyMeetingAgendas,
  buildMeetingAgendasForType,
  buildMeetingDecisionInlineKeyboard,
};
