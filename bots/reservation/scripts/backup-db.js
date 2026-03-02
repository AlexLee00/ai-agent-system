'use strict';

/**
 * scripts/backup-db.js — state.db 자동 백업
 *
 * 위치: ~/.openclaw/workspace/state.db
 * 백업: ~/.openclaw/workspace/backups/state-YYYY-MM-DD.db
 * 보관: 최근 7일치
 * 방식: better-sqlite3 .backup() API (WAL 모드 온라인 백업, 안전)
 *
 * 실행: node scripts/backup-db.js
 * 자동: launchd ai.ska.db-backup (매일 03:00)
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(process.env.HOME, '.openclaw', 'workspace', 'state.db');
const BACKUP_DIR = path.join(process.env.HOME, '.openclaw', 'workspace', 'backups');
const KEEP_DAYS = 7;

async function sendTelegram(message) {
  try {
    const secrets = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'secrets.json'),
        'utf8'
      )
    );
    const { telegram_token, telegram_chat_id } = secrets;
    if (!telegram_token || !telegram_chat_id) return;

    const https = require('https');
    const body = JSON.stringify({ chat_id: telegram_chat_id, text: message });
    await new Promise((resolve) => {
      const req = https.request(
        `https://api.telegram.org/bot${telegram_token}/sendMessage`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        resolve
      );
      req.on('error', resolve);
      req.write(body);
      req.end();
    });
  } catch {
    // 텔레그램 실패는 무시 (백업 결과에 영향 없음)
  }
}

function getDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function purgeOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.match(/^state-\d{4}-\d{2}-\d{2}\.db$/))
    .sort();

  const expired = files.slice(0, Math.max(0, files.length - KEEP_DAYS));
  for (const f of expired) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[백업] 만료 삭제: ${f}`);
  }
}

async function main() {
  const dateStr = getDateStr();
  const destPath = path.join(BACKUP_DIR, `state-${dateStr}.db`);

  console.log(`[백업] 시작 — ${DB_PATH} → ${destPath}`);

  // 백업 디렉토리 생성
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // state.db 존재 확인
  if (!fs.existsSync(DB_PATH)) {
    const msg = `⚠️ [스카 백업] state.db 없음\n경로: ${DB_PATH}`;
    console.error(msg);
    await sendTelegram(msg);
    process.exit(1);
  }

  try {
    // WAL 모드 온라인 백업 (better-sqlite3 .backup() API)
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    await db.backup(destPath);
    db.close();

    // 파일 크기 확인
    const stat = fs.statSync(destPath);
    const sizeKB = Math.round(stat.size / 1024);

    // 만료 백업 정리
    purgeOldBackups();

    const remaining = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.match(/^state-\d{4}-\d{2}-\d{2}\.db$/)).length;

    console.log(`[백업] 완료 — ${sizeKB}KB, 보관 ${remaining}개`);
  } catch (err) {
    const msg = `🚨 [스카 백업 실패]\n${err.message}`;
    console.error(msg);
    await sendTelegram(msg);
    process.exit(1);
  }
}

main();
