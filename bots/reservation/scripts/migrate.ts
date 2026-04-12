#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * scripts/migrate.js — DB 스키마 마이그레이션 실행기 (PostgreSQL)
 *
 * 사용법:
 *   node scripts/migrate.js            # 미적용 마이그레이션 전부 실행
 *   node scripts/migrate.js --status   # 현재 버전 및 적용 이력 출력
 *   node scripts/migrate.js --rollback # 마지막 마이그레이션 롤백 (down)
 *   node scripts/migrate.js --version  # 현재 스키마 버전만 출력
 *
 * migrations/ 디렉토리의 NNN_name.js 파일을 버전 순으로 실행.
 * 각 파일은 다음을 export해야 한다:
 *   exports.version  {number}    버전 번호 (정수, 고유)
 *   exports.name     {string}    마이브레이션 이름
 *   exports.up()     {async fn}  스키마 업그레이드
 *   exports.down()   {async fn}  스키마 롤백 (선택)
 *
 * ⚠️  스카봇이 실행 중이면 중단 후 실행할 것.
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../lib/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ─── 마이그레이션 파일 로드 ─────────────────────────────────────────

function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`❌ migrations/ 디렉토리 없음: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+_.+\.js$/.test(f))
    .sort();

  return files.map(f => {
    const mod = require(path.join(MIGRATIONS_DIR, f));
    if (!mod.version || !mod.name || typeof mod.up !== 'function') {
      console.error(`❌ ${f}: version/name/up 누락`);
      process.exit(1);
    }
    return { version: mod.version, name: mod.name, filename: f, up: mod.up, down: mod.down };
  }).sort((a, b) => a.version - b.version);
}

// ─── 상태 출력 ─────────────────────────────────────────────────────

async function showStatus() {
  db.initMigrationsTable();
  const ver     = await db.getSchemaVersion();
  const applied = await db.getAppliedMigrations();
  const all     = loadMigrationFiles();

  console.log(`\n📦 스카봇 DB 마이그레이션 상태`);
  console.log(`   스키마 버전: v${ver}`);
  console.log(`   마이그레이션 총 ${all.length}개 (적용: ${applied.size}개)\n`);

  for (const m of all) {
    const mark = applied.has(m.version) ? '✅' : '⏳';
    console.log(`  ${mark} v${String(m.version).padStart(3, '0')} — ${m.name}  (${m.filename})`);
  }

  const pending = all.filter(m => !applied.has(m.version));
  if (pending.length > 0) {
    console.log(`\n  ⚠️  미적용: ${pending.length}개 → node scripts/migrate.js 실행`);
  } else {
    console.log(`\n  ✅ 모든 마이그레이션 적용 완료`);
  }
}

// ─── 마이그레이션 실행 ─────────────────────────────────────────────

async function runMigrations() {
  db.initMigrationsTable();
  const applied = await db.getAppliedMigrations();
  const all     = loadMigrationFiles();
  const pending = all.filter(m => !applied.has(m.version));

  if (pending.length === 0) {
    console.log('✅ 모든 마이그레이션 이미 적용됨. 추가 작업 없음.');
    return;
  }

  console.log(`\n🔄 마이그레이션 실행: ${pending.length}개 대기 중\n`);

  for (const m of pending) {
    process.stdout.write(`  ▶ v${String(m.version).padStart(3, '0')} ${m.name} ... `);
    try {
      await m.up();
      await db.recordMigration(m.version, m.name);
      console.log('✅');
    } catch (e) {
      console.log(`❌\n     오류: ${e.message}`);
      console.error(`\n마이그레이션 v${m.version} 실패 — 중단`);
      process.exit(1);
    }
  }

  const ver = await db.getSchemaVersion();
  console.log(`\n✅ 마이그레이션 완료 → 스키마 v${ver}`);
}

// ─── 롤백 ──────────────────────────────────────────────────────────

async function rollbackLast() {
  db.initMigrationsTable();
  const applied = await db.getAppliedMigrations();

  if (applied.size === 0) {
    console.log('⚠️  롤백할 마이그레이션 없음');
    return;
  }

  const all  = loadMigrationFiles();
  const last = all.filter(m => applied.has(m.version)).at(-1);

  if (!last) {
    console.log('⚠️  마이그레이션 파일을 찾을 수 없음');
    return;
  }

  if (typeof last.down !== 'function') {
    console.log(`❌ v${last.version} ${last.name}: down() 미정의 — 롤백 불가`);
    process.exit(1);
  }

  console.log(`\n⏪ 롤백: v${last.version} ${last.name}`);
  console.log('   ⚠️  데이터 손실 가능 — 3초 후 실행 (Ctrl+C로 취소)\n');

  // 3초 대기 (동기식)
  const end = Date.now() + 3000;
  while (Date.now() < end) { /* busy wait */ }

  try {
    await last.down();
    await db.removeMigration(last.version);
    const newVer = await db.getSchemaVersion();
    console.log(`✅ 롤백 완료 → 스키마 v${newVer}`);
  } catch (e) {
    console.error(`❌ 롤백 실패: ${e.message}`);
    process.exit(1);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

(async () => {
  try {
    if (args.includes('--status')) {
      await showStatus();
    } else if (args.includes('--rollback')) {
      await rollbackLast();
    } else if (args.includes('--version')) {
      db.initMigrationsTable();
      console.log(`v${await db.getSchemaVersion()}`);
    } else {
      await runMigrations();
    }
  } catch (e) {
    console.error('❌ 오류:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
