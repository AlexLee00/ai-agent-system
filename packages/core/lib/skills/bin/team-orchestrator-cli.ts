// @ts-nocheck
'use strict';

// SessionStart hook 전용 CLI — team-orchestrator 모듈 래퍼
// 사용: tsx packages/core/lib/skills/bin/team-orchestrator-cli.ts

const path = require('path');
const { generateTeamReport } = require(path.join(__dirname, '../team-orchestrator'));

const report = generateTeamReport();

const statusIcon = (healthy) => (healthy ? '✅' : '⏳');

const lines = report.teams
  .filter((t) => t.status === 'active')
  .map((t) => `  ${statusIcon(t.healthy)} ${t.name}(${t.lead})`)
  .join(' | ');

console.log(`[TeamOrchestrator] 활성 팀 ${report.overall.active}개: ${lines}`);

if (report.recommendations && report.recommendations.length > 0) {
  console.log(`[TeamOrchestrator] 참고: ${report.recommendations[0]}`);
}

process.exit(0);
