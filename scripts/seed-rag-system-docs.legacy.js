'use strict';
/**
 * scripts/seed-rag-system-docs.js — 시스템 문서 RAG 일회성 적재
 *
 * 대상: CLAUDE.md, README.md, 각 팀 CLAUDE.md
 * 실행: node scripts/seed-rag-system-docs.js
 *
 * 주의: 문서가 크게 변경될 때만 재실행
 *       기존 데이터는 삭제되지 않으므로 중복 주의
 */

const path = require('path');
const fs   = require('fs');
const rag  = require(path.join(__dirname, '../packages/core/lib/rag'));

const ROOT = path.join(__dirname, '..');

const DOCS = [
  { file: 'CLAUDE.md',              category: 'rules',       desc: '팀 제이 절대 규칙 + 시스템 규칙' },
  { file: 'README.md',              category: 'overview',    desc: '프로젝트 개요' },
  { file: 'bots/claude/CLAUDE.md',  category: 'claude_team', desc: '클로드팀 운영 규칙' },
  { file: 'bots/ska/CLAUDE.md',     category: 'ska_team',    desc: '스카팀 운영 규칙' },
  { file: 'bots/investment/CLAUDE.md', category: 'luna_team', desc: '루나팀 운영 규칙' },
  { file: 'bots/worker/CLAUDE.md',  category: 'worker_team', desc: '워커팀 운영 규칙' },
];

async function seed() {
  console.log('🔄 시스템 문서 RAG 적재 시작...\n');
  await rag.initSchema();

  let success = 0, skip = 0, fail = 0;

  for (const doc of DOCS) {
    const filePath = path.join(ROOT, doc.file);
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  ${doc.file} 없음 — 건너뜀`);
      skip++;
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const trimmed = content.slice(0, 8000);

    try {
      await rag.store('system_docs',
        `[${doc.category}] ${doc.file}: ${trimmed.slice(0, 500)}`,
        { file: doc.file, category: doc.category, description: doc.desc, char_count: content.length },
        'system'
      );
      console.log(`✅ ${doc.file} → rag_system_docs (${content.length}자)`);
      success++;
    } catch (e) {
      console.warn(`❌ ${doc.file} 실패:`, e.message);
      fail++;
    }

    // OpenAI Rate Limit 방지
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n📊 결과: 성공 ${success}건 / 건너뜀 ${skip}건 / 실패 ${fail}건`);
  console.log('✅ 시스템 문서 RAG 적재 완료');
  process.exit(0);
}

seed().catch(e => {
  console.error('❌ 적재 실패:', e.message);
  process.exit(1);
});
