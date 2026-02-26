#!/usr/bin/env node
'use strict';

/**
 * migrate-to-sqlite.js — JSON 상태 파일 → SQLite 1회 마이그레이션
 *
 * 마이그레이션 대상:
 *   1. bots/reservation/naver-seen.json
 *      → reservations + cancelled_keys
 *   2. bots/reservation/pickko-kiosk-seen.json
 *      → kiosk_blocks
 *   3. ~/.openclaw/workspace/.pickko-alerts.jsonl
 *      → alerts
 *
 * 실행 후:
 *   - 기존 파일은 .bak 로 이름 변경 (삭제 X)
 *   - 검증 후 수동으로 .bak 파일 제거
 *
 * 사용법:
 *   node scripts/migrate-to-sqlite.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');

const NAVER_SEEN_FILE  = path.join(ROOT, 'naver-seen.json');
const KIOSK_SEEN_FILE  = path.join(ROOT, 'pickko-kiosk-seen.json');
const ALERTS_JSONL     = path.join(WORKSPACE, '.pickko-alerts.jsonl');

// DB 모듈 (lib/db.js)을 직접 불러와서 사용
const db = require('../lib/db');
const { hashKioskKey } = require('../lib/crypto');

// getDb()를 한 번 호출해서 스키마 초기화
const sqliteDb = db.getDb();

let totalRes = 0, totalCancel = 0, totalKiosk = 0, totalAlerts = 0;

// ─── 1. naver-seen.json → reservations + cancelled_keys ───────────

console.log('\n[1/3] naver-seen.json → reservations + cancelled_keys');

if (!fs.existsSync(NAVER_SEEN_FILE)) {
  console.log('  ⚠️  naver-seen.json 없음 — 스킵');
} else {
  const data = JSON.parse(fs.readFileSync(NAVER_SEEN_FILE, 'utf-8'));
  const seenIds      = new Set(data.seenIds      || []);
  const cancelledIds = data.cancelledSeenIds || [];

  // reservations: seenIds 배열에 없는 "dangling" ID는 seen_only=1로 삽입
  const reservationInsert = sqliteDb.prepare(`
    INSERT OR IGNORE INTO reservations
      (id, composite_key, name_enc, phone, phone_raw_enc,
       date, start_time, end_time, room, status,
       pickko_status, pickko_order_id, error_reason, retries,
       detected_at, pickko_start_time, pickko_complete_time,
       marked_seen, seen_only, updated_at)
    VALUES
      (@id, @composite_key, @name_enc, @phone, @phone_raw_enc,
       @date, @start_time, @end_time, @room, @status,
       @pickko_status, @pickko_order_id, @error_reason, @retries,
       @detected_at, @pickko_start_time, @pickko_complete_time,
       @marked_seen, @seen_only, datetime('now'))
  `);

  const { encrypt } = require('../lib/crypto');

  const insertMany = sqliteDb.transaction((entries) => {
    for (const [id, entry] of entries) {
      reservationInsert.run({
        id,
        composite_key:        entry.compositeKey || null,
        name_enc:             encrypt(entry.name || null),
        phone:                entry.phone || null,
        phone_raw_enc:        encrypt(entry.phoneRaw || (entry.phone || '').replace(/\D/g, '') || null),
        date:                 entry.date || '',
        start_time:           entry.start || '',
        end_time:             entry.end || null,
        room:                 entry.room || null,
        status:               entry.status || 'completed',
        pickko_status:        entry.pickkoStatus || null,
        pickko_order_id:      entry.pickkoOrderId || null,
        error_reason:         entry.errorReason || null,
        retries:              entry.retries || 0,
        detected_at:          entry.detectedAt || null,
        pickko_start_time:    entry.pickkoStartTime || null,
        pickko_complete_time: entry.pickkoCompleteTime || null,
        marked_seen:          seenIds.has(id) ? 1 : 0,
        seen_only:            0,
      });
      totalRes++;
    }
  });

  // 엔트리: seenIds/cancelledSeenIds 키 제외한 나머지
  const entries = Object.entries(data).filter(
    ([k]) => k !== 'seenIds' && k !== 'cancelledSeenIds'
  );
  insertMany(entries);

  // seenIds 중 엔트리가 없는 dangling ID → seen_only=1 최소 행
  const danglingInsert = sqliteDb.prepare(`
    INSERT OR IGNORE INTO reservations(id, date, start_time, seen_only)
    VALUES (?, '', '', 1)
  `);
  const insertDangling = sqliteDb.transaction((ids) => {
    for (const id of ids) {
      if (!data[id]) {
        danglingInsert.run(id);
        totalRes++;
      }
    }
  });
  insertDangling([...seenIds]);

  // cancelled_keys
  const cancelInsert = sqliteDb.prepare(
    "INSERT OR IGNORE INTO cancelled_keys(cancel_key) VALUES (?)"
  );
  const insertCancels = sqliteDb.transaction((keys) => {
    for (const k of keys) {
      cancelInsert.run(k);
      totalCancel++;
    }
  });
  insertCancels(cancelledIds);

  console.log(`  ✅ reservations: ${totalRes}건 삽입`);
  console.log(`  ✅ cancelled_keys: ${totalCancel}건 삽입`);

  // .bak 이름변경
  fs.renameSync(NAVER_SEEN_FILE, NAVER_SEEN_FILE + '.bak');
  console.log(`  📦 naver-seen.json → naver-seen.json.bak`);
}

// ─── 2. pickko-kiosk-seen.json → kiosk_blocks ─────────────────────

console.log('\n[2/3] pickko-kiosk-seen.json → kiosk_blocks');

if (!fs.existsSync(KIOSK_SEEN_FILE)) {
  console.log('  ⚠️  pickko-kiosk-seen.json 없음 — 스킵');
} else {
  const data = JSON.parse(fs.readFileSync(KIOSK_SEEN_FILE, 'utf-8'));
  const { encrypt } = require('../lib/crypto');

  const kioskInsert = sqliteDb.prepare(`
    INSERT OR IGNORE INTO kiosk_blocks
      (id, phone_raw_enc, name_enc, date, start_time, end_time, room,
       amount, naver_blocked, first_seen_at, blocked_at, naver_unblocked_at)
    VALUES
      (@id, @phone_raw_enc, @name_enc, @date, @start_time, @end_time, @room,
       @amount, @naver_blocked, @first_seen_at, @blocked_at, @naver_unblocked_at)
  `);

  const insertKiosks = sqliteDb.transaction((entries) => {
    for (const [origKey, entry] of entries) {
      const phoneRaw = entry.phoneRaw || origKey.split('|')[0];
      const date     = entry.date     || origKey.split('|')[1];
      const start    = entry.start    || origKey.split('|')[2];
      if (!phoneRaw || !date || !start) {
        console.log(`  ⚠️  키 파싱 실패: ${origKey} — 스킵`);
        continue;
      }
      const id = hashKioskKey(phoneRaw, date, start);
      kioskInsert.run({
        id,
        phone_raw_enc:     encrypt(phoneRaw),
        name_enc:          encrypt(entry.name || null),
        date,
        start_time:        start,
        end_time:          entry.end || null,
        room:              entry.room || null,
        amount:            entry.amount || 0,
        naver_blocked:     entry.naverBlocked ? 1 : 0,
        first_seen_at:     entry.firstSeenAt || null,
        blocked_at:        entry.blockedAt || null,
        naver_unblocked_at: entry.naverUnblockedAt || null,
      });
      totalKiosk++;
    }
  });

  insertKiosks(Object.entries(data));
  console.log(`  ✅ kiosk_blocks: ${totalKiosk}건 삽입`);

  // .bak 이름변경
  fs.renameSync(KIOSK_SEEN_FILE, KIOSK_SEEN_FILE + '.bak');
  console.log(`  📦 pickko-kiosk-seen.json → pickko-kiosk-seen.json.bak`);
}

// ─── 3. .pickko-alerts.jsonl → alerts ─────────────────────────────

console.log('\n[3/3] .pickko-alerts.jsonl → alerts');

if (!fs.existsSync(ALERTS_JSONL)) {
  console.log('  ⚠️  .pickko-alerts.jsonl 없음 — 스킵');
} else {
  const alertInsert = sqliteDb.prepare(`
    INSERT OR IGNORE INTO alerts
      (timestamp, type, title, message, sent, sent_at, resolved, resolved_at, phone, date, start_time)
    VALUES
      (@timestamp, @type, @title, @message, @sent, @sent_at, @resolved, @resolved_at, @phone, @date, @start_time)
  `);

  const lines = fs.readFileSync(ALERTS_JSONL, 'utf-8')
    .split('\n')
    .filter(l => l.trim());

  const insertAlerts = sqliteDb.transaction((ls) => {
    for (const line of ls) {
      try {
        const a = JSON.parse(line);
        alertInsert.run({
          timestamp:   a.timestamp || new Date().toISOString(),
          type:        a.type || 'info',
          title:       a.title || null,
          message:     a.message || '',
          sent:        a.sent ? 1 : 0,
          sent_at:     a.sentAt || null,
          resolved:    a.resolved === false ? 0 : 1,
          resolved_at: a.resolvedAt || null,
          phone:       a.phone || null,
          date:        a.date || null,
          start_time:  a.start || null,
        });
        totalAlerts++;
      } catch (e) {
        console.log(`  ⚠️  라인 파싱 실패: ${line.slice(0, 60)} — ${e.message}`);
      }
    }
  });

  insertAlerts(lines);
  console.log(`  ✅ alerts: ${totalAlerts}건 삽입`);

  // .bak 이름변경
  fs.renameSync(ALERTS_JSONL, ALERTS_JSONL + '.bak');
  console.log(`  📦 .pickko-alerts.jsonl → .pickko-alerts.jsonl.bak`);
}

// ─── 검증 요약 ─────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════');
console.log('마이그레이션 완료 — DB 행 수 확인:');
const counts = {
  reservations:   sqliteDb.prepare('SELECT count(*) as c FROM reservations').get().c,
  cancelled_keys: sqliteDb.prepare('SELECT count(*) as c FROM cancelled_keys').get().c,
  kiosk_blocks:   sqliteDb.prepare('SELECT count(*) as c FROM kiosk_blocks').get().c,
  alerts:         sqliteDb.prepare('SELECT count(*) as c FROM alerts').get().c,
};
for (const [tbl, cnt] of Object.entries(counts)) {
  console.log(`  ${tbl}: ${cnt}건`);
}
console.log('═══════════════════════════════════════');
console.log(`\nDB 위치: ${path.join(process.env.HOME, '.openclaw', 'workspace', 'state.db')}`);
console.log('\n⚠️  .bak 파일은 검증 후 수동으로 삭제하세요.');
console.log('   rm bots/reservation/naver-seen.json.bak');
console.log('   rm bots/reservation/pickko-kiosk-seen.json.bak');
console.log('   rm ~/.openclaw/workspace/.pickko-alerts.jsonl.bak');
