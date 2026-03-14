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
  buildHealthDecisionSection,
  buildHealthReport,
};
