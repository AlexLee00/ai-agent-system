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
const { publishToMainBot } = require('../lib/mainbot-client');

const BACKUP_DIR = path.join(process.env.HOME, '.openclaw', 'workspace', 'backups');
const KEEP_DAYS = 7;
const DB_NAME = 'jay';
const SCHEMA = 'reservation';

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

async function main() {
  const dateStr = getDateStr();
  const destPath = path.join(BACKUP_DIR, `reservation-${dateStr}.sql`);

  console.log(`[백업] 시작 — PostgreSQL ${DB_NAME}.${SCHEMA} → ${destPath}`);

  // 백업 디렉토리 생성
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  try {
    // pg_dump: schema-only + data dump
    execSync(
      `pg_dump --schema=${SCHEMA} --no-owner --no-acl ${DB_NAME} > "${destPath}"`,
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    // 파일 크기 확인
    const stat = fs.statSync(destPath);
    const sizeKB = Math.round(stat.size / 1024);

    // 만료 백업 정리
    purgeOldBackups();

    const remaining = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.match(/^reservation-\d{4}-\d{2}-\d{2}\.sql$/)).length;

    console.log(`[백업] 완료 — ${sizeKB}KB, 보관 ${remaining}개`);
  } catch (err) {
    const msg = `🚨 [스카 백업 실패]\n${err.message}`;
    console.error(msg);
    publishToMainBot({ from_bot: 'ska', event_type: 'system_error', alert_level: 3, message: msg });
    process.exit(1);
  }
}

main();
