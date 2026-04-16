// @ts-nocheck
'use strict';

/**
 * scripts/migrate.js — claude-team.db 마이그레이션 러너
 *
 * 사용법: node scripts/migrate.js
 * 역할: migrations/ 폴더의 파일을 버전 순으로 실행하고 schema_migrations에 기록
 */

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const Database = require('better-sqlite3');

const DB_PATH         = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
const MIGRATIONS_DIR  = path.join(__dirname, '..', 'migrations');

function main() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 마이그레이션 파일 수집
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    console.log('마이그레이션 파일 없음.');
    db.close();
    return;
  }

  // schema_migrations 테이블이 없으면 첫 마이그레이션이 생성함
  let appliedVersions = new Set();
  try {
    appliedVersions = new Set(
      db.prepare(`SELECT version FROM schema_migrations`).all().map(r => r.version)
    );
  } catch { /* 테이블 아직 없음 — 정상 */ }

  let applied = 0;
  for (const file of files) {
    const migration = require(path.join(MIGRATIONS_DIR, file));
    const { version, name } = migration;

    if (appliedVersions.has(version)) {
      console.log(`  ✓ v${version} ${name} — 이미 적용됨`);
      continue;
    }

    console.log(`  → v${version} ${name} 적용 중...`);
    try {
      const run = db.transaction(() => migration.up(db));
      run();
      console.log(`  ✅ v${version} ${name} 완료`);
      applied++;
    } catch (e) {
      console.error(`  ❌ v${version} ${name} 실패: ${e.message}`);
      db.close();
      process.exit(1);
    }
  }

  console.log(`\n마이그레이션 완료 — ${applied}개 적용 (총 ${files.length}개 파일)`);
  console.log(`DB 위치: ${DB_PATH}`);
  db.close();
}

main();
