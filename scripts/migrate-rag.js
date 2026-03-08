#!/usr/bin/env node
'use strict';

/**
 * scripts/migrate-rag.js — ChromaDB → pgvector 마이그레이션
 *
 * 기존 ~/projects/rag-system/data/chroma_db/ 데이터를
 * PostgreSQL pgvector (packages/core/lib/rag.js)로 이전
 *
 * 사용법:
 *   node scripts/migrate-rag.js                      # 전체 마이그레이션
 *   node scripts/migrate-rag.js --collection=system_docs  # 특정 컬렉션만
 *   node scripts/migrate-rag.js --dry-run            # 실행 없이 미리보기
 */

const path = require('path');
const os   = require('os');
const { execSync, spawnSync } = require('child_process');
const rag  = require('../packages/core/lib/rag');

const CHROMA_PATH  = path.join(os.homedir(), 'projects', 'rag-system', 'data', 'chroma_db');
const PYTHON_BIN   = path.join(os.homedir(), 'projects', 'rag-system', '.venv', 'bin', 'python3');

// ChromaDB → pgvector 컬렉션 이름 매핑
const COLLECTION_MAP = {
  'system_docs':  'system_docs',
  'reservations': 'reservations',
  'market_data':  'market_data',
  'schedule':     'schedule',
  'work_docs':    'work_docs',
};

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const ONLY_COL = args.find(a => a.startsWith('--collection='))?.split('=')[1];

// ── ChromaDB 덤프 (Python subprocess) ──────────────────────────────

function dumpChromaCollection(colName) {
  const script = `
import sys, json, chromadb
client = chromadb.PersistentClient(path='${CHROMA_PATH}')
try:
    col = client.get_collection('${colName}')
    result = col.get(include=['documents','metadatas'])
    docs = result.get('documents') or []
    metas = result.get('metadatas') or []
    ids = result.get('ids') or []
    output = [{'id': ids[i], 'content': docs[i], 'metadata': metas[i] or {}} for i in range(len(docs)) if docs[i]]
    print(json.dumps(output, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

  const result = spawnSync(PYTHON_BIN, ['-c', script], {
    encoding: 'utf8',
    timeout:  30000,
  });

  if (result.error) throw new Error(`Python 실행 실패: ${result.error.message}`);
  const output = (result.stdout || '').trim();
  if (!output) throw new Error(`ChromaDB 출력 없음 (컬렉션: ${colName})`);

  const data = JSON.parse(output);
  if (data.error) throw new Error(`ChromaDB 오류: ${data.error}`);
  return data;  // [{ id, content, metadata }]
}

// ── 마이그레이션 실행 ────────────────────────────────────────────────

async function migrateCollection(colName, targetName) {
  console.log(`\n📦 [${colName}] 마이그레이션 시작...`);

  // ChromaDB에서 데이터 추출
  let docs;
  try {
    docs = dumpChromaCollection(colName);
  } catch (e) {
    console.warn(`  ⚠️ ChromaDB 추출 실패 (건너뜀): ${e.message}`);
    return { skipped: true, reason: e.message };
  }

  if (docs.length === 0) {
    console.log(`  ℹ️ 데이터 없음 — 건너뜀`);
    return { skipped: true, count: 0 };
  }

  console.log(`  총 ${docs.length}건 추출 완료`);

  if (DRY_RUN) {
    console.log(`  🔍 [DRY-RUN] 실제 임베딩/저장은 생략`);
    docs.slice(0, 2).forEach((d, i) => {
      console.log(`  [${i}] ${d.content?.slice(0, 60)}...`);
    });
    return { dryRun: true, count: docs.length };
  }

  // pgvector에 저장 (OpenAI 임베딩)
  let success = 0;
  let failed  = 0;
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (!doc.content?.trim()) { failed++; continue; }
    try {
      await rag.store(targetName, doc.content, {
        ...doc.metadata,
        migrated_from: 'chromadb',
        original_id:   doc.id,
      }, 'migrate');
      success++;
      process.stdout.write(`\r  저장 중: ${success}/${docs.length} 완료, ${failed} 실패`);
    } catch (e) {
      failed++;
      if (failed <= 3) console.error(`\n  ❌ [${i}] 저장 실패: ${e.message}`);
    }
    // API 요청 간격 (Rate limit 방지)
    if (i < docs.length - 1) await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n  ✅ ${success}건 성공, ${failed}건 실패`);
  return { success, failed, total: docs.length };
}

// ── 메인 ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 ChromaDB → pgvector 마이그레이션 시작');
  if (DRY_RUN) console.log('  [DRY-RUN 모드 — 실제 저장 없음]');

  // 스키마 초기화
  if (!DRY_RUN) {
    await rag.initSchema();
    console.log('✅ pgvector 스키마 확인 완료');
  }

  const targets = ONLY_COL
    ? { [ONLY_COL]: COLLECTION_MAP[ONLY_COL] || ONLY_COL }
    : COLLECTION_MAP;

  const summary = {};
  for (const [colName, targetName] of Object.entries(targets)) {
    try {
      summary[colName] = await migrateCollection(colName, targetName);
    } catch (e) {
      console.error(`\n❌ [${colName}] 치명 오류:`, e.message);
      summary[colName] = { error: e.message };
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log('📊 마이그레이션 결과:');
  for (const [col, result] of Object.entries(summary)) {
    if (result.skipped)    console.log(`  ${col}: 건너뜀 (${result.reason || '데이터 없음'})`);
    else if (result.dryRun) console.log(`  ${col}: DRY-RUN ${result.count}건`);
    else if (result.error) console.log(`  ${col}: ❌ 오류 — ${result.error}`);
    else                   console.log(`  ${col}: ✅ ${result.success}/${result.total}건 완료`);
  }

  console.log('\n다음 단계:');
  console.log('  1. node packages/core/lib/rag-server.js  (서버 기동 테스트)');
  console.log('  2. launchctl load ~/Library/LaunchAgents/ai.rag.server.plist  (등록)');
  console.log('  3. 기존 rag-system FastAPI 종료: pkill -f uvicorn');
}

main().catch(e => {
  console.error('❌ 마이그레이션 실패:', e.message);
  process.exit(1);
});
