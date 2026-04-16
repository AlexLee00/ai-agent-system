// @ts-nocheck
'use strict';

/**
 * scripts/reembed-rag.js
 *
 * 기존 RAG 데이터를 로컬 MLX 임베딩으로 재생성.
 * embedding이 NULL인 행만 처리한다.
 */

const pgPool = require('../packages/core/lib/pg-pool');
const { createEmbedding } = require('../packages/core/lib/rag');

const SCHEMA = 'reservation';
const TABLES = ['rag_operations', 'rag_trades', 'rag_tech', 'rag_video'];
const BATCH = 10;

async function reembedTable(table) {
  const rows = await pgPool.query(
    SCHEMA,
    `SELECT id, content
       FROM ${SCHEMA}.${table}
      WHERE embedding IS NULL
      ORDER BY id`,
    [],
  );

  console.log(`[${table}] ${rows.length}건 재임베딩 필요`);

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);

    for (const row of batch) {
      try {
        const vec = await createEmbedding(row.content);
        const vecStr = `[${vec.join(',')}]`;
        await pgPool.run(
          SCHEMA,
          `UPDATE ${SCHEMA}.${table}
              SET embedding = $1::vector
            WHERE id = $2`,
          [vecStr, row.id],
        );
      } catch (e) {
        console.warn(`  ⚠️ ${table} id=${row.id} 실패: ${e.message}`);
      }
    }

    console.log(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  console.log(`✅ ${table} 완료`);
}

async function main() {
  for (const table of TABLES) {
    await reembedTable(table);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ 재임베딩 실패:', e);
    process.exit(1);
  });
