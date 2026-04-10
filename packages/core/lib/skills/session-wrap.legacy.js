'use strict';

const { execSync } = require('child_process');

// git log --since 기반 세션 요약
function summarizeSession(since) {
  const sinceArg = since || '4 hours ago';
  try {
    const logOutput = execSync(`git log --since="${sinceArg}" --oneline`, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000,
    }).trim();

    const commits = logOutput
      ? logOutput.split('\n').map((line) => {
          const spaceIdx = line.indexOf(' ');
          return {
            hash: spaceIdx > 0 ? line.slice(0, spaceIdx) : line,
            message: spaceIdx > 0 ? line.slice(spaceIdx + 1) : '',
          };
        })
      : [];

    let files = [];
    if (commits.length > 0) {
      try {
        const diffOutput = execSync(`git diff --stat HEAD~${commits.length} HEAD`, {
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 10000,
        }).trim();
        files = diffOutput ? diffOutput.split('\n') : [];
      } catch (_) { /* diff 실패 무시 */ }
    }

    const featCount = commits.filter((c) => c.message.startsWith('feat')).length;
    const fixCount = commits.filter((c) => c.message.startsWith('fix')).length;
    const docsCount = commits.filter((c) => c.message.startsWith('docs')).length;
    const parts = [];
    if (featCount > 0) parts.push(`신규 ${featCount}건`);
    if (fixCount > 0) parts.push(`수정 ${fixCount}건`);
    if (docsCount > 0) parts.push(`문서 ${docsCount}건`);
    const summary = parts.length > 0
      ? `커밋 ${commits.length}건 (${parts.join(', ')})`
      : `커밋 ${commits.length}건`;

    return { commits, files, summary };
  } catch (err) {
    console.warn(`[skills/session-wrap] 세션 요약 실패: ${err.message}`);
    return { commits: [], files: [], summary: '요약 실패' };
  }
}

// OPUS_FINAL_HANDOFF.md 초안 생성
function generateHandoff(sessionData) {
  const data = sessionData || {};
  const commits = Array.isArray(data.commits) ? data.commits : [];
  const decisions = Array.isArray(data.decisions) ? data.decisions : [];
  const nextTasks = Array.isArray(data.nextTasks) ? data.nextTasks : [];

  const lines = [
    '# OPUS FINAL HANDOFF',
    '',
    '## 성과',
  ];

  if (commits.length > 0) {
    for (const c of commits) {
      lines.push(`- ${c.message || c.hash || c}`);
    }
  } else {
    lines.push('- (커밋 없음)');
  }

  lines.push('', '## 핵심 결정');
  if (decisions.length > 0) {
    for (const d of decisions) {
      lines.push(`- ${d}`);
    }
  } else {
    lines.push('- (기록된 결정 없음)');
  }

  lines.push('', '## 다음 작업');
  if (nextTasks.length > 0) {
    for (const t of nextTasks) {
      lines.push(`- [ ] ${t}`);
    }
  } else {
    lines.push('- (예정 작업 없음)');
  }

  lines.push('');
  return lines.join('\n');
}

// 커밋 메시지에서 학습 포인트 추출
function extractLearnings(commits) {
  const commitList = Array.isArray(commits) ? commits : [];
  const patterns = [];
  const issues = [];
  const improvements = [];

  for (const commit of commitList) {
    const msg = typeof commit === 'string' ? commit : (commit.message || '');
    if (msg.startsWith('fix:') || msg.startsWith('fix(')) {
      issues.push(msg);
    } else if (msg.startsWith('feat:') || msg.startsWith('feat(')) {
      improvements.push(msg);
    } else if (msg.startsWith('revert:') || msg.startsWith('revert(')) {
      patterns.push(`실수 복구: ${msg}`);
    } else if (msg.startsWith('refactor:') || msg.startsWith('refactor(')) {
      improvements.push(msg);
    }
  }

  return { patterns, issues, improvements };
}

module.exports = { summarizeSession, generateHandoff, extractLearnings };
