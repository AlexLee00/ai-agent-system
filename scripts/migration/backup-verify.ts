// @ts-nocheck
#!/usr/bin/env node
'use strict';

/**
 * scripts/migration/backup-verify.js — 백업 체계 검증
 *
 * 검증 항목:
 *   1. pg_dump 실행 가능 여부
 *   2. 백업 파일 생성 + 크기 확인
 *   3. secrets.json 존재 + 권한 600 확인
 *   4. OpenClaw 워크스페이스 존재 확인
 *   5. 복구 테스트 (DEV 임시 DB에 pg_restore)
 *
 * 사용법:
 *   node scripts/migration/backup-verify.js            # 검증만
 *   node scripts/migration/backup-verify.js --backup   # 백업 파일 생성 포함
 *   node scripts/migration/backup-verify.js --restore-test # 복구 테스트 포함 (느림)
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT         = path.join(__dirname, '../..');
const BACKUP_DIR   = path.join(os.homedir(), '.openclaw', 'workspace', 'backups');
const SECRETS_PATH = path.join(ROOT, 'bots', 'reservation', 'secrets.json');
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');

const DO_BACKUP       = process.argv.includes('--backup');
const DO_RESTORE_TEST = process.argv.includes('--restore-test');

const results = [];
function record(step, status, detail) {
  results.push({ step, status, detail });
  const icon = status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : '❌';
  console.log(`  ${icon} ${step}: ${detail}`);
}

function run(cmd) {
  try { return { ok: true, out: execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim() }; }
  catch (e) { return { ok: false, out: e.message.slice(0, 100) }; }
}

async function main() {
  console.log('\n🔒 백업 체계 검증\n');

  // ── 1. pg_dump 실행 가능 여부 ────────────────────────────────────
  const pgDumpCheck = run('pg_dump --version');
  record('pg_dump 설치', pgDumpCheck.ok ? 'pass' : 'fail',
    pgDumpCheck.ok ? pgDumpCheck.out.split('\n')[0] : pgDumpCheck.out);

  // ── 2. PostgreSQL jay DB 연결 ─────────────────────────────────────
  const dbCheck = run('psql jay -c "SELECT COUNT(*) FROM claude.agent_state" -t');
  record('jay DB 연결', dbCheck.ok ? 'pass' : 'fail',
    dbCheck.ok ? `agent_state ${dbCheck.out.trim()}행` : dbCheck.out);

  // ── 3. 백업 디렉토리 ─────────────────────────────────────────────
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    record('backups 디렉토리', 'pass', `생성됨: ${BACKUP_DIR}`);
  } else {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sql')).sort().reverse();
    record('backups 디렉토리', 'pass',
      files.length > 0
        ? `최신 백업: ${files[0]} (${files.length}개)`
        : '디렉토리 존재 (백업 없음)');
  }

  // ── 4. 백업 파일 생성 ────────────────────────────────────────────
  if (DO_BACKUP && pgDumpCheck.ok && dbCheck.ok) {
    const dateStr = new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10);
    const backupFile = path.join(BACKUP_DIR, `jay_${dateStr}.sql`);
    console.log(`  ⏳ pg_dump 실행 중... (jay → ${path.basename(backupFile)})`);
    const dumpResult = run(`pg_dump jay > "${backupFile}"`);
    if (dumpResult.ok && fs.existsSync(backupFile)) {
      const sizeMB = (fs.statSync(backupFile).size / 1024 / 1024).toFixed(2);
      record('pg_dump 백업 생성', sizeMB > 0 ? 'pass' : 'warn',
        `${backupFile} (${sizeMB}MB)`);
    } else {
      record('pg_dump 백업 생성', 'fail', dumpResult.out);
    }
  } else if (!DO_BACKUP) {
    record('pg_dump 백업 생성', 'warn', '--backup 플래그 없음 — 스킵');
  }

  // ── 5. secrets.json 확인 ─────────────────────────────────────────
  if (fs.existsSync(SECRETS_PATH)) {
    try {
      const stat = fs.statSync(SECRETS_PATH);
      const mode = (stat.mode & 0o777).toString(8);
      const s    = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
      const keys = Object.keys(s).filter(k => !k.includes('pw') && !k.includes('key') && !k.includes('token'));
      record('secrets.json 존재', 'pass', `권한 ${mode} | 항목 ${Object.keys(s).length}개`);
      if (mode !== '600') {
        record('secrets.json 권한 600', 'warn', `현재 ${mode} — chmod 600 권고`);
      } else {
        record('secrets.json 권한 600', 'pass', '600 ✅');
      }
    } catch (e) {
      record('secrets.json 파싱', 'fail', e.message);
    }
  } else {
    record('secrets.json 존재', 'fail', `없음: ${SECRETS_PATH}`);
  }

  // ── 6. OpenClaw 워크스페이스 확인 ────────────────────────────────
  const ocCheck = fs.existsSync(OPENCLAW_DIR);
  record('~/.openclaw 존재', ocCheck ? 'pass' : 'fail', OPENCLAW_DIR);

  const soulPath = path.join(OPENCLAW_DIR, 'agents', 'main', 'agent', 'SOUL.md');
  record('SOUL.md 존재', fs.existsSync(soulPath) ? 'pass' : 'warn',
    fs.existsSync(soulPath) ? soulPath : '없음 (OpenClaw 미구성 가능성)');

  // ── 7. 복구 테스트 ────────────────────────────────────────────────
  if (DO_RESTORE_TEST) {
    const files = fs.existsSync(BACKUP_DIR)
      ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sql')).sort().reverse()
      : [];

    if (files.length === 0) {
      record('복구 테스트', 'warn', '백업 파일 없음 — --backup 먼저 실행');
    } else {
      const latestBackup = path.join(BACKUP_DIR, files[0]);
      // DEV용 임시 DB에 복구 (jay_restore_test)
      console.log(`  ⏳ 복구 테스트 중 (jay_restore_test)...`);
      run('dropdb jay_restore_test 2>/dev/null || true');
      const createResult = run('createdb jay_restore_test');
      if (createResult.ok) {
        const restoreResult = run(`psql jay_restore_test < "${latestBackup}" 2>&1`);
        const countResult   = run('psql jay_restore_test -c "SELECT COUNT(*) FROM claude.agent_state" -t');
        if (countResult.ok) {
          record('복구 테스트 (jay_restore_test)', 'pass',
            `agent_state ${countResult.out.trim()}행 복원 확인`);
        } else {
          record('복구 테스트', 'warn', `복원 완료 but 조회 실패: ${countResult.out}`);
        }
        run('dropdb jay_restore_test');
      } else {
        record('복구 테스트 DB 생성', 'fail', createResult.out);
      }
    }
  } else {
    record('복구 테스트', 'warn', '--restore-test 플래그 없음 — 스킵');
  }

  // ── 요약 ─────────────────────────────────────────────────────────
  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warn').length;
  const fail = results.filter(r => r.status === 'fail').length;

  console.log('\n──────────────────────────────────────────');
  console.log(`  결과: ✅ ${pass}  ⚠️ ${warn}  ❌ ${fail}`);

  if (fail > 0) {
    console.log('\n  실패 항목:');
    results.filter(r => r.status === 'fail').forEach(r =>
      console.log(`    ❌ ${r.step}: ${r.detail}`)
    );
    process.exit(1);
  }
  console.log('');
}

main().catch(e => { console.error('❌:', e.message); process.exit(1); });
