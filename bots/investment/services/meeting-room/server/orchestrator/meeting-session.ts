// @ts-nocheck

import * as db from '../../../../shared/db.ts';
import { resolveAgentLLMRoute } from '../../../../shared/agent-llm-routing.ts';
import { callViaHub } from '../../../../shared/hub-llm-client.ts';
import { buildMeetingPlanNote } from '../adapters/stack-adapter.ts';
import { meetingRoomConfig, normalizeChair, normalizeMeetingType } from '../../config/meeting.config.ts';
import { writeMeetingMinutesMarkdown } from '../minutes.ts';

function iso(value: any = Date.now()) {
  return new Date(value).toISOString();
}

function compact(value: any, max = 1600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
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
    agendas.push({
      key: `decision:${component}`,
      kind: 'pending_decision',
      title: `C15 결정 대기: ${component}`,
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

function dataBriefForAgenda(agenda: any, planNote: any) {
  if (agenda.kind === 'market_segment') {
    const segment = agenda.segment || {};
    const gate = agenda.evidence?.gate;
    const regime = agenda.evidence?.regime;
    const signalCount = agenda.evidence?.strategySignals?.length || 0;
    const circuitCount = agenda.evidence?.circuitLocks?.length || 0;
    return [
      `${agenda.title}: ${segment.skipped ? `스킵(${segment.reason})` : '진행'}`,
      `게이트=${gate ? `${gate.deployment} score=${Number(gate.score ?? 0).toFixed(1)}` : '없음'}`,
      `레짐=${regime ? `${regime.current_regime || regime.dominant} source=${regime.source || 'n/a'}` : '없음'}`,
      `전략신호=${signalCount}건, 서킷=${circuitCount}건`,
    ].join('\n');
  }
  if (agenda.kind === 'pending_decision') return `C15 결정 대기 항목\n${compact(agenda.evidence, 900)}`;
  if (agenda.kind === 'transition_alert') return `레짐 전이 경보\n${compact(agenda.evidence, 900)}`;
  if (agenda.kind === 'circuit_locks') return `활성 서킷\n${compact(agenda.evidence, 900)}`;
  return planNote.briefMarkdown || 'plan-note 없음';
}

function deterministicAnalysis(agenda: any, planNote: any, agent = 'luna') {
  return [
    `[${agent}] ${agenda.title}`,
    '계산된 plan-note 지표만 사용한 advisory 분석입니다.',
    dataBriefForAgenda(agenda, planNote),
    '실거래/파라미터 변경 제안은 기록만 하며 적용하지 않습니다.',
  ].join('\n');
}

function deterministicGrill(agenda: any, insufficient = false) {
  const suffix = insufficient ? '근거 부족: 마스터 확인 필요.' : '근거: plan-note와 shadow stack.';
  return [
    `1. 최강 반대 논거: 표본과 최근 상태가 불충분하면 결정을 보류해야 한다. ${suffix}`,
    `2. 무효화 데이터: 최신 gate/regime/signal/circuit이 반대로 바뀌면 무효다. ${suffix}`,
    `3. 마스터 질문: 이 결정을 오늘 적용해야 하는가, 아니면 관찰만 충분한가? ${suffix}`,
    `4. 긴급성: 경계급이 아니면 즉시 실행보다 기록과 추적이 우선이다. ${suffix}`,
    `5. 과거 결과: 동유형 ADR/registry evidence를 확인해야 한다. ${suffix}`,
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
      ? `${agenda.title}: advisory 기록 후 마스터 확인 대기`
      : `${agenda.title}: shadow/advisory 상태로 관찰 지속`,
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
      'You are a Luna meeting-room research analyst. Use only the provided computed metrics. Reply in Korean, concise.',
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
  for (const row of result.decisions || []) {
    await runFn(
      `INSERT INTO luna_meeting_decisions (session_id, agenda_key, decision, grade, status, due_at, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [sessionId, row.agendaKey, row.decision, row.grade, row.status, row.dueAt, JSON.stringify(row.evidence || {})],
    );
  }
  return sessionId;
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
  const agendas = options.agendas || buildMorningMeetingAgendas(planNote);
  const minutes = [];
  const decisions = [];
  const context = {
    config,
    noLlm: options.noLlm === true,
    dryRun,
    allowDryRunLlm: options.allowDryRunLlm === true,
    llmCalls: 0,
    skippedLlmCalls: 0,
  };
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
    minutes.push({ seq: seq++, agendaKey: agenda.key, speaker: 'stack-adapter', role: 'data', content: dataBrief, meta: { state: 'data_brief', kind: agenda.kind } });

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

    const forceInsufficient = options.forceInsufficientGrill === true || agenda.forceInsufficientGrill === true;
    const grill = deterministicGrill(agenda, forceInsufficient);
    minutes.push({ seq: seq++, agendaKey: agenda.key, speaker: 'luna', role: 'grill', content: grill, meta: { state: 'grill', questions: config.grillQuestions } });

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
    result.session.id = await persistMeeting(result, deps);
  }
  const written = await writeMeetingMinutesMarkdown(result, options.outputPath);
  return { ...result, markdownPath: written.path, markdown: written.markdown };
}

export default {
  runMeetingSession,
  buildMorningMeetingAgendas,
};
