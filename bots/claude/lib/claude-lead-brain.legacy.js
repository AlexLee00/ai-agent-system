'use strict';

/**
 * bots/claude/lib/claude-lead-brain.js — 클로드 팀장 두뇌
 *
 * 덱스터가 감지한 이슈를 Anthropic Sonnet으로 종합 판단.
 * Shadow Mode: 판단 결과는 shadow_log에만 기록 (기존 알림에 영향 없음).
 *
 * 판단 영역:
 *   1. 이슈 심각도 재평가 (덱스터 규칙 기반 vs Sonnet 판단)
 *   2. 복구 필요 여부 (독터에게 지시할지)
 *   3. 마스터 에스컬레이션 판단 (마스터에게 알릴지)
 *   4. 팀 간 영향도 분석 (스카/루나에게 알릴지)
 *
 * 현재: Shadow Mode (덱스터 직접 보고 유지)
 * 향후: Confirmation → LLM Primary 단계별 전환
 *
 * DB: PostgreSQL reservation.shadow_log (shadow-mode.js 공유 테이블)
 */

const pgPool    = require('../../../packages/core/lib/pg-pool');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const stateBus  = require('./state-bus-bridge.js');
const cfg = require('./config');

const SCHEMA  = 'reservation';   // shadow_log는 reservation 스키마

// 폴백 체인: gpt-4o → gpt-4o-mini → llama-4-scout (무료)
const LLM_CHAIN = selectLLMChain('claude.lead.system_issue_triage', {
  policyOverride: cfg.RUNTIME?.llmSelectorOverrides?.['claude.lead.system_issue_triage'],
});
const MODEL   = LLM_CHAIN[0].model;  // 로그 표시용
const TEAM    = 'claude-lead';
const CONTEXT = 'system_issue_triage';

// ── 팀장 자동화 모드 ─────────────────────────────────────────────────
/**
 * shadow      — 판단만 기록, 자동 실행 없음 (기본값)
 * confirmation — 독터 실행 전 마스터 확인 요청 (미구현)
 * auto_low    — 저위험 복구 자동 실행 (마스터 보고)
 * auto_all    — 전체 복구 자동 실행 (마스터 보고)
 */
const LEAD_MODES = ['shadow', 'confirmation', 'auto_low', 'auto_all'];

// 저위험으로 분류되는 task_type 목록
const LOW_RISK_ACTIONS = [
  'restart_launchd_service',
  'clear_lock_file',
  'rotate_log',
];

function _getLeadMode() {
  const mode = (process.env.CLAUDE_LEAD_MODE || 'shadow').toLowerCase();
  return LEAD_MODES.includes(mode) ? mode : 'shadow';
}

function isLowRiskCodeIntegrityIssue(issue) {
  const check = String(issue?.checkName || '').toLowerCase();
  const label = String(issue?.label || '').toLowerCase();
  return (
    check.includes('코드 무결성') ||
    check.includes('git 무결성') ||
    label.includes('git 상태') ||
    label.includes('git 변경사항') ||
    label.includes('체크섬')
  );
}

function isSoftShadowMatch(issues, ruleResult, llmResult) {
  const ruleDecision = String(ruleResult?.decision || '').toLowerCase();
  const llmDecision = String(llmResult?.decision || '').toLowerCase();
  if (!ruleDecision || !llmDecision) return false;
  if (ruleDecision === llmDecision) return true;

  const onlyLowRiskIntegrity = Array.isArray(issues) && issues.length > 0
    && issues.every(isLowRiskCodeIntegrityIssue);

  if (onlyLowRiskIntegrity) {
    const soft = new Set(['ignore', 'monitor']);
    return soft.has(ruleDecision) && soft.has(llmDecision);
  }

  return false;
}

function _isLowRisk(issues) {
  // 이슈가 모두 warn 이하이고 critical/error 없으면 저위험
  const hasCritical = issues.some(i => i.status === 'critical');
  const hasError    = issues.some(i => i.status === 'error');
  return !hasCritical && !hasError;
}

// ── 규칙 엔진 (덱스터 현재 동작 기준) ────────────────────────────────
/**
 * 이슈 목록을 규칙 기반으로 판단 (기존 덱스터 정책 반영)
 * @param {Array} issues  {checkName, label, status, detail}[]
 * @returns {object}      ruleResult
 */
function _ruleEngine(issues) {
  const hasCritical = issues.some(i => i.status === 'critical');
  const hasError    = issues.some(i => i.status === 'error');

  if (hasCritical) {
    const cnt = issues.filter(i => i.status === 'critical').length;
    return {
      decision:       'escalate',
      severity:       'critical',
      action:         'notify_master',
      reasoning:      `CRITICAL 이슈 ${cnt}건 감지 — 즉시 마스터 보고`,
      affected_teams: [],
    };
  }
  if (hasError) {
    const cnt = issues.filter(i => i.status === 'error').length;
    // 바이낸스 연결 실패 → 루나팀 실투자 직접 영향 → 즉시 에스컬레이션
    const hasBinanceError = issues.some(
      i => i.status === 'error' && (i.label || '').includes('바이낸스')
    );
    if (hasBinanceError) {
      return {
        decision:       'escalate',
        severity:       'critical',
        action:         'notify_master',
        reasoning:      '바이낸스 연결 실패 — 루나팀 실투자 주문/시세 차단 위험, 즉시 마스터 보고',
        affected_teams: ['luna'],
      };
    }
    return {
      decision:       'monitor',
      severity:       'high',
      action:         'log_only',
      reasoning:      `ERROR 이슈 ${cnt}건 감지 — 추이 관찰`,
      affected_teams: [],
    };
  }
  return {
    decision:       'monitor',
    severity:       'medium',
    action:         'log_only',
    reasoning:      `WARN 이슈 ${issues.length}건 감지 — 경미한 상태`,
    affected_teams: [],
  };
}

// ── Phase 3: 이슈 → 독터 태스크 매핑 ────────────────────────────────────

/**
 * 이슈 목록을 독터가 처리할 수 있는 복구 태스크로 매핑
 * @param {Array} issues  { checkName, label, status, detail }[]
 * @returns {{ taskType, params }[]}
 */
function _mapIssuesToDoctorTasks(issues) {
  const tasks = [];
  for (const issue of issues) {
    const label  = (issue.label  || '').toLowerCase();
    const detail = (issue.detail || '').toLowerCase();

    if (label.includes('앤디') || label.includes('naver-monitor')) {
      tasks.push({ taskType: 'restart_launchd_service', params: { label: 'ai.ska.naver-monitor' } });
    } else if (label.includes('지미') || label.includes('kiosk-monitor')) {
      tasks.push({ taskType: 'restart_launchd_service', params: { label: 'ai.ska.kiosk-monitor' } });
    } else if (label.includes('스카 커맨더') || label.includes('ska.commander')) {
      tasks.push({ taskType: 'restart_launchd_service', params: { label: 'ai.ska.commander' } });
    } else if (label.includes('루나 커맨더') || label.includes('investment.commander')) {
      tasks.push({ taskType: 'restart_launchd_service', params: { label: 'ai.investment.commander' } });
    } else if ((label.includes('secrets') || detail.includes('secrets')) && (label.includes('권한') || detail.includes('권한'))) {
      const match = (issue.detail || '').match(/(\/[^\s]+secrets\.json)/);
      if (match) tasks.push({ taskType: 'fix_file_permissions', params: { filePath: match[1] } });
    }
  }
  // 중복 제거 (같은 taskType+params 조합)
  const seen = new Set();
  return tasks.filter(t => {
    const key = `${t.taskType}:${JSON.stringify(t.params)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 프롬프트 ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 클로드 — AI 에이전트 시스템의 팀장입니다.
덱스터(시스템 점검봇)가 감지한 이슈 목록을 분석하여 종합 판단을 내립니다.

반드시 다음 JSON 형식으로만 응답하세요 (추가 텍스트 없이):
{
  "decision": "escalate|recover|monitor|ignore",
  "severity": "critical|high|medium|low",
  "action": "notify_master|run_doctor|notify_team|log_only",
  "reasoning": "판단 근거 1-2문장 (한국어)",
  "affected_teams": []
}

decision 기준:
- escalate: 마스터 즉시 보고 필요 (서비스 중단, 보안 위반, 실투자 위험)
- recover:  독터에게 자동 복구 지시 가능한 경우
- monitor:  이상 감지했으나 추이 관찰로 충분한 경우
- ignore:   일시적·무해한 상태 (예: git clean 상태, 정상 재시작)

action 기준:
- notify_master: 마스터 텔레그램 즉시 알림 (escalate와 동행)
- run_doctor:    독터 자동 복구 실행 (recover와 동행)
- notify_team:   관련 팀 알림 (스카/루나팀 영향 시)
- log_only:      로그 기록만 (monitor/ignore와 동행)

affected_teams: 이슈가 스카팀 또는 루나팀에 영향을 줄 경우 포함 (예: ["ska"], ["luna"], [])`;

function _buildUserPrompt(issues, ragContext = '') {
  const lines = issues.map((iss, i) =>
    `${i + 1}. [${iss.checkName}] ${iss.label}: ${iss.detail || '-'} (${iss.status})`
  );
  return `덱스터가 감지한 이슈 ${issues.length}건을 분석해주세요:\n\n${lines.join('\n')}${ragContext}`;
}

// ── 메인 평가 함수 ────────────────────────────────────────────────────
/**
 * 덱스터 체크 결과를 Sonnet으로 종합 판단 (Shadow Mode)
 * @param {Array} results  덱스터 results 배열 [{name, status, items:[{label,status,detail}]}]
 */
async function evaluateWithClaudeLead(results) {
  // Phase 2: 팀장 활동 시각 갱신 — 덱스터의 무응답 감지용
  try {
    const { DexterMode } = require('../lib/dexter-mode');
    new DexterMode().updateClaudeLeadActivity();
  } catch { /* 무시 */ }

  // 1. 비-ok 이슈 추출 (패턴 분석·자기진단 체크 제외 — 메타 노이즈 방지)
  const SKIP_CHECKS = ['오류 패턴 분석', '덱스터 자기진단', '자동 수정'];
  const issues = results.flatMap(r => {
    if (SKIP_CHECKS.includes(r.name)) return [];
    return (r.items || [])
      .filter(i => i.status !== 'ok')
      .map(i => ({ checkName: r.name, label: i.label, status: i.status, detail: i.detail || '' }));
  });

  if (issues.length === 0) return;  // 이슈 없으면 스킵

  const t0 = Date.now();

  // 2. 규칙 엔진 판단 (동기)
  const ruleResult = _ruleEngine(issues);

  // 3. Sonnet LLM 판단 (비동기, Shadow)
  // RAG 검색: 유사 과거 장애/복구 사례 조회 → LLM 컨텍스트 보강
  let ragContext = '';
  try {
    const ragSearch = require('../../../packages/core/lib/rag-safe');
    const ragQuery = issues.slice(0, 3).map(i => i.label).join(' ');
    const hits     = await ragSearch.search('operations', ragQuery, { limit: 3, threshold: 0.7 });
    if (hits.length > 0) {
      ragContext = '\n\n[과거 유사 장애/복구 사례]\n' + hits.map(h => {
        const m = h.metadata || {};
        const tag = m.category === 'recovery' ? '복구' : m.category === 'incident' ? '인시던트' : '기록';
        return `  [${tag}] ${h.content.slice(0, 80)}`;
      }).join('\n');
    }
  } catch { /* RAG 검색 실패 시 무시 */ }

  let llmResult = null;
  let llmError  = null;

  try {
    const { text, provider, model: usedModel, attempt } = await callWithFallback({
      chain:        LLM_CHAIN,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt:   _buildUserPrompt(issues, ragContext),
      logMeta: {
        team: 'claude',
        purpose: 'lead',
        bot: 'claude-lead',
        agentName: 'lead',
        selectorKey: 'claude.lead.system_issue_triage',
        requestType: 'system_issue_triage',
      },
    });
    if (attempt > 1 || usedModel !== MODEL) {
      console.log(`  ↳ [클로드 팀장] LLM 폴백: ${provider}/${usedModel} (시도 ${attempt})`);
    }
    // ```json ... ``` 마크다운 블록 제거
    const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    llmResult = JSON.parse(json);
    if (!llmResult.decision) llmResult = null;
  } catch (e) {
    llmError = e.message?.slice(0, 150) ?? '알 수 없는 오류';
  }

  // 4. 일치 여부
  const match = llmResult
    ? isSoftShadowMatch(issues, ruleResult, llmResult)
    : null;

  // 5. shadow_log 기록
  const elapsed      = Date.now() - t0;
  const inputSummary = issues
    .map(i => `[${i.checkName}] ${i.label}(${i.status})`)
    .join(' | ')
    .slice(0, 500);

  const leadMode = _getLeadMode();

  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO shadow_log
        (team, context, input_summary, rule_result, llm_result, llm_error, match, mode, elapsed_ms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      TEAM,
      CONTEXT,
      inputSummary,
      JSON.stringify(ruleResult),
      llmResult ? JSON.stringify(llmResult) : null,
      llmError  ?? null,
      match,
      leadMode,
      elapsed,
    ]);
  } catch (e) {
    console.warn('[claude-lead-brain] shadow_log INSERT 실패 (무시):', e.message);
  }

  // RAG 저장: 이슈 분석 이력을 rag_operations에 학습 데이터로 기록
  try {
    const ragStore = require('../../../packages/core/lib/rag-safe');
    const content = [
      `클로드팀장 이슈 분석: ${issues.length}건`,
      `판단: ${ruleResult.decision}`,
      `항목: ${issues.slice(0, 3).map(i => i.label).join(', ')}`,
    ].join(' | ');
    await ragStore.store('operations', content, {
      category:    'analysis',
      team:        'claude',
      decision:    ruleResult.decision,
      issue_count: issues.length,
      match:       match,
    }, 'claude-lead');
  } catch (e) {
    console.warn('[claude-lead-brain] RAG 저장 실패 (무시):', e.message);
  }

  // 6. Phase 2: team-bus agent_state 기록 (DB 기반 팀장 활동 추적)
  try {
    const teamBus = require('../lib/team-bus');
    await teamBus.setStatus('claude-lead', 'idle', `이슈 ${issues.length}건 분석 완료`);
  } catch { /* team-bus 실패 무시 */ }

  // 7. 판단 로그
  const icon = llmResult ? (match ? '✅' : '⚡') : '⚠️';
  const matchStr = llmResult
    ? ` — 규칙:${ruleResult.decision} / Sonnet:${llmResult.decision}${match ? ' (일치)' : ' (불일치!)'}`
    : ` — Sonnet 실패: ${llmError}`;
  console.log(`  ${icon} [클로드 팀장] 이슈 ${issues.length}건 Shadow 판단${matchStr}`);

  // Phase 3: 모드에 따라 독터 복구 태스크 발행
  // shadow: 기록만 (실행 없음)
  // auto_low: 저위험 이슈만 자동 실행
  // auto_all: 모든 이슈 자동 실행
  if (llmResult?.action === 'run_doctor' && leadMode !== 'shadow') {
    const isLow      = _isLowRisk(issues);
    const shouldRun  = leadMode === 'auto_all' || (leadMode === 'auto_low' && isLow);

    if (shouldRun) {
      try {
        const doctorTasks = _mapIssuesToDoctorTasks(issues);
        for (const dt of doctorTasks) {
          await stateBus.createTask('claude-lead', 'doctor', dt.taskType, dt.params, 'high');
        }
        if (doctorTasks.length > 0) {
          console.log(`  🏥 [클로드 팀장] 독터 복구 지시 ${doctorTasks.length}건 (모드: ${leadMode}) — ${doctorTasks.map(t => t.taskType).join(', ')}`);
        }
      } catch (e) {
        console.warn('[claude-lead-brain] 독터 태스크 발행 실패 (무시):', e.message);
      }
    } else if (leadMode === 'auto_low' && !isLow) {
      console.log(`  ⚠️ [클로드 팀장] auto_low 모드 — 고위험 이슈로 자동 실행 보류 (마스터 확인 필요)`);
    }
  } else if (llmResult?.action === 'run_doctor' && leadMode === 'shadow') {
    console.log(`  👁 [클로드 팀장] shadow 모드 — 독터 지시 기록만 (실행 보류)`);
  }
}

/**
 * shadow_log 기반 판단 품질 조회 (일치율 + 불일치 목록)
 * @param {number} days
 * @returns {Promise<{total, matched, matchRate, mismatches}>}
 */
async function getJudgmentQuality(days = 7) {
  try {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const rows = await pgPool.query(SCHEMA, `
      SELECT match, rule_result, llm_result, input_summary, created_at
      FROM shadow_log
      WHERE team = $1 AND context = $2 AND created_at > $3
      ORDER BY created_at DESC
      LIMIT 200
    `, [TEAM, CONTEXT, cutoff]);

    const total      = rows.length;
    const matched    = rows.filter(r => r.match === true).length;
    const matchRate  = total > 0 ? matched / total : null;
    const mismatches = rows
      .filter(r => r.match === false)
      .map(r => ({
        ruleDecision: r.rule_result?.decision,
        llmDecision:  r.llm_result?.decision,
        llmReasoning: r.llm_result?.reasoning,
        input:        r.input_summary?.slice(0, 100),
        at:           r.created_at,
      }));

    return { total, matched, matchRate, mismatches };
  } catch (e) {
    console.warn('[claude-lead-brain] 품질 조회 실패:', e.message);
    return { total: 0, matched: 0, matchRate: null, mismatches: [] };
  }
}

// ── agent_events 수신 처리 ─────────────────────────────────────────────

/**
 * 단일 agent_event 처리
 * Phase 1: 이벤트 수신 로그 + dexter_check_result는 shadow_log에 기록
 * @param {object} event  agent_events 레코드
 */
async function processAgentEvent(event) {
  const { id, from_agent, event_type, payload: rawPayload } = event;
  // payload는 TEXT 컬럼 → JSON 파싱 필요
  let p = {};
  try {
    p = typeof rawPayload === 'string' ? (JSON.parse(rawPayload) ?? {}) : (rawPayload ?? {});
  } catch { /* 파싱 실패 시 빈 객체 */ }

  switch (event_type) {
    case 'dexter_check_result': {
      // 이미 evaluateWithClaudeLead가 직접 Sonnet 평가를 수행하므로
      // Phase 1에서는 수신 확인 로그만 남김
      const icon = p.overall === 'error' ? '❌' : p.overall === 'warn' ? '⚠️' : '✅';
      console.log(
        `  [클로드 팀장] 이벤트 수신 — [${from_agent}/${event_type}]`,
        `${icon} ${p.overall?.toUpperCase()} (❌${p.errorCount ?? 0} ⚠️${p.warnCount ?? 0})`,
      );
      break;
    }

    case 'recovery_completed': {
      // Phase 3: 독터 복구 완료 이벤트 수신
      const icon = p.success ? '✅' : '❌';
      console.log(`  [클로드 팀장] 독터 복구 — ${icon} ${p.taskType}: ${p.message || ''}`);
      break;
    }

    default: {
      // 알 수 없는 이벤트 타입 — 일단 로그만
      console.log(`  [클로드 팀장] 이벤트 수신 — [${from_agent}/${event_type}] (미처리 타입)`);
      break;
    }
  }
}

/**
 * claude-lead 수신 미처리 이벤트 일괄 처리
 * 덱스터 실행 시 호출하여 event bus 소화
 */
async function pollAgentEvents() {
  let events;
  try {
    events = await stateBus.getUnprocessedEvents('claude-lead', 10);
  } catch (e) {
    console.warn('[claude-lead-brain] 이벤트 폴링 실패 (무시):', e.message);
    return;
  }
  if (!events || events.length === 0) return;

  console.log(`  [클로드 팀장] 미처리 이벤트 ${events.length}건 처리 중...`);
  for (const ev of events) {
    try {
      await processAgentEvent(ev);
      await stateBus.markEventProcessed(ev.id);
    } catch (e) {
      console.warn(`  [클로드 팀장] 이벤트 id=${ev.id} 처리 실패 (무시):`, e.message);
    }
  }
}

module.exports = { evaluateWithClaudeLead, getJudgmentQuality, processAgentEvent, pollAgentEvents, LEAD_MODES, _getLeadMode };
