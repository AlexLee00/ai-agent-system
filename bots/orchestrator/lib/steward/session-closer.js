'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');
const kst = require('../../../../packages/core/lib/kst');
const trackerSync = require('./tracker-sync');
const codexManager = require('./codex-manager');

const HANDOFF_PATH = path.join(env.PROJECT_ROOT, 'docs', 'OPUS_FINAL_HANDOFF.md');

function generate() {
  const commits = trackerSync.getRecentCommits(12);
  const analyzed = trackerSync.analyzeCommits(commits);
  const codexStatus = codexManager.summarize();

  const lines = [
    `# 세션 인수인계 — ${kst.today()}`,
    '',
    '## 최근 작업',
    ...(analyzed.length > 0
      ? analyzed.slice(0, 15).map((item, index) => `${index + 1}. ${item.summary}`)
      : ['1. 최근 12시간 커밋 없음']),
    '',
    `## 코덱스 상태 (활성 ${codexStatus.active}개)`,
    ...(codexStatus.names.length > 0 ? codexStatus.names.map((name) => `- ${name}`) : ['- 활성 코덱스 없음']),
    '',
    '## 다음 작업',
    '- TRACKER .steward-draft 확인',
    '- archive 이동 후보 재검토',
    '- git 위생 경고 파일 확인',
  ];

  fs.writeFileSync(HANDOFF_PATH, `${lines.join('\n')}\n`, 'utf8');
  return { commits: commits.length, codex: codexStatus };
}

module.exports = { generate };
