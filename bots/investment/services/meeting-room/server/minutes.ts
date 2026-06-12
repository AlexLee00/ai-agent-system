// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { MEETING_ROOM_DEFAULTS } from '../config/meeting.config.ts';
import * as db from '../../../shared/db.ts';

function safeText(value: any) {
  return String(value ?? '').trim();
}

let displayNormalizerPromise: Promise<(value: any) => string> | null = null;

async function loadDisplayNormalizer() {
  if (!displayNormalizerPromise) {
    displayNormalizerPromise = import('./index.ts')
      .then((mod: any) => mod.normalizeLegacyMinuteContent || mod._testOnly?.normalizeLegacyMinuteContent || safeText)
      .catch(() => safeText);
  }
  return displayNormalizerPromise;
}

function roleLabel(role: string) {
  return {
    data: '데이터',
    analysis: '분석',
    grill: '그릴',
    decision: '결정',
    system: '시스템',
  }[role] || role;
}

function agendaLabel(key: any) {
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

function toIsoString(value: any) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function decisionGradeLabel(value: any) {
  return {
    a_rule: 'A 자동 규칙',
    b_boundary: 'B 경계 검토',
    c_master: 'C 마스터 확인',
  }[String(value || '')] || String(value || '등급 미정');
}

function decisionStatusLabel(value: any) {
  return {
    pending_master: '마스터 액션 대기',
    confirmed: '확정',
    deferred: '보류',
    superseded: '대체됨',
  }[String(value || '')] || String(value || '상태 미정');
}

function sessionStatusLabel(value: any) {
  return {
    open: '진행 중',
    running: '실행 중',
    completed: '완료',
    closed: '완료',
    failed: '실패',
  }[String(value || '').toLowerCase()] || '상태 미상';
}

function meetingTypeLabel(type: any) {
  return {
    morning: '아침 통합 회의',
    domestic_debrief: '국내 장후 회의',
    us_premarket: '미장 전 회의',
    weekly: '주간 회의',
    adhoc: '임시 회의',
    ad_hoc: '임시 회의',
  }[String(type || '').toLowerCase()] || '회의';
}

function normalizeSessionSummary(summary: any, type: any) {
  const label = meetingTypeLabel(type);
  return String(summary || '')
    .replace(/^(morning|domestic_debrief|us_premarket|weekly|adhoc|ad_hoc)\s+회의\s+완료:/i, `${label} 완료:`)
    .replace(/^회의\s+완료:/, `${label} 완료:`);
}

function segmentSummaryForMarkdown(segments: any[] = []) {
  const rows = Array.isArray(segments) ? segments : [];
  if (rows.length === 0) return '세그먼트: 정보 없음';
  const marketLabel: any = { domestic: '국내', overseas: '미국', crypto: '암호화폐' };
  const reasonLabel: any = {
    crypto_24h: '24시간 운영',
    holiday: '휴장',
    kis_market_closed: '장 마감',
    market_closed: '장 마감',
    weekend: '주말',
  };
  const parts = rows.map((row: any) => {
    const market = marketLabel[row?.market] || '시장 미상';
    const active = row?.active === true || row?.skipped === false;
    const reason = reasonLabel[row?.reason] || (row?.reason ? '사유 확인 필요' : '정상');
    return `${market} ${active ? '활성' : '비활성'}(${reason})`;
  });
  return `세그먼트: ${parts.join(' / ')}`;
}

export function renderMeetingMinutesMarkdown(result: any = {}) {
  const session = result.session || {};
  const decisions = result.decisions || [];
  const minutes = result.minutes || [];
  const type = session.type || result.type || 'morning';
  const lines = [
    `# Luna Meeting Room — ${meetingTypeLabel(type)}`,
    '',
    `- 회의 ID: ${session.id || 'dry-run'}`,
    `- 상태: ${sessionStatusLabel(session.status || 'closed')}`,
    `- 의장: ${safeText(session.chair || 'luna')}`,
    `- 시작: ${session.startedAt || session.started_at || result.startedAt || ''}`,
    `- 종료: ${session.closedAt || session.closed_at || result.closedAt || ''}`,
    `- 드라이런: ${result.dryRun === true ? '예' : '아니오'}`,
    `- LLM 호출: ${result.llmCalls || 0}회`,
    `- LLM 생략: ${result.skippedLlmCalls || 0}회`,
    '',
    '## 회의 데이터 요약',
    '',
    safeText(result.planNote?.briefMarkdown || 'plan-note 없음'),
    '',
    '## 회의록',
    '',
  ];
  for (const row of minutes) {
    lines.push(`### ${row.seq}. ${agendaLabel(row.agendaKey || row.agenda_key)} — ${roleLabel(row.role)} / ${row.speaker}`);
    lines.push('');
    lines.push(safeText(row.content));
    lines.push('');
  }
  lines.push('## 결정 기록(ADR)');
  lines.push('');
  if (decisions.length === 0) {
    lines.push('- 결정 없음');
  } else {
    for (const row of decisions) {
      lines.push(`- [${decisionGradeLabel(row.grade)}/${decisionStatusLabel(row.status)}] ${agendaLabel(row.agendaKey || row.agenda_key)}: ${safeText(row.decision)} (due: ${row.dueAt || row.due_at || 'n/a'})`);
    }
  }
  lines.push('');
  lines.push('> MR-A 산출물은 자문/섀도 전용입니다. 거래, launchd, 파라미터 변경은 수행하지 않았습니다.');
  return `${lines.join('\n')}\n`;
}

function meetingDate(result: any = {}) {
  const session = result.session || {};
  return String(result.startedAt || session.startedAt || session.started_at || new Date().toISOString()).slice(0, 10);
}

function meetingType(result: any = {}) {
  const session = result.session || {};
  return String(session.type || result.type || 'morning');
}

function applyRevisionPath(basePath: string) {
  if (!fs.existsSync(basePath)) return basePath;
  const parsed = path.parse(basePath);
  for (let revision = 2; revision < 1000; revision += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-r${revision}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`meeting_minutes_revision_exhausted: ${basePath}`);
}

export function resolveMeetingMinutesMarkdownPath(result: any = {}, outputPath?: string | null, options: any = {}) {
  if (outputPath) return path.resolve(outputPath);
  const outputDir = path.resolve(options.outputDir || MEETING_ROOM_DEFAULTS.outputDir);
  const date = meetingDate(result);
  const type = meetingType(result);
  const isDryRun = result.dryRun === true;
  const baseName = `${date}-${type}${isDryRun ? '-dryrun' : ''}.md`;
  const basePath = path.join(outputDir, baseName);
  if (isDryRun) return basePath;
  if (options.preserveExisting === false) return basePath;
  return applyRevisionPath(basePath);
}

function normalizeSession(row: any = {}) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    chair: row.chair,
    segments: row.segments || [],
    startedAt: toIsoString(row.started_at || row.startedAt),
    closedAt: toIsoString(row.closed_at || row.closedAt),
    summary: normalizeSessionSummary(row.summary, row.type),
  };
}

function normalizeMinute(row: any = {}, contentNormalizer = safeText) {
  return {
    id: row.id,
    sessionId: row.session_id || row.sessionId,
    seq: row.seq,
    agendaKey: row.agenda_key || row.agendaKey,
    speaker: row.speaker,
    role: row.role,
    content: contentNormalizer(row.content),
    meta: row.meta || {},
    createdAt: toIsoString(row.created_at || row.createdAt),
  };
}

function normalizeDecision(row: any = {}, contentNormalizer = safeText) {
  return {
    id: row.id,
    sessionId: row.session_id || row.sessionId,
    agendaKey: row.agenda_key || row.agendaKey,
    decision: contentNormalizer(row.decision),
    grade: row.grade,
    status: row.status,
    dueAt: toIsoString(row.due_at || row.dueAt),
    evidence: row.evidence || {},
    createdAt: toIsoString(row.created_at || row.createdAt),
  };
}

export async function loadMeetingMinutesResult(sessionId: any, options: any = {}) {
  const queryFn = options.queryFn || db.query;
  const sessionRows = await queryFn(
    `SELECT id, type, status, chair, segments, started_at, closed_at, summary
       FROM luna_meeting_sessions
      WHERE id = $1`,
    [sessionId],
  );
  const session = normalizeSession(sessionRows?.[0]);
  if (!session.id) throw new Error(`luna_meeting_session_not_found: ${sessionId}`);
  const minuteRows = await queryFn(
    `SELECT id, session_id, seq, agenda_key, speaker, role, content, meta, created_at
       FROM luna_meeting_minutes
      WHERE session_id = $1
      ORDER BY seq ASC`,
    [session.id],
  );
  const decisionRows = await queryFn(
    `SELECT id, session_id, agenda_key, decision, grade, status, due_at, evidence, created_at
       FROM luna_meeting_decisions
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC`,
    [session.id],
  );
  const normalizeContent = await loadDisplayNormalizer();
  return {
    ok: true,
    type: session.type,
    dryRun: false,
    apply: true,
    startedAt: session.startedAt,
    closedAt: session.closedAt,
    session,
    planNote: {
      briefMarkdown: [
        `DB 기준 회의록 재생성: 회의 #${session.id}`,
        `요약: ${session.summary || 'n/a'}`,
        segmentSummaryForMarkdown(session.segments),
      ].join('\n'),
    },
    minutes: minuteRows.map((row: any) => normalizeMinute(row, normalizeContent)),
    decisions: decisionRows.map((row: any) => normalizeDecision(row, normalizeContent)),
    llmCalls: minuteRows.filter((row: any) => row.role === 'analysis' && row.meta?.skipped !== true).length,
    skippedLlmCalls: minuteRows.filter((row: any) => row.meta?.skipped === true).length,
    shadowOnly: true,
    regenerated: true,
  };
}

export async function writeMeetingMinutesMarkdown(result: any = {}, outputPath?: string | null, options: any = {}) {
  const target = resolveMeetingMinutesMarkdownPath(result, outputPath, options);
  const markdown = renderMeetingMinutesMarkdown(result);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown);
  return { path: target, markdown };
}

export async function regenerateMeetingMinutesMarkdown(sessionId: any, options: any = {}) {
  const result = await loadMeetingMinutesResult(sessionId, options);
  const written = await writeMeetingMinutesMarkdown(result, options.outputPath || null, {
    outputDir: options.outputDir,
    preserveExisting: options.preserveExisting ?? false,
  });
  return { ...result, markdownPath: written.path, markdown: written.markdown };
}

export default {
  renderMeetingMinutesMarkdown,
  resolveMeetingMinutesMarkdownPath,
  loadMeetingMinutesResult,
  writeMeetingMinutesMarkdown,
  regenerateMeetingMinutesMarkdown,
};
