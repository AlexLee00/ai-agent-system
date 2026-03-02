#!/usr/bin/env node
'use strict';

/**
 * scripts/setup-db.js — DuckDB 스키마 초기화
 *
 * 실행: node scripts/setup-db.js
 */

const path = require('path');
const fs = require('fs');

async function main() {
  console.log('🔧 [setup-db] DuckDB 스키마 초기화...');

  // db 디렉토리 생성
  const dbDir = path.join(__dirname, '..', 'db');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`  📁 db/ 디렉토리 생성`);
  }

  // secrets.json 없으면 example에서 복사 안내
  const secretsPath = path.join(__dirname, '..', 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    const exPath = path.join(__dirname, '..', 'secrets.example.json');
    fs.copyFileSync(exPath, secretsPath);
    require('child_process').execSync(`chmod 600 "${secretsPath}"`);
    console.log(`  ✅ secrets.json 생성 (example에서 복사) — API 키 설정 후 사용하세요`);
  }

  const db = require('../lib/db');
  await db.initSchema();

  // 스키마 확인
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`
  );
  console.log('\n📋 생성된 테이블:');
  tables.forEach(t => console.log(`  - ${t.table_name}`));

  db.close();
  console.log('\n✅ setup-db 완료');
}

main().catch(e => { console.error('❌ 오류:', e.message); process.exit(1); });
