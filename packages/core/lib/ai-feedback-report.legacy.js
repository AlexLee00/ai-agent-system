'use strict';

function formatPercent(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((Number(numerator || 0) / Number(denominator || 0)) * 100).toFixed(1)}%`;
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildFeedbackSummaryLines({ schema, sinceDays, summary, fieldStats, sessions }) {
  const lines = [
    `🧠 AI feedback summary [${schema}]`,
    `기간: 최근 ${sinceDays}일`,
    '',
    `총 세션: ${summary.totalSessions}건`,
    `확정 완료: ${summary.committedSessions}건`,
    `중간 확인: ${summary.confirmedSessions}건`,
    `반려: ${summary.rejectedSessions}건`,
    `수정 없이 채택: ${summary.acceptedWithoutEditSessions}건 (${formatPercent(summary.acceptedWithoutEditSessions, summary.totalSessions)})`,
  ];

  if (summary.byFlow?.length) {
    lines.push('', '■ flow/action 요약');
    for (const row of summary.byFlow.slice(0, 8)) {
      lines.push(
        `  ${row.flow_code}/${row.action_code}: ${row.session_count}건 · committed ${row.committed_count} · rejected ${row.rejected_count} · no-edit ${row.accepted_without_edit_count}`
      );
    }
  }

  if (fieldStats?.length) {
    lines.push('', '■ 자주 수정된 필드');
    for (const row of fieldStats.slice(0, 8)) {
      lines.push(`  ${row.field_key} (${row.event_type}) ${row.edit_count}건`);
    }
  }

  if (sessions?.length) {
    lines.push('', '■ 최근 세션');
    for (const row of sessions.slice(0, 5)) {
      lines.push(
        `  #${row.id} ${row.flow_code}/${row.action_code} · ${row.feedback_status} · no-edit=${row.accepted_without_edit ? 'Y' : 'N'}`
      );
    }
  }

  return lines.join('\n');
}

function buildFeedbackDailyLines({ schema, sinceDays, dailyStats }) {
  const lines = [
    `🧠 AI feedback daily trend [${schema}]`,
    `기간: 최근 ${sinceDays}일`,
  ];

  if (!Array.isArray(dailyStats) || dailyStats.length === 0) {
    lines.push('', '집계된 일별 세션이 없습니다.');
    return lines.join('\n');
  }

  lines.push('', '■ 일별 추이');
  for (const row of dailyStats) {
    lines.push(
      `  ${row.day}: 세션 ${row.session_count}건 · committed ${row.committed_count} · rejected ${row.rejected_count} · no-edit ${row.accepted_without_edit_count}`
    );
  }

  return lines.join('\n');
}

function buildFeedbackCsvRows(mode, report) {
  if (mode === 'daily') {
    return [
      ['schema', 'day', 'session_count', 'committed_count', 'rejected_count', 'accepted_without_edit_count'],
      ...(report.dailyStats || []).map((row) => [
        report.schema,
        row.day,
        row.session_count,
        row.committed_count,
        row.rejected_count,
        row.accepted_without_edit_count,
      ]),
    ];
  }

  if (mode === 'flows') {
    return [
      ['schema', 'flow_code', 'action_code', 'session_count', 'committed_count', 'rejected_count', 'accepted_without_edit_count'],
      ...(report.summary?.byFlow || []).map((row) => [
        report.schema,
        row.flow_code,
        row.action_code,
        row.session_count,
        row.committed_count,
        row.rejected_count,
        row.accepted_without_edit_count,
      ]),
    ];
  }

  if (mode === 'fields') {
    return [
      ['schema', 'field_key', 'event_type', 'edit_count'],
      ...(report.fieldStats || []).map((row) => [
        report.schema,
        row.field_key,
        row.event_type,
        row.edit_count,
      ]),
    ];
  }

  return [
    ['schema', 'session_id', 'company_id', 'user_id', 'source_type', 'source_ref_type', 'source_ref_id', 'flow_code', 'action_code', 'feedback_status', 'accepted_without_edit', 'created_at', 'updated_at'],
    ...(report.sessions || []).map((row) => [
      report.schema,
      row.id,
      row.company_id,
      row.user_id,
      row.source_type,
      row.source_ref_type,
      row.source_ref_id,
      row.flow_code,
      row.action_code,
      row.feedback_status,
      row.accepted_without_edit,
      row.created_at,
      row.updated_at,
    ]),
  ];
}

function buildFeedbackCsv(mode, report) {
  return buildFeedbackCsvRows(mode, report)
    .map((row) => row.map(escapeCsv).join(','))
    .join('\n');
}

module.exports = {
  buildFeedbackSummaryLines,
  buildFeedbackDailyLines,
  buildFeedbackCsv,
};
