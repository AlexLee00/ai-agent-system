// @ts-nocheck
/**
 * shared/position-lifecycle-cleanup.ts — Phase Ω3: Lifecycle Stage 8 Cleanup
 *
 * Stage 8 (feedback_learning) 이후 종료된 포지션의 라이프사이클 데이터를
 * 자동으로 아카이빙하고 장기 메모리(RAG)로 이전한다.
 *
 * 처리 대상:
 *   - closed=true 포지션 중 retention_days 이상 지난 lifecycle 이벤트
 *   - stage_8 완료 확인 후 archive 처리
 *
 * Kill Switch:
 *   LUNA_LIFECYCLE_CLEANUP_ENABLED=true  → 활성 (default false)
 *   LUNA_LIFECYCLE_CLEANUP_RETENTION_DAYS=30 → 보존 기간 (default 30)
 */

import * as db from './db.ts';
import { store as ragStore } from './rag-client.ts';

const ENABLED = () => {
  const raw = String(process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED ?? 'false').toLowerCase();
  return raw === 'true' || raw === '1';
};

const RETENTION_DAYS = () =>
  Math.max(1, Number(process.env.LUNA_LIFECYCLE_CLEANUP_RETENTION_DAYS || 30));

export interface LifecycleCleanupSummary {
  enabled: boolean;
  positionsChecked: number;
  entriesArchived: number;
  entriesMigratedToRag: number;
  errors: string[];
}

export interface LifecycleArchiveEntry {
  positionScopeKey: string;
  symbol: string;
  exchange: string;
  closedAt: Date | null;
  daysOld: number;
  stage8Completed: boolean;
  eventCount: number;
}

/**
 * 종료된 포지션 중 보존 기간 초과한 항목 조회.
 */
async function fetchExpiredClosedPositions(
  retentionDays: number,
): Promise<LifecycleArchiveEntry[]> {
  const rows = await db.query(
    `SELECT
       psp.id AS position_scope_key,
       psp.symbol,
       psp.exchange,
       psp.closed_at,
       EXTRACT(EPOCH FROM (NOW() - COALESCE(psp.closed_at, psp.updated_at))) / 86400 AS days_old,
       COUNT(ple.id)::int AS event_count,
       BOOL_OR(ple.stage_id = 'stage_8') AS stage8_completed
     FROM investment.position_strategy_profiles psp
     LEFT JOIN investment.position_lifecycle_events ple
       ON (
         ple.position_scope_key = psp.id
         OR (
           ple.symbol = psp.symbol
           AND ple.exchange = psp.exchange
           AND COALESCE(ple.trade_mode, 'normal') = COALESCE(psp.trade_mode, 'normal')
         )
       )
     WHERE psp.status IN ('closed', 'retired', 'archived')
       AND COALESCE(psp.closed_at, psp.updated_at) < NOW() - ($1 * INTERVAL '1 day')
       AND NOT EXISTS (
         SELECT 1 FROM investment.position_lifecycle_archive a
         WHERE a.position_scope_key = psp.id
       )
     GROUP BY psp.id, psp.symbol, psp.exchange, psp.closed_at, psp.updated_at
     HAVING COUNT(ple.id) > 0
     ORDER BY days_old DESC
     LIMIT 500`,
    [retentionDays],
  ).catch(() => []);

  return (rows || []).map((row: any) => ({
    positionScopeKey: row.position_scope_key,
    symbol: row.symbol,
    exchange: row.exchange,
    closedAt: row.closed_at ? new Date(row.closed_at) : null,
    daysOld: Math.round(Number(row.days_old || 0) * 10) / 10,
    stage8Completed: row.stage8_completed === true,
    eventCount: Number(row.event_count || 0),
  }));
}

/**
 * position_lifecycle_archive 테이블 자동 생성 (없으면).
 */
async function ensureArchiveTable(): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS investment.position_lifecycle_archive (
      id                  BIGSERIAL    PRIMARY KEY,
      position_scope_key  TEXT         NOT NULL UNIQUE,
      symbol              TEXT         NOT NULL,
      exchange            TEXT         NOT NULL,
      closed_at           TIMESTAMPTZ,
      stage8_completed    BOOLEAN      NOT NULL DEFAULT FALSE,
      event_count         INT          NOT NULL DEFAULT 0,
      rag_migrated        BOOLEAN      NOT NULL DEFAULT FALSE,
      archived_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
}

/**
 * 단일 포지션 lifecycle 아카이빙.
 */
async function archiveSinglePosition(entry: LifecycleArchiveEntry): Promise<boolean> {
  try {
    await db.run(
      `INSERT INTO investment.position_lifecycle_archive
         (position_scope_key, symbol, exchange, closed_at, stage8_completed, event_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (position_scope_key) DO NOTHING`,
      [
        entry.positionScopeKey,
        entry.symbol,
        entry.exchange,
        entry.closedAt?.toISOString() ?? null,
        entry.stage8Completed,
        entry.eventCount,
      ],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * RAG 장기 메모리로 이전.
 * lifecycle 이벤트 요약을 rag_experience에 저장.
 */
async function migrateEntryToLongTermMemory(
  entry: LifecycleArchiveEntry,
  events: any[],
): Promise<boolean> {
  try {
    const stageList = [...new Set((events || []).map((e: any) => e.stage_id).filter(Boolean))];
    const content = [
      `[라이프사이클 장기 메모리] ${entry.symbol} (${entry.exchange})`,
      `- 포지션 범위: ${entry.positionScopeKey}`,
      `- 종료일: ${entry.closedAt?.toISOString() ?? '미기록'}`,
      `- 보유 후 ${entry.daysOld}일 경과`,
      `- 처리 단계: ${stageList.join(', ') || 'n/a'}`,
      `- stage_8 완료: ${entry.stage8Completed ? '✅' : '❌'}`,
      `- 이벤트 수: ${entry.eventCount}건`,
    ].join('\n');

    await ragStore(
      'rag_experience',
      content,
      {
        event_type: 'lifecycle_archive_migrated',
        symbol: entry.symbol,
        exchange: entry.exchange,
        status: 'archived',
        position_scope_key: entry.positionScopeKey,
        stage8_completed: entry.stage8Completed,
        archived_at: new Date().toISOString(),
      },
      'luna',
    );

    await db.run(
      `UPDATE investment.position_lifecycle_archive
       SET rag_migrated = true
       WHERE position_scope_key = $1`,
      [entry.positionScopeKey],
    ).catch(() => {});

    return true;
  } catch {
    return false;
  }
}

/**
 * 보존 기간 초과 lifecycle 이벤트 정리.
 * 아카이빙된 포지션의 이벤트만 정리 (안전).
 */
export async function cleanupExpiredLifecycleEntries(
  retentionDays = RETENTION_DAYS(),
): Promise<{ deleted: number }> {
  if (!ENABLED()) return { deleted: 0 };

  const result = await db.run(
    `DELETE FROM investment.position_lifecycle_events
     WHERE position_scope_key IN (
       SELECT position_scope_key
       FROM investment.position_lifecycle_archive
       WHERE archived_at < NOW() - ($1 * INTERVAL '1 day')
         AND rag_migrated = true
     )
     AND created_at < NOW() - ($1 * INTERVAL '1 day')`,
    [retentionDays],
  ).catch(() => null);

  return { deleted: Number(result?.rowCount || 0) };
}

/**
 * 아카이빙 메인 함수.
 * 보존 기간 초과 종료 포지션 → 아카이빙 → RAG 이전.
 */
export async function archiveClosedPositions(
  opts: { retentionDays?: number; dryRun?: boolean; limit?: number } = {},
): Promise<LifecycleCleanupSummary> {
  if (!ENABLED() && !opts.dryRun) {
    return {
      enabled: false,
      positionsChecked: 0,
      entriesArchived: 0,
      entriesMigratedToRag: 0,
      errors: [],
    };
  }

  const retentionDays = opts.retentionDays ?? RETENTION_DAYS();
  const errors: string[] = [];

  await ensureArchiveTable();

  const candidates = await fetchExpiredClosedPositions(retentionDays);
  const limited = opts.limit ? candidates.slice(0, opts.limit) : candidates;

  let archived = 0;
  let ragMigrated = 0;

  if (!opts.dryRun) {
    for (const entry of limited) {
      const ok = await archiveSinglePosition(entry);
      if (ok) {
        archived++;

        const events = await db.query(
          `SELECT stage_id, event_type, created_at
           FROM investment.position_lifecycle_events
           WHERE position_scope_key = $1
              OR (symbol = $2 AND exchange = $3)
           ORDER BY created_at ASC`,
          [entry.positionScopeKey, entry.symbol, entry.exchange],
        ).catch(() => []);

        const migrated = await migrateEntryToLongTermMemory(entry, events);
        if (migrated) ragMigrated++;
      } else {
        errors.push(`archive 실패: ${entry.positionScopeKey}`);
      }
    }
  }

  return {
    enabled: true,
    positionsChecked: limited.length,
    entriesArchived: opts.dryRun ? 0 : archived,
    entriesMigratedToRag: opts.dryRun ? 0 : ragMigrated,
    errors,
  };
}

/**
 * Stage Coverage 계산.
 * 전체 8 stage 중 실제 기록된 stage 비율 반환.
 */
export async function calculateLifecycleStageCoverage(
  opts: { days?: number } = {},
): Promise<{
  totalPositions: number;
  stage8CoveredCount: number;
  coveragePercent: number;
  stageBreakdown: Record<string, number>;
}> {
  const days = opts.days ?? 30;

  const rows = await db.query(
    `SELECT
       stage_id,
       COUNT(DISTINCT position_scope_key)::int AS position_count
     FROM investment.position_lifecycle_events
     WHERE created_at > NOW() - ($1 * INTERVAL '1 day')
       AND stage_id IS NOT NULL
     GROUP BY stage_id`,
    [days],
  ).catch(() => []);

  const stageBreakdown: Record<string, number> = {};
  for (const row of rows || []) {
    stageBreakdown[row.stage_id] = Number(row.position_count);
  }

  const totalRows = await db.get(
    `SELECT COUNT(DISTINCT position_scope_key)::int AS total
     FROM investment.position_lifecycle_events
     WHERE created_at > NOW() - ($1 * INTERVAL '1 day')`,
    [days],
  ).catch(() => null);

  const totalPositions = Number(totalRows?.total || 0);
  const stage8Count = stageBreakdown['stage_8'] ?? 0;
  const coveragePercent = totalPositions > 0
    ? Math.round((stage8Count / totalPositions) * 100 * 10) / 10
    : 0;

  return {
    totalPositions,
    stage8CoveredCount: stage8Count,
    coveragePercent,
    stageBreakdown,
  };
}
