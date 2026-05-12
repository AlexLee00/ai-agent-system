// @ts-nocheck
/**
 * check-secrets-expiry.ts — secrets-store.json 만료 키 스캔 + Telegram 알림
 *
 * secrets-store.json 내 모든 expires_at / expiry / valid_until / expiration 필드를 재귀 탐색.
 * 7일 이내 만료 → 경고, 1일 이내 → 긴급, 이미 만료 → 즉시 알림.
 *
 * launchd: ai.hub.secrets-expiry-check (daily 09:00 KST = 00:00 UTC)
 */

import fs from 'fs';
import path from 'path';

const env = require('../../../packages/core/lib/env');
const sender = require('../../../packages/core/lib/telegram-sender');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const WARN_DAYS = 7;
const CRITICAL_DAYS = 1;

const EXPIRY_KEYS = new Set([
  'expires_at',
  'expiry',
  'valid_until',
  'expiration',
  'approval_key_expires_at',
  'access_token_expires_at',
  'refresh_token_expires_at',
]);

interface ExpiryEntry {
  path: string;
  expiresAt: Date;
  daysRemaining: number;
  level: 'expired' | 'critical' | 'warn';
}

function scanExpiry(obj: unknown, pathParts: string[] = []): ExpiryEntry[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];

  const entries: ExpiryEntry[] = [];
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const keyLower = key.toLowerCase();

    if (EXPIRY_KEYS.has(keyLower) && typeof val === 'string' && val.trim()) {
      const expiresAt = new Date(val);
      if (!Number.isFinite(expiresAt.getTime())) continue;

      const daysRemaining = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      let level: ExpiryEntry['level'];
      if (daysRemaining <= 0) level = 'expired';
      else if (daysRemaining <= CRITICAL_DAYS) level = 'critical';
      else if (daysRemaining <= WARN_DAYS) level = 'warn';
      else continue; // healthy

      entries.push({
        path: [...pathParts, key].join('.'),
        expiresAt,
        daysRemaining: Math.round(daysRemaining * 10) / 10,
        level,
      });
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      entries.push(...scanExpiry(val, [...pathParts, key]));
    }
  }
  return entries;
}

function formatEntry(e: ExpiryEntry): string {
  const date = e.expiresAt.toISOString().slice(0, 10);
  if (e.level === 'expired') {
    return `  • \`${e.path}\` — ${date} (${Math.abs(e.daysRemaining).toFixed(1)}일 초과)`;
  }
  return `  • \`${e.path}\` — ${date} (${e.daysRemaining.toFixed(1)}일 남음)`;
}

async function main() {
  console.log(`[secrets-expiry] ${new Date().toISOString()} 스캔 시작`);

  let store: Record<string, unknown>;
  try {
    store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err: any) {
    console.error('[secrets-expiry] secrets-store.json 읽기 실패:', err.message);
    process.exit(1);
  }

  const issues = scanExpiry(store);

  if (!issues.length) {
    console.log('[secrets-expiry] 만료 임박 키 없음 ✅');
    return;
  }

  const expired = issues.filter(e => e.level === 'expired');
  const critical = issues.filter(e => e.level === 'critical');
  const warn = issues.filter(e => e.level === 'warn');

  const lines: string[] = ['🔑 *secrets-store 만료 알림*'];
  if (expired.length) {
    lines.push('\n🚨 *이미 만료됨:*');
    expired.forEach(e => lines.push(formatEntry(e)));
  }
  if (critical.length) {
    lines.push('\n🔴 *긴급 (24시간 이내):*');
    critical.forEach(e => lines.push(formatEntry(e)));
  }
  if (warn.length) {
    lines.push('\n🟡 *경고 (7일 이내):*');
    warn.forEach(e => lines.push(formatEntry(e)));
  }

  const message = lines.join('\n');
  console.log('[secrets-expiry] 발견된 이슈:');
  console.log(message.replace(/[*`]/g, ''));

  try {
    if (expired.length || critical.length) {
      await sender.sendCritical('general', message);
    } else {
      await sender.send('general', message);
    }
    console.log('[secrets-expiry] Telegram 알림 발송 완료');
  } catch (err: any) {
    console.error('[secrets-expiry] Telegram 발송 실패 (무시):', err.message);
  }
}

main().catch((err) => {
  console.error('[secrets-expiry] 오류:', err);
  process.exit(1);
});
