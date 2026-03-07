#!/bin/bash
# scripts/chaos/test-db-failure.sh
# 장애 주입 3: DB 에러 핸들링 확인 (안전한 방법 — PostgreSQL 정지 없음)
#
# 실제 PG 정지는 실투자 영향 가능성 있어 수행하지 않음.
# 대신 존재하지 않는 스키마 접근 시 에러 핸들링이 정상인지 확인.
set -e

cd "$(dirname "$0")/../.."
echo "=============================="
echo "🔥 장애 주입 3: DB 에러 핸들링"
echo "=============================="
echo ""

# 1. 존재하지 않는 스키마 접근 → 에러 핸들링 확인
echo "[$(date '+%H:%M:%S')] 1) 존재하지 않는 스키마 접근 테스트..."
node -e "
  const pgPool = require('./packages/core/lib/pg-pool');
  pgPool.query('nonexistent_schema_xyz', 'SELECT 1').then(r => {
    console.log('⚠️ 예상과 다르게 성공 — 핸들링 점검 필요');
    process.exit(0);
  }).catch(e => {
    console.log('✅ DB 에러 핸들링 정상:', e.message.substring(0, 80));
    process.exit(0);
  });
"

# 2. 잘못된 SQL → 에러 핸들링 확인
echo ""
echo "[$(date '+%H:%M:%S')] 2) 잘못된 SQL 에러 핸들링 테스트..."
node -e "
  const pgPool = require('./packages/core/lib/pg-pool');
  pgPool.query('reservation', 'SELECT * FROM nonexistent_table_xyz_abc').then(r => {
    console.log('⚠️ 예상과 다르게 성공');
    process.exit(0);
  }).catch(e => {
    console.log('✅ SQL 에러 핸들링 정상:', e.message.substring(0, 80));
    process.exit(0);
  });
"

# 3. pg-pool ping 확인 (정상 연결 재확인)
echo ""
echo "[$(date '+%H:%M:%S')] 3) pg-pool 정상 연결 재확인..."
node -e "
  (async () => {
    const pgPool = require('./packages/core/lib/pg-pool');
    for (const schema of ['reservation', 'claude', 'investment']) {
      try {
        await pgPool.ping(schema);
        console.log('  ✅ ' + schema + ': 연결 정상');
      } catch(e) {
        console.log('  ❌ ' + schema + ':', e.message.slice(0,60));
      }
    }
    process.exit(0);
  })();
"

echo ""
echo "[$(date '+%H:%M:%S')] ✅ 테스트 완료"
echo "참고: 실제 PG 정지 테스트는 실투자 영향으로 수동으로만 수행 가능"
