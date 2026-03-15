'use strict';

function buildHealthHeader(title, subtitle = '') {
  const lines = [title];
  if (subtitle) lines.push(subtitle);
  return lines;
}

function buildHealthSection(title, lines = []) {
  const filtered = (lines || []).filter(Boolean);
  if (filtered.length === 0) return [];
  return [title, ...filtered];
}

function buildHealthDecisionSection({
  title = '판단',
  recommended = false,
  level = 'hold',
  reasons = [],
  okText = '현재는 관찰 유지',
}) {
  const lines = [title];
  if (recommended) {
    const badge = level === 'high' ? '🔧 즉시 검토' : '🛠 검토 권장';
    lines.push(`  ${badge}`);
  } else {
    lines.push(`  ✅ ${okText}`);
  }
  for (const reason of reasons || []) {
    if (reason) lines.push(`  - ${reason}`);
  }
  return lines;
}

function buildHealthDecision({
  warnings = [],
  okReason = '현재는 안정 구간입니다.',
} = {}) {
  const reasons = [];
  let recommended = false;
  let level = 'hold';

  for (const warning of warnings || []) {
    if (!warning || !warning.active) continue;
    recommended = true;
    if (warning.level === 'high') level = 'high';
    else if (level !== 'high' && warning.level === 'medium') level = 'medium';
    if (warning.reason) reasons.push(warning.reason);
  }

  if (!recommended && okReason) {
    reasons.push(okReason);
  }

  return { recommended, level, reasons };
}

function buildHealthCountSection(title, health, {
  warnLimit = 8,
  okLimit = 0,
} = {}) {
  if (!health) return null;
  const lines = [
    `  정상 ${Number(health.okCount || 0)}건 / 경고 ${Number(health.warnCount || 0)}건`,
    ...((health.warn || []).slice(0, warnLimit)),
  ];
  if (okLimit > 0) {
    lines.push(...((health.ok || []).slice(0, okLimit)));
  }
  return { title, lines };
}

function buildHealthSampleSection(title, health, limit = 5) {
  if (!health || !Array.isArray(health.ok) || health.ok.length === 0) return null;
  return {
    title,
    lines: health.ok.slice(0, limit),
  };
}

function sortHealthRows(rows = [], getPriority = (row) => Number(row?.priority || 0), locale = 'ko') {
  return [...rows].sort((a, b) => getPriority(b) - getPriority(a) || String(a?.title || '').localeCompare(String(b?.title || ''), locale));
}

function buildHealthSummaryLines(rows = [], {
  warnIcon = '⚠️',
  okIcon = '✅',
} = {}) {
  return rows.map((row) => `${row.hasWarn ? warnIcon : okIcon} ${row.title}: ${row.summary}`);
}

function buildHealthDetailLines(rows = []) {
  return rows
    .map((row) => `${row.title}\n${row.detail}`)
    .flatMap((line) => line.split('\n'));
}

function buildHealthBriefingLines(rows = [], actionMap = {}, fallbackAction = '/ops-health') {
  const lines = [];
  for (const row of rows) {
    lines.push(`⚠️ ${row.title}: ${row.summary}`);
    lines.push(`   확인: ${actionMap[row.title] || fallbackAction}`);
  }
  return lines;
}

function buildHealthReport({ title, subtitle = '', sections = [], footer = [] }) {
  const lines = [...buildHealthHeader(title, subtitle)];
  for (const section of sections) {
    const block = buildHealthSection(section.title, section.lines);
    if (block.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(...block);
  }
  const footerLines = (footer || []).filter(Boolean);
  if (footerLines.length > 0) {
    lines.push('');
    lines.push(...footerLines);
  }
  return lines.join('\n');
}

module.exports = {
  buildHealthHeader,
  buildHealthSection,
  buildHealthDecision,
  buildHealthCountSection,
  buildHealthSampleSection,
  sortHealthRows,
  buildHealthSummaryLines,
  buildHealthDetailLines,
  buildHealthBriefingLines,
  buildHealthDecisionSection,
  buildHealthReport,
};
