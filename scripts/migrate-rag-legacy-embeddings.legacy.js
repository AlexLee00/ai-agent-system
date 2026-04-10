'use strict';

/**
 * scripts/migrate-rag-legacy-embeddings.js
 *
 * reservation 스키마의 legacy 1536-dim RAG 테이블을 1024-dim 로컬 임베딩 기준으로 정렬한다.
 *
 * 절차:
 * 1. 대상 테이블 embedding 컬럼을 vector(1024)로 변경하면서 기존 벡터는 NULL 처리
 * 2. content 기반으로 로컬 임베딩을 재생성
 * 3. metadata에 embedding_model / embedding_dim 기록
 *
 * 기본 대상:
 *   rag_blog
 *   rag_market_data
 *   rag_system_docs
 *   rag_reservations
 *   rag_schedule
 *   rag_work_docs
 *
 * 사용 예:
 *   node scripts/migrate-rag-legacy-embeddings.js --dry-run
 *   node scripts/migrate-rag-legacy-embeddings.js --tables rag_blog,rag_system_docs
 *   node scripts/migrate-rag-legacy-embeddings.js --skip-alter
 */

const pgPool = require('../packages/core/lib/pg-pool');
const rag = require('../packages/core/lib/rag');

const SCHEMA = 'reservation';
const DEFAULT_TABLES = [
  'rag_blog',
  'rag_market_data',
  'rag_system_docs',
  'rag_reservations',
  'rag_schedule',
  'rag_work_docs',
];
const BATCH = 25;

function parseArgs(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const tableArg = argv.find((item) => item.startsWith('--tables='));
  const tables = tableArg
    ? tableArg.split('=').slice(1).join('=').split(',').map((item) => item.trim()).filter(Boolean)
    : DEFAULT_TABLES;
  return {
    dryRun: args.has('--dry-run'),
    skipAlter: args.has('--skip-alter'),
    tables,
  };
}

async function getEmbeddingColumnType(table) {
  const rows = await pgPool.query(
    SCHEMA,
    `
      SELECT format_type(a.atttypid, a.atttypmod) AS column_type
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = $1
        AND c.relname = $2
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped
    `,
    [SCHEMA, table],
  );
  return rows[0]?.column_type || null;
}

async function countRows(table) {
  const rows = await pgPool.query(SCHEMA, `SELECT count(*)::int AS cnt FROM ${SCHEMA}.${table}`, []);
  return Number(rows[0]?.cnt || 0);
}

async function alterTableTo1024(table, dryRun = false) {
  const currentType = await getEmbeddingColumnType(table);
  const rowCount = await countRows(table);
  console.log(`[${table}] 현재 ${currentType || 'unknown'} / rows=${rowCount}`);

  if (currentType === `vector(${rag.EMBED_DIM})`) {
    console.log(`[${table}] 이미 ${rag.EMBED_DIM}차원입니다`);
    return;
  }

  if (dryRun) {
    console.log(`[${table}] DRY-RUN: vector(${rag.EMBED_DIM}) 전환 예정`);
    return;
  }

  await pgPool.run(SCHEMA, `DROP INDEX IF EXISTS ${SCHEMA}.${table}_embedding_hnsw_idx`, []);
  await pgPool.run(
    SCHEMA,
    `ALTER TABLE ${SCHEMA}.${table}
       ALTER COLUMN embedding TYPE vector(${rag.EMBED_DIM})
       USING NULL::vector(${rag.EMBED_DIM})`,
    [],
  );
  await pgPool.run(
    SCHEMA,
    `CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx
       ON ${SCHEMA}.${table} USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 64)`,
    [],
  );
  console.log(`[${table}] vector(${rag.EMBED_DIM}) 전환 완료`);
}

async function reembedTable(table, dryRun = false) {
  const rows = await pgPool.query(
    SCHEMA,
    `SELECT id, content, metadata
       FROM ${SCHEMA}.${table}
      WHERE embedding IS NULL
      ORDER BY id`,
    [],
  );

  console.log(`[${table}] 재임베드 대상 ${rows.length}건`);
  if (dryRun || rows.length === 0) return;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    for (const row of batch) {
      try {
        const vec = await rag.createEmbedding(row.content);
        const vecStr = `[${vec.join(',')}]`;
        const metadata = {
          ...(row.metadata || {}),
          embedding_model: rag.EMBED_MODEL,
          embedding_dim: rag.EMBED_DIM,
          reembedded_at: new Date().toISOString(),
        };
        await pgPool.run(
          SCHEMA,
          `UPDATE ${SCHEMA}.${table}
              SET embedding = $1::vector,
                  metadata = $2::jsonb
            WHERE id = $3`,
          [vecStr, JSON.stringify(metadata), row.id],
        );
      } catch (error) {
        console.warn(`[${table}] id=${row.id} 재임베드 실패: ${error.message}`);
      }
    }
    console.log(`[${table}] ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
}

async function main() {
  const { dryRun, skipAlter, tables } = parseArgs();
  console.log(`tables=${tables.join(', ')} dryRun=${dryRun} skipAlter=${skipAlter}`);

  for (const table of tables) {
    if (!skipAlter) {
      await alterTableTo1024(table, dryRun);
    }
    await reembedTable(table, dryRun);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ legacy RAG 마이그레이션 실패:', error);
    process.exit(1);
  });
