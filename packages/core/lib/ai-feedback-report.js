'use strict';

function formatPercent(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((Number(numerator || 0) / Number(denominator || 0)) * 100).toFixed(1)}%`;
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

module.exports = {
  buildFeedbackSummaryLines,
};
