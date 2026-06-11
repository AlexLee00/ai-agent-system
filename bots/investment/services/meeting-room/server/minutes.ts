// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { MEETING_ROOM_DEFAULTS } from '../config/meeting.config.ts';

function safeText(value: any) {
  return String(value ?? '').trim();
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

export function renderMeetingMinutesMarkdown(result: any = {}) {
  const session = result.session || {};
  const decisions = result.decisions || [];
  const minutes = result.minutes || [];
  const lines = [
    `# Luna Meeting Room — ${session.type || result.type || 'morning'}`,
    '',
    `- session: ${session.id || 'dry-run'}`,
    `- status: ${session.status || 'closed'}`,
    `- chair: ${session.chair || 'luna'}`,
    `- started_at: ${session.startedAt || session.started_at || result.startedAt || ''}`,
    `- closed_at: ${session.closedAt || session.closed_at || result.closedAt || ''}`,
    `- dry_run: ${result.dryRun === true}`,
    `- llm_calls: ${result.llmCalls || 0}`,
    `- skipped_llm_calls: ${result.skippedLlmCalls || 0}`,
    '',
    '## Plan Note',
    '',
    safeText(result.planNote?.briefMarkdown || 'plan-note 없음'),
    '',
    '## Minutes',
    '',
  ];
  for (const row of minutes) {
    lines.push(`### ${row.seq}. ${row.agendaKey || row.agenda_key} — ${roleLabel(row.role)} / ${row.speaker}`);
    lines.push('');
    lines.push(safeText(row.content));
    lines.push('');
  }
  lines.push('## ADR');
  lines.push('');
  if (decisions.length === 0) {
    lines.push('- 결정 없음');
  } else {
    for (const row of decisions) {
      lines.push(`- [${row.grade}/${row.status}] ${row.agendaKey || row.agenda_key}: ${safeText(row.decision)} (due: ${row.dueAt || row.due_at || 'n/a'})`);
    }
  }
  lines.push('');
  lines.push('> MR-A output is advisory/shadow only. No trading, launchd, or parameter mutation was performed.');
  return `${lines.join('\n')}\n`;
}

export async function writeMeetingMinutesMarkdown(result: any = {}, outputPath?: string | null) {
  const session = result.session || {};
  const date = String(result.startedAt || session.startedAt || new Date().toISOString()).slice(0, 10);
  const type = session.type || result.type || 'morning';
  const target = path.resolve(outputPath || path.join(MEETING_ROOM_DEFAULTS.outputDir, `${date}-${type}.md`));
  const markdown = renderMeetingMinutesMarkdown(result);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown);
  return { path: target, markdown };
}

export default {
  renderMeetingMinutesMarkdown,
  writeMeetingMinutesMarkdown,
};
