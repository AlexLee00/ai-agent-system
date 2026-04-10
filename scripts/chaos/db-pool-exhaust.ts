// @ts-nocheck
#!/usr/bin/env node
'use strict';

/**
 * 카오스 테스트: DB 커넥션 풀 고갈 시뮬레이션
 *
 * pg-pool의 커넥션을 대량 점유하여
 * - 정상 쿼리가 대기하거나 타임아웃을 받는지
 * - 해제 후 정상 복구되는지
 * 검증.
 *
 * 실행: node scripts/chaos/db-pool-exhaust.js [--schema=reservation] [--connections=8] [--hold=5]
 * ⚠️  운영 환경에서 실행 금지! 개발/테스트 환경에서만!
 */

const pgPool = require('../../packages/core/lib/pg-pool');

const args    = process.argv.slice(2);
const schema  = args.find(a => a.startsWith('--schema='))?.split('=')[1]      || 'reservation';
const connCnt = parseInt(args.find(a => a.startsWith('--connections='))?.split('=')[1] || '8');
const holdSec = parseInt(args.find(a => a.startsWith('--hold='))?.split('=')[1]        || '5');

async function run() {
  console.log('=== 카오스 테스트: DB 풀 고갈 ===');
  console.log(`스키마: ${schema} | 점유 커넥션: ${connCnt}개 | 유지: ${holdSec}초`);
  console.log('⚠️  운영 환경에서 실행 금지!\n');

  // 1. 사전 점검: 연결 가능한지 확인
  const ok = await pgPool.ping(schema);
  if (!ok) {
    console.error(`❌ ${schema} 스키마에 연결 불가 — 테스트 중단`);
    process.exit(1);
  }

  // 2. 풀 상태 (전)
  const before = pgPool.getPoolStats(schema);
  console.log('풀 상태 (전):', before ? JSON.stringify(before) : 'N/A (초기화 전)');

  // 3. 커넥션 점유
  const clients = [];
  console.log(`\n커넥션 ${connCnt}개 점유 시작...`);

  for (let i = 0; i < connCnt; i++) {
    try {
      const client = await Promise.race([
        pgPool.getClient(schema),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getClient 타임아웃')), 4000)),
      ]);
      clients.push(client);
      process.stdout.write(`  [${i + 1}/${connCnt}] 점유 성공\n`);
    } catch (e) {
      console.log(`  [${i + 1}/${connCnt}] 점유 실패: ${e.message.slice(0, 60)} — 중단`);
      break;
    }
  }

  // 4. 풀 상태 (점유 중)
  const during = pgPool.getPoolStats(schema);
  console.log('\n풀 상태 (점유 중):', during ? JSON.stringify(during) : 'N/A');

  // 5. 점유 중 추가 쿼리 시도 (풀이 꽉 찼을 때 동작 검증)
  console.log('\n점유 중 추가 쿼리 시도 (5초 타임아웃)...');
  const t0 = Date.now();
  try {
    await Promise.race([
      pgPool.query(schema, 'SELECT 1 AS test'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('쿼리 타임아웃 (5초)')), 5000)),
    ]);
    console.log(`  ✅ 쿼리 성공 (${Date.now() - t0}ms) — 풀에 여유 있음`);
  } catch (e) {
    console.log(`  ⚠️ 쿼리 실패 (${Date.now() - t0}ms): ${e.message}`);
    console.log('  → pg-pool 대기/타임아웃 정상 처리 확인 ✅');
  }

  // 6. 유지 후 전체 해제
  console.log(`\n${holdSec}초 유지 후 해제...`);
  await new Promise(r => setTimeout(r, holdSec * 1000));

  let released = 0;
  for (const client of clients) {
    try { client.release(); released++; } catch {}
  }
  console.log(`${released}/${clients.length}개 커넥션 해제 완료`);

  // 7. 풀 안정화 대기 후 상태 확인
  await new Promise(r => setTimeout(r, 1500));
  const after = pgPool.getPoolStats(schema);
  console.log('\n풀 상태 (후):', after ? JSON.stringify(after) : 'N/A');

  // 8. 복구 확인
  try {
    await pgPool.query(schema, 'SELECT 1 AS recovery');
    console.log('\n✅ 복구 확인: 쿼리 정상 실행');
  } catch (e) {
    console.log('\n❌ 복구 실패:', e.message);
  }

  console.log('\n=== 테스트 완료 ===');
  process.exit(0);
}

run().catch(e => {
  console.error('❌ 테스트 오류:', e.message);
  process.exit(1);
});
