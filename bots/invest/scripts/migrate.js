#!/usr/bin/env node
'use strict';

/**
 * scripts/migrate.js — DB 마이그레이션 실행기
 *
 * 사용법:
 *   node scripts/migrate.js            # 미적용 마이그레이션 전부 실행
 *   node scripts/migrate.js --status   # 현재 버전 및 적용 이력 출력
 *   node scripts/migrate.js --rollback # 마지막 마이그레이션 롤백 (down)
 *   node scripts/migrate.js --version  # 현재 스키마 버전만 출력
 *
 * migrations/ 디렉토리의 NNN_name.js 파일을 순서대로 실행.
 * 각 파일은 exports.version (정수), exports.name (문자열),
 * async up(db), async down(db) 를 export해야 함.
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../lib/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ─── 마이그레이션 파일 로드 ─────────────────────────────────────────

function loadMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.match(/^\d+_.+\.js$/))
    .sort();

  return files.map(f => {
    const mod = require(path.join(MIGRATIONS_DIR, f));
    return {
      version:  mod.version,
      name:     mod.name,
      filename: f,
      up:       mod.up,
      down:     mod.down,
    };
  }).sort((a, b) => a.version - b.version);
}

// ─── 상태 출력 ─────────────────────────────────────────────────────

async function showStatus() {
  await db.initMigrationsTable();
  const ver     = await db.getSchemaVersion();
  const applied = await db.getAppliedMigrations();
  const all     = loadMigrationFiles();

  console.log(`\n📦 투자봇 DB 마이그레이션 상태`);
  console.log(`   스키마 버전: v${ver}`);
  console.log(`   마이그레이션 총 ${all.length}개 (적용: ${applied.size}개)\n`);

  for (const m of all) {
    const isApplied = applied.has(m.version);
    const mark      = isApplied ? '✅' : '⏳';
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
  await db.initMigrationsTable();
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
      await m.up(db);
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
  await db.initMigrationsTable();
  const ver     = await db.getSchemaVersion();
  const applied = await db.getAppliedMigrations();

  if (applied.size === 0) {
    console.log('⚠️  롤백할 마이그레이션 없음');
    return;
  }

  const all     = loadMigrationFiles();
  const last    = all.filter(m => applied.has(m.version)).at(-1);

  if (!last) {
    console.log('⚠️  마이그레이션 파일을 찾을 수 없음');
    return;
  }

  if (!last.down) {
    console.log(`❌ v${last.version} ${last.name}: down() 미정의 — 롤백 불가`);
    process.exit(1);
  }

  console.log(`\n⏪ 롤백: v${last.version} ${last.name}`);
  console.log('   ⚠️  데이터 손실 가능 — 3초 후 실행 (Ctrl+C로 취소)\n');
  await new Promise(r => setTimeout(r, 3000));

  try {
    await last.down(db);
    await db.run(`DELETE FROM schema_migrations WHERE version = ?`, [last.version]);
    const newVer = await db.getSchemaVersion();
    console.log(`✅ 롤백 완료 → 스키마 v${newVer}`);
  } catch (e) {
    console.error(`❌ 롤백 실패: ${e.message}`);
    process.exit(1);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    await showStatus();
  } else if (args.includes('--rollback')) {
    await rollbackLast();
  } else if (args.includes('--version')) {
    await db.initMigrationsTable();
    const ver = await db.getSchemaVersion();
    console.log(`v${ver}`);
  } else {
    await runMigrations();
  }
}

main()
  .then(() => { db.close(); process.exit(0); })
  .catch(e => { console.error('❌', e.message); db.close(); process.exit(1); });
