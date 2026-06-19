// @ts-nocheck

import fs from 'fs';
import path from 'path';
import * as db from '../../../shared/db.ts';
import { MEETING_ROOM_DEFAULTS } from '../config/meeting.config.ts';
import { regenerateMeetingMinutesMarkdown } from './minutes.ts';
import { runMeetingSession } from './orchestrator/meeting-session.ts';

export const LUNA_MEETING_ROOM_L_CONFIRM = 'luna-meeting-room-l-shadow';

function safeJson(value: any, fallback: any = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function iso(value: any = Date.now()) {
  return new Date(value).toISOString();
}

function kstDateKey(now: any = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizeLimit(value: any, fallback = 20) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function normalizeNumber(value: any, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function lookbackCutoffIso(options: any = {}, key = 'eventLookbackHours', fallbackHours = 24) {
  const hours = normalizeLimit(options[key], fallbackHours);
  return new Date(Date.parse(String(options.now || new Date())) - hours * 3_600_000).toISOString();
}

function canWrite(options: any = {}) {
  return options.apply === true
    && options.dryRun !== true
    && String(options.confirm || '').trim() === LUNA_MEETING_ROOM_L_CONFIRM;
}

function meetingMarkdownContainsSession(outputDir: string, sessionId: any) {
  const id = String(sessionId || '').trim();
  if (!id || !fs.existsSync(outputDir)) return false;
  const needles = [`회의 ID: ${id}`, `회의 #${id}`];
  for (const fileName of fs.readdirSync(outputDir)) {
    if (!fileName.endsWith('.md')) continue;
    const filePath = path.join(outputDir, fileName);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      if (needles.some((needle) => text.includes(needle))) return true;
    } catch {
      // Ignore unreadable historical output files.
    }
  }
  return false;
}

function decisionAlreadyReagendedToday(row: any = {}, now: any = Date.now()) {
  const evidence = safeJson(row.evidence);
  const entries = Array.isArray(evidence?.mr_l?.reagenda) ? evidence.mr_l.reagenda : [];
  const today = kstDateKey(now);
  return entries.some((item: any) => item?.dateKst === today);
}

export async function findDebriefBackfillCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const outputDir = path.resolve(options.outputDir || MEETING_ROOM_DEFAULTS.outputDir);
  const limit = normalizeLimit(options.limit, 20);
  const rows = await queryFn(
    `SELECT s.id, s.type, s.status, s.started_at, s.closed_at, s.summary,
            COUNT(m.id)::int AS minute_count
       FROM luna_meeting_sessions s
       LEFT JOIN luna_meeting_minutes m ON m.session_id = s.id
      WHERE s.status = 'closed'
        AND s.closed_at IS NOT NULL
      GROUP BY s.id, s.type, s.status, s.started_at, s.closed_at, s.summary
      ORDER BY s.closed_at DESC
      LIMIT $1`,
    [limit],
  );
  return (rows || [])
    .map((row: any) => {
      const hasMarkdown = meetingMarkdownContainsSession(outputDir, row.id);
      return {
        id: row.id,
        type: row.type,
        startedAt: row.started_at,
        closedAt: row.closed_at,
        summary: row.summary,
        minuteCount: Number(row.minute_count || 0),
        hasMarkdown,
        reason: Number(row.minute_count || 0) <= 0
          ? 'minutes_missing'
          : hasMarkdown ? 'already_generated' : 'markdown_missing',
      };
    })
    .filter((row: any) => row.minuteCount <= 0 || row.hasMarkdown !== true);
}

export async function findOverdueAdrCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 20);
  const now = options.now || Date.now();
  const rows = await queryFn(
    `SELECT id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at
       FROM luna_meeting_decisions
      WHERE status = 'pending_master'
        AND due_at IS NOT NULL
        AND due_at < NOW()
      ORDER BY due_at ASC, created_at ASC
      LIMIT $1`,
    [limit],
  );
  return (rows || [])
    .map((row: any) => ({ ...row, evidence: safeJson(row.evidence) }))
    .filter((row: any) => !decisionAlreadyReagendedToday(row, now))
    .map((row: any) => ({
      id: row.id,
      decisionId: row.id,
      sessionId: row.session_id,
      agendaKey: `adr-overdue:${row.id}`,
      originalAgendaKey: row.agenda_key,
      decision: row.decision,
      grade: row.grade,
      status: row.status,
      dueAt: row.due_at,
      evidence: row.evidence,
      dateKst: kstDateKey(now),
    }));
}

function buildOverdueAdrAgenda(row: any = {}) {
  return {
    key: row.agendaKey,
    kind: 'adr_overdue_reagenda',
    title: `기한 초과 ADR 재상정: ${row.originalAgendaKey || row.agendaKey}`,
    market: 'any',
    evidence: {
      type: 'adr_overdue_reagenda',
      decisionId: row.decisionId || row.id,
      sessionId: row.sessionId,
      originalAgendaKey: row.originalAgendaKey,
      decision: row.decision,
      dueAt: row.dueAt,
      dateKst: row.dateKst,
      evidence: row.evidence || {},
      advisoryOnly: true,
      shadowOnly: true,
    },
    defaultGrade: 'c_master',
    defaultStatus: 'pending_master',
  };
}

function normalizeCircuitLock(row: any = {}) {
  return {
    source: 'luna_circuit_locks',
    sourceId: row.id,
    agendaKey: `circuit:lock:${row.id}`,
    market: row.market,
    symbol: row.symbol,
    side: row.side,
    level: row.level,
    circuit: row.circuit,
    reason: row.reason,
    evidence: safeJson(row.evidence),
    occurredAt: row.evaluated_at,
    lockUntil: row.lock_until,
    advisoryOnly: true,
    shadowOnly: true,
  };
}

function normalizeCircuitEvent(row: any = {}) {
  const payload = safeJson(row.payload);
  return {
    source: 'circuit_breaker_events',
    sourceId: row.id,
    agendaKey: `circuit:event:${row.id}`,
    market: payload.market || payload.runtimeMarket || 'crypto',
    symbol: row.symbol,
    level: String(row.level ?? 'unknown'),
    circuit: row.action || 'circuit_breaker',
    reason: row.halted ? 'halted' : 'circuit_event',
    evidence: { feedback: safeJson(row.feedback), marketMode: safeJson(row.market_mode), payload },
    occurredAt: row.event_at,
    advisoryOnly: true,
    shadowOnly: true,
  };
}

async function filterExistingCircuitAgendas(candidates: any[] = [], queryFn: any) {
  return filterExistingMeetingAgendas(candidates, queryFn);
}

async function filterExistingMeetingAgendas(candidates: any[] = [], queryFn: any, options: any = {}) {
  const keys = candidates.map((row) => row.agendaKey).filter(Boolean);
  if (!keys.length) return candidates;
  const params = [keys];
  let sql = `SELECT agenda_key
       FROM luna_meeting_decisions
      WHERE agenda_key = ANY($1::text[])`;
  if (options.cutoff) {
    params.push(options.cutoff);
    sql += ` AND created_at >= $2::timestamptz`;
  }
  const rows = await queryFn(sql, params);
  const existing = new Set((rows || []).map((row: any) => row.agenda_key || row.agendaKey));
  return candidates.filter((row) => !existing.has(row.agendaKey));
}

export async function findCircuitMeetingCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 20);
  const lookbackHours = normalizeLimit(options.circuitLookbackHours, 24);
  const cutoff = new Date(Date.parse(String(options.now || new Date())) - lookbackHours * 3_600_000).toISOString();
  const lockRows = await queryFn(
    `SELECT id, market, symbol, side, level, circuit, reason, evidence, lock_until, evaluated_at
       FROM luna_circuit_locks
      WHERE locked IS TRUE
        AND shadow_only IS TRUE
        AND (lock_until IS NULL OR lock_until > NOW())
        AND evaluated_at >= $1::timestamptz
      ORDER BY evaluated_at DESC
      LIMIT $2`,
    [cutoff, limit],
  );
  const eventRows = await queryFn(
    `SELECT id, symbol, level, action, paper_mode, halted, feedback, market_mode, payload, event_at, inserted_at
       FROM circuit_breaker_events
      WHERE inserted_at >= $1::timestamptz
         OR event_at >= $1::timestamptz
      ORDER BY GREATEST(inserted_at, event_at) DESC
      LIMIT $2`,
    [cutoff, limit],
  );
  const candidates = [
    ...(lockRows || []).map(normalizeCircuitLock),
    ...(eventRows || []).map(normalizeCircuitEvent),
  ].slice(0, limit);
  return filterExistingCircuitAgendas(candidates, queryFn);
}

function normalizeRegimeShift(row: any = {}) {
  return {
    type: 'regime_shift',
    source: 'hmm_regime_log',
    agendaKey: `regime:shift:${row.market}:${row.previous_regime || row.prev_regime}:${row.current_regime}`,
    market: row.market,
    previousRegime: row.previous_regime || row.prev_regime,
    currentRegime: row.current_regime,
    confidence: Number(row.confidence ?? row.current_confidence ?? 0),
    occurredAt: row.created_at || row.current_created_at,
    evidence: {
      previousCreatedAt: row.previous_created_at || row.prev_created_at || null,
      currentCreatedAt: row.created_at || row.current_created_at || null,
      source: 'hmm_regime_log',
    },
    advisoryOnly: true,
    shadowOnly: true,
  };
}

export async function findRegimeShiftMeetingCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 20);
  const cutoff = lookbackCutoffIso(options, 'eventLookbackHours', 24);
  const rows = await queryFn(
    `WITH ranked AS (
       SELECT market, current_regime, confidence, created_at,
              ROW_NUMBER() OVER (PARTITION BY market ORDER BY created_at DESC) AS rn
         FROM hmm_regime_log
        WHERE symbol = '__market__'
          AND created_at >= $1::timestamptz
     )
     SELECT latest.market,
            prev.current_regime AS previous_regime,
            latest.current_regime,
            latest.confidence,
            latest.created_at,
            prev.created_at AS previous_created_at
       FROM ranked latest
       JOIN ranked prev ON prev.market = latest.market AND prev.rn = 2
      WHERE latest.rn = 1
        AND latest.current_regime <> prev.current_regime
      ORDER BY latest.created_at DESC
      LIMIT $2`,
    [cutoff, limit],
  );
  const candidates = (rows || [])
    .map(normalizeRegimeShift)
    .filter((row: any) => row.market && row.previousRegime && row.currentRegime && row.previousRegime !== row.currentRegime)
    .slice(0, limit);
  return filterExistingMeetingAgendas(candidates, queryFn, { cutoff });
}

function normalizeDisclosure(row: any = {}) {
  return {
    type: 'major_disclosure',
    source: 'corp_disclosures',
    sourceId: row.id,
    agendaKey: `disclosure:${row.id}`,
    market: 'domestic',
    symbol: row.stock_code,
    companyName: row.company_name,
    reportName: row.report_nm,
    reportType: row.report_type,
    importanceScore: Number(row.importance_score || 0),
    matchedSource: row.matched_source || row.match_source || null,
    occurredAt: row.submission_dt || row.collected_at || row.rcept_dt,
    evidence: {
      rceptNo: row.rcept_no || null,
      rceptDate: row.rcept_dt || null,
      summary: row.llm_summary || null,
      keywords: safeJson(row.keywords, []),
    },
    advisoryOnly: true,
    shadowOnly: true,
  };
}

export async function findDisclosureMeetingCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 20);
  const cutoff = lookbackCutoffIso(options, 'eventLookbackHours', 24);
  const minImportance = normalizeNumber(options.disclosureImportanceThreshold, 6);
  const rows = await queryFn(
    `SELECT d.id, d.stock_code, d.company_name, d.rcept_no, d.rcept_dt, d.submission_dt,
            d.report_nm, d.report_type, d.importance_score, d.llm_summary, d.keywords, d.collected_at,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM candidate_universe cu
                 WHERE cu.market = 'domestic'
                   AND cu.symbol = d.stock_code
                   AND cu.expires_at > NOW()
              ) THEN 'candidate_universe'
              WHEN EXISTS (
                SELECT 1 FROM positions p
                 WHERE p.exchange = 'kis'
                   AND p.symbol = d.stock_code
                   AND COALESCE(p.amount, 0) <> 0
              ) THEN 'position'
              ELSE NULL
            END AS matched_source
       FROM corp_disclosures d
      WHERE d.collected_at >= $1::timestamptz
        AND d.stock_code IS NOT NULL
        AND d.stock_code <> ''
        AND COALESCE(d.importance_score, 0) >= $2
        AND (
          EXISTS (
            SELECT 1 FROM candidate_universe cu
             WHERE cu.market = 'domestic'
               AND cu.symbol = d.stock_code
               AND cu.expires_at > NOW()
          )
          OR EXISTS (
            SELECT 1 FROM positions p
             WHERE p.exchange = 'kis'
               AND p.symbol = d.stock_code
               AND COALESCE(p.amount, 0) <> 0
          )
        )
      ORDER BY d.importance_score DESC, COALESCE(d.submission_dt, d.collected_at) DESC
      LIMIT $3`,
    [cutoff, minImportance, limit],
  );
  const candidates = (rows || [])
    .map(normalizeDisclosure)
    .filter((row: any) => row.sourceId && row.symbol && row.importanceScore >= minImportance && row.matchedSource)
    .slice(0, limit);
  return filterExistingMeetingAgendas(candidates, queryFn);
}

function normalizeDailyLoss(row: any = {}) {
  return {
    type: 'daily_loss_threshold',
    source: 'performance_daily',
    agendaKey: `daily-loss:${row.date}:${row.market}`,
    market: row.market,
    dateKst: row.date,
    pnlNet: Number(row.pnl_net || 0),
    pnlGross: Number(row.pnl_gross || 0),
    worstTradePnl: Number(row.worst_trade_pnl || 0),
    losingTrades: Number(row.losing_trades || 0),
    totalTrades: Number(row.total_trades || 0),
    occurredAt: row.created_at || row.date,
    evidence: {
      lossPatterns: safeJson(row.loss_patterns, []),
      thresholds: {
        pnlNet: -100,
        worstTradePnl: -50,
        losingTrades: 3,
      },
    },
    advisoryOnly: true,
    shadowOnly: true,
  };
}

export async function findDailyLossMeetingCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 20);
  const dateKst = options.dateKst || kstDateKey(options.now || Date.now());
  const pnlThreshold = normalizeNumber(options.dailyLossPnlThreshold, -100);
  const worstTradeThreshold = normalizeNumber(options.dailyLossWorstTradeThreshold, -50);
  const losingTradeThreshold = normalizeLimit(options.dailyLossLosingTradeThreshold, 3);
  const rows = await queryFn(
    `SELECT p.date, p.market, p.total_trades, p.losing_trades, p.pnl_gross, p.pnl_net, p.worst_trade_pnl, p.created_at,
            COALESCE(jsonb_agg(to_jsonb(lp) ORDER BY lp.extracted_at DESC)
              FILTER (WHERE lp.pattern_key IS NOT NULL), '[]'::jsonb) AS loss_patterns
       FROM performance_daily p
       LEFT JOIN luna_loss_patterns lp ON lp.market = p.market OR lp.market = 'all'
      WHERE p.date = $1
        AND (
          COALESCE(p.pnl_net, 0) <= $2
          OR COALESCE(p.worst_trade_pnl, 0) <= $3
          OR COALESCE(p.losing_trades, 0) >= $4
        )
      GROUP BY p.date, p.market, p.total_trades, p.losing_trades, p.pnl_gross, p.pnl_net, p.worst_trade_pnl, p.created_at
      ORDER BY p.pnl_net ASC
      LIMIT $5`,
    [dateKst, pnlThreshold, worstTradeThreshold, losingTradeThreshold, limit],
  );
  const candidates = (rows || [])
    .map(normalizeDailyLoss)
    .filter((row: any) => row.market && (
      row.pnlNet <= pnlThreshold
      || row.worstTradePnl <= worstTradeThreshold
      || row.losingTrades >= losingTradeThreshold
    ))
    .slice(0, limit);
  return filterExistingMeetingAgendas(candidates, queryFn);
}

function normalizeRiskLog(row: any = {}) {
  return {
    type: 'risk_log_severe',
    source: 'risk_log',
    sourceId: row.id || row.trace_id,
    agendaKey: `risk:log:${row.id || row.trace_id}`,
    market: row.exchange === 'kis' ? 'domestic' : row.exchange === 'kis_overseas' ? 'overseas' : 'crypto',
    symbol: row.symbol,
    exchange: row.exchange,
    decision: row.decision,
    riskScore: Number(row.risk_score || 0),
    reason: row.reason,
    occurredAt: row.evaluated_at,
    evidence: { traceId: row.trace_id || null },
    advisoryOnly: true,
    shadowOnly: true,
  };
}

function normalizeRiskSimulation(row: any = {}) {
  return {
    type: 'risk_simulation_severe',
    source: 'luna_risk_simulation_shadow',
    sourceId: row.id,
    agendaKey: `risk:simulation:${row.id}`,
    market: row.market,
    exchange: row.exchange,
    symbols: safeJson(row.symbols, []),
    analysisType: row.analysis_type,
    var99: Number(row.var_99 || 0),
    cvar99: Number(row.cvar_99 || 0),
    maxLossEstimate: Number(row.max_loss_estimate || 0),
    dataHealth: row.data_health,
    occurredAt: row.observed_at,
    evidence: {
      riskLimits: safeJson(row.risk_limits),
      scenarioMetrics: safeJson(row.scenario_metrics),
    },
    advisoryOnly: true,
    shadowOnly: true,
  };
}

export async function findRiskMeetingCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 20);
  const cutoff = lookbackCutoffIso(options, 'eventLookbackHours', 24);
  const minRiskScore = normalizeNumber(options.riskScoreThreshold, 8);
  const severeLoss = normalizeNumber(options.riskSimulationLossThreshold, 0.5);
  const riskRows = await queryFn(
    `SELECT id, trace_id, symbol, exchange, decision, risk_score, reason, evaluated_at
       FROM risk_log
      WHERE evaluated_at >= $1::timestamptz
        AND (
          COALESCE(risk_score, 0) >= $2
          OR COALESCE(decision, '') ~* '(block|reject|halt|deny|stop)'
        )
      ORDER BY evaluated_at DESC
      LIMIT $3`,
    [cutoff, minRiskScore, limit],
  );
  const simulationRows = await queryFn(
    `SELECT id, analysis_type, symbols, exchange, market, var_99, cvar_99, max_loss_estimate,
            risk_limits, scenario_metrics, data_health, observed_at
       FROM luna_risk_simulation_shadow
      WHERE observed_at >= $1::timestamptz
        AND data_health = 'ready'
        AND (
          COALESCE(max_loss_estimate, 0) >= $2
          OR COALESCE(cvar_99, 0) >= $2
        )
      ORDER BY GREATEST(COALESCE(max_loss_estimate, 0), COALESCE(cvar_99, 0)) DESC, observed_at DESC
      LIMIT $3`,
    [cutoff, severeLoss, limit],
  );
  const candidates = [
    ...(riskRows || []).map(normalizeRiskLog).filter((row: any) => (
      row.sourceId
      && (row.riskScore >= minRiskScore || /block|reject|halt|deny|stop/i.test(String(row.decision || '')))
    )),
    ...(simulationRows || []).map(normalizeRiskSimulation).filter((row: any) => (
      row.sourceId
      && row.dataHealth === 'ready'
      && (row.maxLossEstimate >= severeLoss || row.cvar99 >= severeLoss)
    )),
  ].slice(0, limit);
  return filterExistingMeetingAgendas(candidates, queryFn);
}

function buildCircuitAgenda(row: any = {}) {
  const subject = [row.market, row.symbol, row.circuit].filter(Boolean).join(' / ');
  return {
    key: row.agendaKey,
    kind: 'circuit_locks',
    title: `수시 서킷 점검: ${subject || row.agendaKey}`,
    market: row.market || 'any',
    evidence: [row],
    defaultGrade: 'c_master',
    defaultStatus: 'pending_master',
  };
}

function eventTitle(row: any = {}) {
  if (row.type === 'regime_shift') return `레짐 전환 점검: ${row.market} ${row.previousRegime}→${row.currentRegime}`;
  if (row.type === 'major_disclosure') return `대형 공시 점검: ${row.symbol} ${row.reportName || ''}`.trim();
  if (row.type === 'daily_loss_threshold') return `일일 손실 임계 점검: ${row.market} ${row.dateKst}`;
  if (row.type === 'risk_log_severe') return `심각 리스크 로그 점검: ${row.symbol || row.exchange || row.sourceId}`;
  if (row.type === 'risk_simulation_severe') return `심각 리스크 시뮬레이션 점검: ${row.market} ${row.analysisType}`;
  return `수시 이벤트 점검: ${row.agendaKey || row.type || 'unknown'}`;
}

function buildEventAgenda(row: any = {}) {
  return {
    key: row.agendaKey,
    kind: 'event_meeting',
    title: eventTitle(row),
    market: row.market || 'any',
    evidence: row,
    defaultGrade: 'c_master',
    defaultStatus: 'pending_master',
  };
}

function buildPlanNote(type: string, title: string, agendas: any[] = [], now: any = Date.now()) {
  return {
    ok: true,
    type,
    generatedAt: iso(now),
    segments: [],
    gates: [],
    regimes: [],
    strategySignals: [],
    circuitLocks: agendas.flatMap((agenda) => Array.isArray(agenda.evidence) ? agenda.evidence : []),
    eventTriggers: agendas.map((agenda) => agenda.evidence).filter(Boolean),
    pendingDecisions: agendas.map((agenda) => agenda.evidence).filter(Boolean),
    positions: [],
    calibration: [],
    readOnly: true,
    shadowOnly: true,
    briefMarkdown: [
      `# Luna Meeting Room L — ${title}`,
      `- 생성: ${iso(now)}`,
      `- 안건: ${agendas.length}건`,
      '- 회의 산출은 자문/섀도 전용이며 직접 적용하지 않습니다.',
    ].join('\n'),
  };
}

async function runAdhocMeetingForAgendas({ title, agendas, options, deps }: any) {
  if (!agendas.length) return null;
  const runMeeting = deps.runMeetingSession || runMeetingSession;
  return runMeeting({
    type: 'adhoc',
    chair: options.chair || 'luna',
    apply: true,
    dryRun: false,
    noLlm: options.noLlm === true,
    outputPath: options.outputPath || null,
    outputDir: options.outputDir,
    now: options.now,
    planNote: buildPlanNote('adhoc', title, agendas, options.now),
    agendas,
  }, deps);
}

export async function runMeetingRoomLOps(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun ?? !apply;
  const writable = canWrite({ ...options, dryRun });
  const errors = [];
  if (apply && !writable) {
    return {
      ok: false,
      blocked: true,
      reason: 'confirm_required',
      dryRun,
      apply,
      debrief: { candidates: [], generated: 0, skipped: [] },
      adr: { overdue: [], reappeared: 0, skipped: [] },
      circuit: { candidates: [], triggered: 0, skipped: [] },
      regime: { candidates: [], triggered: 0, skipped: [] },
      disclosure: { candidates: [], triggered: 0, skipped: [] },
      dailyLoss: { candidates: [], triggered: 0, skipped: [] },
      risk: { candidates: [], triggered: 0, skipped: [] },
      eventMeeting: { candidates: 0, triggered: 0, skipped: [] },
      liveMutation: false,
      shadowOnly: true,
      errors,
    };
  }

  const result = {
    ok: true,
    dryRun,
    apply,
    debrief: { candidates: [], generated: 0, skipped: [] },
    adr: { overdue: [], reappeared: 0, skipped: [] },
    circuit: { candidates: [], triggered: 0, skipped: [] },
    regime: { candidates: [], triggered: 0, skipped: [] },
    disclosure: { candidates: [], triggered: 0, skipped: [] },
    dailyLoss: { candidates: [], triggered: 0, skipped: [] },
    risk: { candidates: [], triggered: 0, skipped: [] },
    eventMeeting: { candidates: 0, triggered: 0, skipped: [] },
    liveMutation: false,
    shadowOnly: true,
    errors,
  };

  if (options.skipDebrief !== true) {
    try {
      const candidates = await findDebriefBackfillCandidates(options, deps);
      result.debrief.candidates = candidates;
      if (writable) {
        const regenerate = deps.regenerateMeetingMinutesMarkdown || regenerateMeetingMinutesMarkdown;
        for (const candidate of candidates) {
          if (candidate.hasMarkdown) {
            result.debrief.skipped.push({ id: candidate.id, reason: 'markdown_exists' });
            continue;
          }
          await regenerate(candidate.id, {
            outputDir: options.outputDir,
            preserveExisting: true,
            queryFn: deps.queryFn,
          });
          result.debrief.generated += 1;
        }
      }
    } catch (error) {
      errors.push({ step: 'debrief', error: error?.message || String(error) });
    }
  }

  if (options.skipAdr !== true) {
    try {
      const overdue = await findOverdueAdrCandidates(options, deps);
      result.adr.overdue = overdue;
      if (writable && overdue.length > 0) {
        const agendas = overdue.map(buildOverdueAdrAgenda);
        const meeting = await runAdhocMeetingForAgendas({ title: '기한 초과 ADR 재상정', agendas, options, deps });
        result.adr.reappeared = meeting?.decisions?.length || overdue.length;
        result.adr.meeting = meeting ? { id: meeting.session?.id || null, markdownPath: meeting.markdownPath || null } : null;
      }
    } catch (error) {
      errors.push({ step: 'adr', error: error?.message || String(error) });
    }
  }

  const eventAgendas = [];

  if (options.skipCircuit !== true) {
    try {
      const candidates = await findCircuitMeetingCandidates(options, deps);
      result.circuit.candidates = candidates;
      eventAgendas.push(...candidates.map(buildCircuitAgenda));
    } catch (error) {
      errors.push({ step: 'circuit', error: error?.message || String(error) });
    }
  }

  if (options.skipRegime !== true) {
    try {
      const candidates = await findRegimeShiftMeetingCandidates(options, deps);
      result.regime.candidates = candidates;
      eventAgendas.push(...candidates.map(buildEventAgenda));
    } catch (error) {
      errors.push({ step: 'regime', error: error?.message || String(error) });
    }
  }

  if (options.skipDisclosure !== true) {
    try {
      const candidates = await findDisclosureMeetingCandidates(options, deps);
      result.disclosure.candidates = candidates;
      eventAgendas.push(...candidates.map(buildEventAgenda));
    } catch (error) {
      errors.push({ step: 'disclosure', error: error?.message || String(error) });
    }
  }

  if (options.skipDailyLoss !== true) {
    try {
      const candidates = await findDailyLossMeetingCandidates(options, deps);
      result.dailyLoss.candidates = candidates;
      eventAgendas.push(...candidates.map(buildEventAgenda));
    } catch (error) {
      errors.push({ step: 'daily_loss', error: error?.message || String(error) });
    }
  }

  if (options.skipRisk !== true) {
    try {
      const candidates = await findRiskMeetingCandidates(options, deps);
      result.risk.candidates = candidates;
      eventAgendas.push(...candidates.map(buildEventAgenda));
    } catch (error) {
      errors.push({ step: 'risk', error: error?.message || String(error) });
    }
  }

  result.eventMeeting.candidates = eventAgendas.length;
  if (writable && eventAgendas.length > 0) {
    try {
      const meeting = await runAdhocMeetingForAgendas({ title: '수시 이벤트 점검', agendas: eventAgendas, options, deps });
      const meetingRef = meeting ? { id: meeting.session?.id || null, markdownPath: meeting.markdownPath || null } : null;
      result.eventMeeting.triggered = meeting?.decisions?.length || eventAgendas.length;
      result.eventMeeting.meeting = meetingRef;
      result.circuit.triggered = result.circuit.candidates.length;
      result.regime.triggered = result.regime.candidates.length;
      result.disclosure.triggered = result.disclosure.candidates.length;
      result.dailyLoss.triggered = result.dailyLoss.candidates.length;
      result.risk.triggered = result.risk.candidates.length;
      if (result.circuit.triggered > 0) result.circuit.meeting = meetingRef;
      if (result.regime.triggered > 0) result.regime.meeting = meetingRef;
      if (result.disclosure.triggered > 0) result.disclosure.meeting = meetingRef;
      if (result.dailyLoss.triggered > 0) result.dailyLoss.meeting = meetingRef;
      if (result.risk.triggered > 0) result.risk.meeting = meetingRef;
    } catch (error) {
      errors.push({ step: 'event_meeting', error: error?.message || String(error) });
    }
  }

  result.ok = errors.length === 0;
  return result;
}

export const _testOnly = {
  kstDateKey,
  canWrite,
  buildOverdueAdrAgenda,
  buildCircuitAgenda,
  buildEventAgenda,
  decisionAlreadyReagendedToday,
};

export default {
  runMeetingRoomLOps,
  findDebriefBackfillCandidates,
  findOverdueAdrCandidates,
  findCircuitMeetingCandidates,
  findRegimeShiftMeetingCandidates,
  findDisclosureMeetingCandidates,
  findDailyLossMeetingCandidates,
  findRiskMeetingCandidates,
};
