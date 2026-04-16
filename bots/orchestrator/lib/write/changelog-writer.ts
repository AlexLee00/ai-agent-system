// @ts-nocheck
'use strict';

const { execSync } = require('child_process');

const kst = require('../../../../packages/core/lib/kst');

function safeGitLog(since) {
  try {
    return execSync(`git log --since="${since}" --oneline --format='%h %s'`, {
      cwd: process.cwd(),
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    console.warn(`[write/changelog-writer] git log 실패: ${error.message}`);
    return '';
  }
}

function generateEntry(since) {
  const rawText = safeGitLog(since || 'yesterday');
  const raw = rawText ? rawText.split('\n').filter(Boolean) : [];
  const entry = {
    date: kst.today(),
    features: [],
    fixes: [],
    docs: [],
    chores: [],
    raw,
  };

  raw.forEach((line) => {
    if (line.includes('feat:') || line.includes('feat(')) entry.features.push(line);
    else if (line.includes('fix:') || line.includes('fix(')) entry.fixes.push(line);
    else if (line.includes('docs:') || line.includes('docs(')) entry.docs.push(line);
    else if (line.includes('chore:') || line.includes('chore(')) entry.chores.push(line);
    else entry.chores.push(line);
  });

  return entry;
}

function appendSection(lines, title, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  lines.push(`### ${title}`);
  items.forEach((item) => lines.push(`- ${item}`));
  lines.push('');
}

function formatChangelogEntry(entry) {
  const target = entry || generateEntry('yesterday');
  const lines = [`## ${target.date}`, ''];
  appendSection(lines, '기능', target.features);
  appendSection(lines, '수정', target.fixes);
  appendSection(lines, '문서', target.docs);
  appendSection(lines, '기타', target.chores);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

module.exports = { generateEntry, formatChangelogEntry };
