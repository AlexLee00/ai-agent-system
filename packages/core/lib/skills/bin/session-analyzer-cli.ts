// @ts-nocheck
'use strict';

// SessionStart hook 전용 CLI — session-analyzer 모듈 래퍼
// 사용: tsx packages/core/lib/skills/bin/session-analyzer-cli.ts [since]
// 예:  tsx ... "24 hours ago"

const path = require('path');
const analyzer = require(path.join(__dirname, '../session-analyzer'));

const since = process.argv[2] || '24 hours ago';

const changes = analyzer.analyzeChanges(since);
const risk = changes.riskLevel || 'LOW';
const fileCount = changes.files ? changes.files.length : 0;

if (risk === 'LOW' && fileCount === 0) {
  // 변경 없음 — 출력 생략
  process.exit(0);
}

const icons = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢', UNKNOWN: '⚪' };
const icon = icons[risk] || '⚪';
console.log(`[Skills] 세션 컨텍스트 ${icon} 위험도: ${risk} | 변경 파일: ${fileCount}개 (+${changes.additions || 0}/-${changes.deletions || 0})`);

const missing = analyzer.detectMissingVerification(changes);
if (missing.missing && missing.missing.length > 0) {
  console.log(`[Skills] 누락 검증: ${missing.missing.join(' / ')}`);
}
if (missing.suggestions && missing.suggestions.length > 0) {
  console.log(`[Skills] 권장: ${missing.suggestions[0]}`);
}

process.exit(0);
