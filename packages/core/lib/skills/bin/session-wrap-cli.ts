// @ts-nocheck
'use strict';

// Stop hook 전용 CLI — session-wrap 모듈 래퍼
// 사용: tsx packages/core/lib/skills/bin/session-wrap-cli.ts [since]
// 예:  tsx ... "4 hours ago"

const path = require('path');
const wrap = require(path.join(__dirname, '../session-wrap'));

const since = process.argv[2] || '4 hours ago';

const result = wrap.summarizeSession(since);
if (!result || result.commits.length === 0) {
  process.exit(0);
}

console.log(`[Skills] 세션 요약: ${result.summary}`);

const learnings = wrap.extractLearnings(result.commits);
if (learnings.issues.length > 0) {
  console.log(`[Skills] 수정 ${learnings.issues.length}건 — docs/history/WORK_HISTORY.md 업데이트 권장`);
}
if (learnings.improvements.length > 0) {
  console.log(`[Skills] 개선 ${learnings.improvements.length}건`);
}
if (learnings.patterns.length > 0) {
  console.log(`[Skills] 패턴 ${learnings.patterns.length}건`);
}

// 세션 핸드오프 생성 여부 안내
const totalChanges = learnings.issues.length + learnings.improvements.length;
if (totalChanges >= 3) {
  console.log('[Skills] HANDOFF 업데이트 권장: docs/OPUS_FINAL_HANDOFF.md');
}

process.exit(0);
