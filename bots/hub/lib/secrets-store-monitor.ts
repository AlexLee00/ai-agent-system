// @ts-nocheck
/**
 * secrets-store-monitor.ts — Stage D2: secrets 만료 모니터링 + DB 감사 로그
 *
 * check-secrets-expiry.ts 를 강화:
 * - 스캔 결과를 hub.secrets_rotation_log 에 기록
 * - 일일 요약 리포트
 * - Telegram 알림 (기존 패턴 유지)
 * - secret 값은 변경하지 않는다. 자동 갱신은 별도 승인/전용 rotator가 필요하다.
 *
 * launchd: ai.hub.secrets-auto-rotate (legacy label, monitor-only, 매일 06:00 KST)
 */

import fs from 'fs';
import path from 'path';

const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
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

export interface ExpiryEntry {
  path: string;
  expiresAt: Date;
  daysRemaining: number;
  level: 'healthy' | 'warn' | 'critical' | 'expired';
}

export interface MonitorResult {
  checkedAt: string;
  dryRun?: boolean;
  total: number;
  healthy: number;
  warn: number;
  critical: number;
  expired: number;
  issues: ExpiryEntry[];
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
      else level = 'healthy';

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

async function logToDb(entries: ExpiryEntry[]): Promise<{ logged: number; error?: string }> {
  if (!entries.length) return { logged: 0 };
  try {
    const now = new Date().toISOString();
    const rows = entries.map((e) => ({
      checked_at: now,
      secret_path: e.path,
      expires_at: e.expiresAt.toISOString(),
      days_remaining: e.daysRemaining,
      level: e.level,
      action_taken: 'alerted',
    }));

    for (const row of rows) {
      await pgPool.query('public', `
        INSERT INTO hub.secrets_rotation_log
          (checked_at, secret_path, expires_at, days_remaining, level, action_taken)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [row.checked_at, row.secret_path, row.expires_at, row.days_remaining, row.level, row.action_taken]);
    }
    return { logged: rows.length };
  } catch (err: any) {
    return { logged: 0, error: err.message };
  }
}

function formatEntry(e: ExpiryEntry): string {
  const date = e.expiresAt.toISOString().slice(0, 10);
  if (e.level === 'expired') {
    return `  • \`${e.path}\` — ${date} (${Math.abs(e.daysRemaining).toFixed(1)}일 초과)`;
  }
  return `  • \`${e.path}\` — ${date} (${e.daysRemaining.toFixed(1)}일 남음)`;
}

export async function runSecretsMonitor(options: { silent?: boolean; dryRun?: boolean } = {}): Promise<MonitorResult> {
  const checkedAt = new Date().toISOString();

  let store: Record<string, unknown>;
  try {
    store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err: any) {
    throw new Error(`secrets-store.json 읽기 실패: ${err.message}`);
  }

  const allEntries = scanExpiry(store);
  const issues = allEntries.filter((e) => e.level !== 'healthy');
  const healthy = allEntries.filter((e) => e.level === 'healthy').length;

  const result: MonitorResult = {
    checkedAt,
    dryRun: Boolean(options.dryRun),
    total: allEntries.length,
    healthy,
    warn: issues.filter((e) => e.level === 'warn').length,
    critical: issues.filter((e) => e.level === 'critical').length,
    expired: issues.filter((e) => e.level === 'expired').length,
    issues,
  };

  if (!options.silent) {
    console.log(`[secrets-monitor] ${checkedAt} 스캔: total=${result.total} healthy=${result.healthy} warn=${result.warn} critical=${result.critical} expired=${result.expired}`);
  }

  // DB 로깅 (이슈 있는 항목만). Dry-run은 수동 점검/CI에서 외부 부작용을 막는다.
  if (issues.length > 0 && !options.dryRun) {
    const dbResult = await logToDb(issues);
    if (dbResult.error) {
      console.warn(`[secrets-monitor] DB 로깅 실패 (무시): ${dbResult.error}`);
    } else if (!options.silent) {
      console.log(`[secrets-monitor] DB 로그 ${dbResult.logged}건 기록`);
    }
  }

  // Telegram 알림 (이슈 있을 때만). Dry-run은 발송하지 않는다.
  if (issues.length > 0 && !options.dryRun) {
    const expired = issues.filter((e) => e.level === 'expired');
    const critical = issues.filter((e) => e.level === 'critical');
    const warn = issues.filter((e) => e.level === 'warn');

    const lines: string[] = ['🔑 *secrets-store 만료 알림 (Stage D2)*'];
    if (expired.length) {
      lines.push('\n🚨 *이미 만료됨:*');
      expired.forEach((e) => lines.push(formatEntry(e)));
    }
    if (critical.length) {
      lines.push('\n🔴 *긴급 (24시간 이내):*');
      critical.forEach((e) => lines.push(formatEntry(e)));
    }
    if (warn.length) {
      lines.push('\n🟡 *경고 (7일 이내):*');
      warn.forEach((e) => lines.push(formatEntry(e)));
    }
    lines.push(`\n_스캔: ${checkedAt.slice(0, 16)} UTC_`);

    const message = lines.join('\n');

    try {
      if (expired.length || critical.length) {
        await sender.sendCritical('general', message);
      } else {
        await sender.send('general', message);
      }
      if (!options.silent) console.log('[secrets-monitor] Telegram 알림 발송 완료');
    } catch (err: any) {
      console.warn('[secrets-monitor] Telegram 발송 실패 (무시):', err.message);
    }
  }

  return result;
}
