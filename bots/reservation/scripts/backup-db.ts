'use strict';

/**
 * scripts/backup-db.js — PostgreSQL reservation 스키마 자동 백업
 *
 * 백업: ~/.openclaw/workspace/backups/reservation-YYYY-MM-DD.sql
 * 보관: 최근 7일치
 * 방식: pg_dump (PostgreSQL 네이티브 백업)
 *
 * 실행: node scripts/backup-db.js
 * 자동: launchd ai.ska.db-backup (매일 03:00)
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { publishReservationAlert } = require('../lib/alert-client');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');

const BACKUP_DIR = path.join(process.env.HOME, '.openclaw', 'workspace', 'backups');
const KEEP_DAYS = 7;
const DB_NAME = 'jay';
const SCHEMA = 'reservation';
// launchd 환경에서 PATH에 PostgreSQL bin 없음 → 절대 경로
const PG_DUMP = '/opt/homebrew/opt/postgresql@17/bin/pg_dump';
const backupMemory = createAgentMemory({ agentId: 'reservation.backup-db', team: 'reservation' });

function getDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function purgeOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.match(/^reservation-\d{4}-\d{2}-\d{2}\.sql$/))
    .sort();

  const expired = files.slice(0, Math.max(0, files.length - KEEP_DAYS));
  for (const f of expired) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[백업] 만료 삭제: ${f}`);
  }
}

function buildBackupMemoryQuery(kind, dateStr) {
  return [
    'reservation backup db',
    kind,
    dateStr,
  ].filter(Boolean).join(' ');
}

async function main() {
  const dateStr = getDateStr();
  const destPath = path.join(BACKUP_DIR, `reservation-${dateStr}.sql`);

  console.log(`[백업] 시작 — PostgreSQL ${DB_NAME}.${SCHEMA} → ${destPath}`);

  // 백업 디렉토리 생성
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  try {
    // pg_dump: schema-only + data dump (절대 경로 사용 — launchd PATH 미포함)
    execSync(
      `"${PG_DUMP}" --schema=${SCHEMA} --no-owner --no-acl ${DB_NAME} > "${destPath}"`,
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    // 파일 크기 확인
    const stat = fs.statSync(destPath);
    const sizeKB = Math.round(stat.size / 1024);

    // 만료 백업 정리
    purgeOldBackups();

    const remaining = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.match(/^reservation-\d{4}-\d{2}-\d{2}\.sql$/)).length;

    const successMessage = `✅ [스카 백업 완료]\n${dateStr} / ${sizeKB}KB / 보관 ${remaining}개`;
    const memoryQuery = buildBackupMemoryQuery('success', dateStr);
    const episodicHint = await backupMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 백업',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        success: '성공',
        failure: '실패',
      },
      order: ['success', 'failure'],
    }).catch(() => '');
    const semanticHint = await backupMemory.recallHint(`${memoryQuery} consolidated backup pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    console.log(`[백업] 완료 — ${sizeKB}KB, 보관 ${remaining}개`);
    await publishReservationAlert({
      from_bot: 'ska',
      event_type: 'report',
      alert_level: 1,
      message: `${successMessage}${episodicHint}${semanticHint}`,
    }).catch(() => {});
    await backupMemory.remember(successMessage, 'episodic', {
      importance: 0.64,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: { kind: 'success', date: dateStr, sizeKB, remaining },
    }).catch(() => {});
    await backupMemory.consolidate({ olderThanDays: 14, limit: 10 }).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const msg = `🚨 [스카 백업 실패]\n${message}`;
    const memoryQuery = buildBackupMemoryQuery('failure', dateStr);
    const episodicHint = await backupMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 백업',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        failure: '실패',
        success: '성공',
      },
      order: ['failure', 'success'],
    }).catch(() => '');
    const semanticHint = await backupMemory.recallHint(`${memoryQuery} consolidated backup pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    console.error(msg);
    publishReservationAlert({
      from_bot: 'ska',
      event_type: 'system_error',
      alert_level: 3,
      message: `${msg}${episodicHint}${semanticHint}`,
    });
    await backupMemory.remember(msg, 'episodic', {
      importance: 0.84,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: { kind: 'failure', date: dateStr },
    }).catch(() => {});
    await backupMemory.consolidate({ olderThanDays: 14, limit: 10 }).catch(() => {});
    process.exit(1);
  }
}

main();
