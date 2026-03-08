'use strict';

/**
 * scripts/setup-worker.js — 워커팀 초기 설정 스크립트
 *
 * 실행: node scripts/setup-worker.js
 *       WORKER_MASTER_PW=비밀번호 node scripts/setup-worker.js  # 비대화형
 *
 * 수행:
 *   1. worker 스키마 마이그레이션
 *   2. 마스터 업체 + 계정 생성
 *   3. 테스트 업체 + 계정 생성 (개발용)
 */

const path     = require('path');
const readline = require('readline');
const ROOT     = path.join(__dirname, '..');
const pgPool   = require(path.join(ROOT, 'packages/core/lib/pg-pool'));
const { hashPassword, validatePasswordPolicy } = require(path.join(ROOT, 'bots/worker/lib/auth'));

const SCHEMA = 'worker';

// ── 대화형 입력 ──────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function getPassword(rl, label) {
  // 환경변수 우선
  if (process.env.WORKER_MASTER_PW) return process.env.WORKER_MASTER_PW;

  while (true) {
    const pw = await ask(rl, `${label} (8자+, 대소문자+숫자+특수문자 3가지 이상): `);
    const { valid, reason } = validatePasswordPolicy(pw);
    if (valid) return pw;
    console.log(`  ❌ ${reason}`);
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔧 워커팀 초기 설정 시작\n');

  // 1. 마이그레이션
  console.log('1️⃣  DB 마이그레이션 실행...');
  const { up } = require(path.join(ROOT, 'bots/worker/migrations/001-init-schema.js'));
  await up();
  console.log('   ✅ 마이그레이션 완료 (이미 테이블이 있으면 무시)\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // 2. 마스터 업체 + 계정
    console.log('2️⃣  마스터 계정 설정...');
    const existingMaster = await pgPool.get(SCHEMA, `SELECT id FROM worker.companies WHERE id='master'`);
    if (!existingMaster) {
      await pgPool.run(SCHEMA, `INSERT INTO worker.companies (id, name) VALUES ('master', '팀 제이') ON CONFLICT DO NOTHING`);
      console.log('   ✅ 업체 생성: master (팀 제이)');
    } else {
      console.log('   ℹ️  업체 이미 존재: master');
    }

    const existingUser = await pgPool.get(SCHEMA, `SELECT id FROM worker.users WHERE username='alex'`);
    if (!existingUser) {
      const pw   = await getPassword(rl, '마스터 비밀번호');
      const hash = await hashPassword(pw);
      await pgPool.run(SCHEMA,
        `INSERT INTO worker.users (company_id, username, password_hash, role, name) VALUES ('master','alex',$1,'master','Alex') ON CONFLICT DO NOTHING`,
        [hash]);
      console.log('   ✅ 마스터 계정 생성: alex\n');
    } else {
      console.log('   ℹ️  마스터 계정 이미 존재: alex\n');
    }

    // 3. 테스트 업체 (개발용)
    console.log('3️⃣  테스트 업체 생성 (개발용)...');
    await pgPool.run(SCHEMA, `INSERT INTO worker.companies (id, name) VALUES ('test_company', '테스트(주)') ON CONFLICT DO NOTHING`);
    const testAdminHash  = await hashPassword('Admin@test1');
    const testMemberHash = await hashPassword('Member@test1');
    await pgPool.run(SCHEMA,
      `INSERT INTO worker.users (company_id,username,password_hash,role,name) VALUES ('test_company','admin1',$1,'admin','테스트관리자') ON CONFLICT DO NOTHING`,
      [testAdminHash]);
    await pgPool.run(SCHEMA,
      `INSERT INTO worker.users (company_id,username,password_hash,role,name) VALUES ('test_company','member1',$1,'member','테스트멤버') ON CONFLICT DO NOTHING`,
      [testMemberHash]);
    console.log('   ✅ 테스트 업체: test_company (테스트(주))');
    console.log('   ✅ admin1 / Admin@test1');
    console.log('   ✅ member1 / Member@test1\n');

    // 4. 결과 요약
    const users = await pgPool.query(SCHEMA, `SELECT username, role, name FROM worker.users WHERE deleted_at IS NULL ORDER BY role, username`);
    console.log('📋 등록된 계정:');
    for (const u of users) console.log(`   ${u.role === 'master' ? '👑' : u.role === 'admin' ? '🔑' : '👤'} ${u.username} [${u.role}] — ${u.name}`);

    console.log(`
✅ 워커팀 초기 설정 완료!

  🌐 웹 서버 실행:
     node bots/worker/web/server.js
     → http://localhost:4000

  🤖 팀장봇 실행:
     node bots/worker/src/worker-lead.js

  💡 launchd 등록:
     cp bots/worker/ai.worker.web.plist ~/Library/LaunchAgents/
     launchctl load ~/Library/LaunchAgents/ai.worker.web.plist
`);
  } finally {
    rl.close();
    await pgPool.closeAll().catch(() => {});
    process.exit(0);
  }
}

main().catch(e => { console.error('❌ 설정 실패:', e.message); process.exit(1); });
