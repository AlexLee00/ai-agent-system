// @ts-nocheck
'use strict';

// SessionStart hook 전용 CLI — skill-explorer 모듈 래퍼
// 사용: tsx packages/core/lib/skills/bin/skill-explorer-cli.ts [keyword]
// keyword 없으면 전체 스킬 목록 출력, keyword 있으면 필터링

const path = require('path');
const fs = require('fs');
const { evaluateApplicability } = require(path.join(__dirname, '../skill-explorer'));

const ROOT = path.resolve(__dirname, '../../../..');
const SKILL_DIRS = [
  path.join(ROOT, '.claude/skills'),
  path.join(ROOT, 'skills'),
];

const keyword = (process.argv[2] || '').toLowerCase();

const found = [];

for (const dir of SKILL_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const content = fs.readFileSync(skillMd, 'utf8');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);
    const skillName = nameMatch ? nameMatch[1].trim() : entry.name;
    const desc = descMatch ? descMatch[1].trim() : '';
    if (!keyword || skillName.includes(keyword) || desc.toLowerCase().includes(keyword)) {
      found.push({ name: skillName, desc, dir: path.relative(ROOT, dir) });
    }
  }
}

if (found.length === 0) {
  console.log(`[SkillExplorer] 검색 결과 없음${keyword ? `: "${keyword}"` : ''}`);
} else {
  console.log(`[SkillExplorer] 스킬 ${found.length}개${keyword ? ` ("${keyword}" 매칭)` : ''}:`);
  for (const s of found) {
    console.log(`  /${s.name} — ${s.desc}`);
  }
}

process.exit(0);
