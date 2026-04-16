// @ts-nocheck
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');
const kst = require('../../../../packages/core/lib/kst');

const TRACKER_PATH = path.join(env.PROJECT_ROOT, 'docs/PLATFORM_IMPLEMENTATION_TRACKER.md');

function safeExec(command) {
  try {
    return execSync(command, {
      cwd: env.PROJECT_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    console.warn(`[steward/tracker-sync] 명령 실패: ${error.message}`);
    return '';
  }
}

function getRecentCommits(hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const output = safeExec(`git log --since="${since}" --oneline --no-merges`);
  if (!output) return [];
  return output.split('\n').map((line) => {
    const [hash, ...rest] = line.trim().split(/\s+/);
    return { hash, message: rest.join(' ') };
  });
}

function analyzeCommits(commits = []) {
  const keywords = {
    'feat(': '기능 추가',
    'fix(': '버그 수정',
    'refactor(': '리팩터링',
    'docs:': '문서 갱신',
    'chore:': '정리',
    'tune(': '튜닝',
  };

  return commits.map((commit) => {
    const type = Object.entries(keywords).find(([key]) => commit.message.includes(key));
    return {
      ...commit,
      type: type ? type[1] : '기타',
      summary: commit.message.slice(0, 120),
    };
  });
}

function appendToTracker(entries = []) {
  if (entries.length === 0) return 0;
  if (!fs.existsSync(TRACKER_PATH)) return 0;

  const rows = entries
    .filter((entry) => entry.type !== '정리')
    .map((entry) => `| ${kst.today().slice(5)} | [스튜어드 초안] ${entry.summary} |`);

  if (rows.length === 0) return 0;

  const original = fs.readFileSync(TRACKER_PATH, 'utf8');
  const draftPath = `${TRACKER_PATH}.steward-draft`;
  const updated = `${original.trimEnd()}\n${rows.join('\n')}\n`;
  fs.writeFileSync(draftPath, updated, 'utf8');
  return rows.length;
}

module.exports = {
  getRecentCommits,
  analyzeCommits,
  appendToTracker,
};
