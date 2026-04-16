// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const {
  getFeedbackSessionSummary,
  getFeedbackFieldStats,
  getFeedbackSessions,
} = require('../../../packages/core/lib/ai-feedback-store');

const SUMMARY_MODE = process.argv.includes('--summary');

const FEEDBACK_TARGETS = [
  { schema: 'worker', title: '워커' },
  { schema: 'blog', title: '블로' },
  { schema: 'claude', title: '클로드' },
];

function parseSchemaArg(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--schema' && argv[i + 1]) {
      return String(argv[i + 1]).trim().toLowerCase();
    }
  }
  return '';
}

function formatPercent(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((Number(numerator || 0) / Number(denominator || 0)) * 100).toFixed(1)}%`;
}

async function loadTargetReport(target) {
  const [summary, fieldStats, sessions] = await Promise.all([
    getFeedbackSessionSummary(pgPool, { schema: target.schema, sinceDays: 30 }),
    getFeedbackFieldStats(pgPool, { schema: target.schema, sinceDays: 30, limit: 5 }),
    getFeedbackSessions(pgPool, { schema: target.schema, sinceDays: 30, limit: 5 }),
  ]);
  return {
    ...target,
    summary,
    fieldStats,
    sessions,
  };
}

function buildTargetSummaryLine(report) {
  return `${report.title}: 세션 ${report.summary.totalSessions}건 · committed ${report.summary.committedSessions} · rejected ${report.summary.rejectedSessions} · no-edit ${formatPercent(report.summary.acceptedWithoutEditSessions, report.summary.totalSessions)}`;
}

function buildTargetDetailLines(report) {
  const lines = [
    `세션 ${report.summary.totalSessions}건 · committed ${report.summary.committedSessions} · confirmed ${report.summary.confirmedSessions} · rejected ${report.summary.rejectedSessions}`,
    `수정 없이 채택 ${report.summary.acceptedWithoutEditSessions}건 (${formatPercent(report.summary.acceptedWithoutEditSessions, report.summary.totalSessions)})`,
  ];

  if (Array.isArray(report.summary.byFlow) && report.summary.byFlow.length > 0) {
    lines.push('주요 flow/action');
    for (const row of report.summary.byFlow.slice(0, 3)) {
      lines.push(`  - ${row.flow_code}/${row.action_code}: ${row.session_count}건 · rejected ${row.rejected_count} · no-edit ${row.accepted_without_edit_count}`);
    }
  }

  if (Array.isArray(report.fieldStats) && report.fieldStats.length > 0) {
    lines.push('자주 수정된 필드');
    for (const row of report.fieldStats.slice(0, 3)) {
      lines.push(`  - ${row.field_key} (${row.event_type}) ${row.edit_count}건`);
    }
  }

  if (Array.isArray(report.sessions) && report.sessions.length > 0) {
    lines.push('최근 세션');
    for (const row of report.sessions.slice(0, 3)) {
      lines.push(`  - #${row.id} ${row.flow_code}/${row.action_code} · ${row.feedback_status} · no-edit=${row.accepted_without_edit ? 'Y' : 'N'}`);
    }
  }

  return lines;
}

function buildSummaryText(report) {
  const lines = [
    '🧠 AI 피드백 요약',
    '',
    `최근 30일 총 세션 ${report.totalSessions}건 · committed ${report.totalCommitted} · rejected ${report.totalRejected}`,
    `수정 없이 채택 ${report.totalAcceptedWithoutEdit}건 (${formatPercent(report.totalAcceptedWithoutEdit, report.totalSessions)})`,
    '',
  ];

  for (const target of report.targets) {
    lines.push(buildTargetSummaryLine(target));
  }

  lines.push('');
  lines.push('상세: /feedback-health | 팀별: /feedback-health worker | /feedback-health blog | /feedback-health claude');
  return lines.join('\n');
}

function buildFullText(report) {
  const sections = report.targets.map((target) => ({
    title: `■ ${target.title}`,
    lines: buildTargetDetailLines(target),
  }));

  sections.push({
    title: '■ 권장 조치',
    lines:
      report.decision.recommended
        ? [
            '  - rejected가 쌓이는 flow/action부터 proposal 품질 점검',
            '  - 자주 수정되는 field_key를 우선 후보로 프롬프트/스키마 보강',
          ]
        : [
            '  - 현재는 관찰 유지. 상세 추적이 필요하면 팀별 /feedback-health <schema> 확인',
          ],
  });

  sections.push({
    title: null,
    lines: buildHealthDecisionSection({
      title: '■ 운영 판단',
      recommended: report.decision.recommended,
      level: report.decision.level,
      reasons: report.decision.reasons,
      okText: '현재는 AI feedback 수집 경로가 안정적으로 동작하고 있습니다.',
    }),
  });

  return buildHealthReport({
    title: '🧠 AI 피드백 헬스 리포트',
    subtitle: `기간: 최근 ${report.sinceDays}일`,
    sections,
    footer: [
      '상세: /feedback-health worker | /feedback-health blog | /feedback-health claude',
    ],
  });
}

async function buildReport() {
  const requestedSchema = parseSchemaArg();
  const targets = FEEDBACK_TARGETS.filter((target) => !requestedSchema || target.schema === requestedSchema);
  const reports = await Promise.all(targets.map(loadTargetReport));

  const totalSessions = reports.reduce((sum, item) => sum + Number(item.summary.totalSessions || 0), 0);
  const totalCommitted = reports.reduce((sum, item) => sum + Number(item.summary.committedSessions || 0), 0);
  const totalRejected = reports.reduce((sum, item) => sum + Number(item.summary.rejectedSessions || 0), 0);
  const totalAcceptedWithoutEdit = reports.reduce((sum, item) => sum + Number(item.summary.acceptedWithoutEditSessions || 0), 0);

  const decision = buildHealthDecision({
    warnings: [
      {
        active: totalRejected >= 3,
        level: 'medium',
        reason: `최근 30일 rejected 세션 ${totalRejected}건이 있어 승인/반려 흐름 점검이 필요합니다.`,
      },
      {
        active: totalSessions > 0 && totalCommitted === 0 && totalAcceptedWithoutEdit === 0,
        level: 'low',
        reason: '피드백 수집은 있으나 최종 committed가 없어 실제 완료 경로 점검이 필요합니다.',
      },
    ],
    okReason: '피드백 세션/이벤트 수집과 완료 경로가 현재는 안정적으로 보입니다.',
  });

  return {
    mode: SUMMARY_MODE ? 'summary' : 'full',
    schema: requestedSchema || 'all',
    sinceDays: 30,
    targets: reports,
    totalSessions,
    totalCommitted,
    totalRejected,
    totalAcceptedWithoutEdit,
    decision,
  };
}

function formatText(report) {
  if (report.mode === 'summary') return buildSummaryText(report);
  return buildFullText(report);
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[ai feedback health]',
});
