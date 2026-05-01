// @ts-nocheck
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

async function main() {
  const result = await pgPool.query(
    'reservation',
    `DELETE FROM llm_cache WHERE expires_at::timestamptz < NOW() RETURNING id`,
  );
  const deleted = result.rowCount || 0;
  console.log(`[llm-cache] 만료 캐시 ${deleted}건 삭제`);

  try {
    await pgPool.query('reservation', 'REFRESH MATERIALIZED VIEW CONCURRENTLY llm_cache_stats');
    console.log('[llm-cache] llm_cache_stats MView 갱신 완료');
  } catch (e: any) {
    console.warn('[llm-cache] MView 갱신 실패 (무시):', e.message);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
