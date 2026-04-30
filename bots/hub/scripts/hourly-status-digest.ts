#!/usr/bin/env tsx
'use strict';

/**
 * hourly-status-digest.ts — 매시간 시스템 상태 통합 카드
 *
 * 통합 전: hub-readiness, alarm-readiness, telegram-routing-readiness, 각 봇 health (13개 → 1개)
 * launchd ai.hub.hourly-status-digest.plist (매시간 :00 실행)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const TIMEOUT_MS = 8_000;

interface BotHealth {
  name: string;
  url: string;
  label: string;
}

const BOT_HEALTH_ENDPOINTS: BotHealth[] = [
  { name: 'hub',         url: `${HUB_BASE}/hub/health`,                label: 'Hub' },
  { name: 'alarm',       url: `${HUB_BASE}/hub/alarm/readiness`,        label: 'Alarm' },
  { name: 'luna',        url: `http://localhost:7780/health`,           label: 'Luna' },
  { name: 'blog',        url: `http://localhost:7781/health`,           label: 'Blog' },
  { name: 'claude',      url: `http://localhost:7782/health`,           label: 'Claude' },
  { name: 'ska',         url: `http://localhost:7783/health`,           label: 'SKA' },
];

async function checkEndpoint(bot: BotHealth): Promise<{ name: string; label: string; ok: boolean; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(bot.url, {
      headers: bot.url.includes(HUB_BASE) ? { Authorization: `Bearer ${HUB_TOKEN}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { name: bot.name, label: bot.label, ok: false, detail: `HTTP ${resp.status}` };
    const data = await resp.json().catch(() => ({}));
    const detail = data?.status || data?.message || undefined;
    return { name: bot.name, label: bot.label, ok: true, detail };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? (err.name === 'AbortError' ? 'timeout' : err.message) : String(err);
    return { name: bot.name, label: bot.label, ok: false, detail: msg };
  }
}

async function fetchAlarmReadiness(): Promise<{ classTopics: boolean; suppressionRules: boolean } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${HUB_BASE}/hub/alarm/readiness`, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    return {
      classTopics: Boolean(data?.class_topics_enabled),
      suppressionRules: Number(data?.suppression_rule_count || 0) >= 0,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function formatStatusCard(
  results: Array<{ name: string; label: string; ok: boolean; detail?: string }>,
  alarmReadiness: { classTopics: boolean; suppressionRules: boolean } | null,
): string {
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const allOk = failed.length === 0;
  const statusEmoji = allOk ? '🟢' : ok >= total / 2 ? '🟡' : '🔴';

  const lines: string[] = [
    `${statusEmoji} [Hub] 시스템 상태 (${kst.datetimeStr()} KST)`,
    `가동: ${ok}/${total}`,
  ];

  if (alarmReadiness) {
    const classOk = alarmReadiness.classTopics ? '✅' : '⚠️';
    lines.push(`알람 라우팅: ${classOk} 토픽 분류`);
  }

  if (failed.length > 0) {
    lines.push('');
    lines.push('⚠️ 이상 감지:');
    for (const f of failed) {
      lines.push(`  - ${f.label}: ${f.detail || '응답 없음'}`);
    }
  }

  return lines.join('\n');
}

async function main() {
  const [healthResults, alarmReadiness] = await Promise.allSettled([
    Promise.all(BOT_HEALTH_ENDPOINTS.map(checkEndpoint)),
    fetchAlarmReadiness(),
  ]);

  const results = healthResults.status === 'fulfilled' ? healthResults.value : [];
  const readiness = alarmReadiness.status === 'fulfilled' ? alarmReadiness.value : null;

  const failed = results.filter((r) => !r.ok);
  const message = formatStatusCard(results, readiness);

  console.log('[hourly-status-digest]', message);

  const severity = failed.length === 0 ? 'info' : failed.length >= 3 ? 'error' : 'warn';
  const alarmType = failed.length === 0 ? 'report' : 'error';
  const visibility = failed.length === 0 ? 'digest' : 'notify';

  const sent = await postAlarm({
    team: 'hub',
    fromBot: 'hourly-status-digest',
    alertLevel: severity === 'error' ? 3 : severity === 'warn' ? 2 : 1,
    alarmType,
    visibility,
    title: `시스템 상태: ${results.filter((r) => r.ok).length}/${results.length} 정상`,
    message,
    eventType: 'hourly_status_digest',
    incidentKey: `hub:hourly_status:${kst.today()}:${new Date().getHours().toString().padStart(2, '0')}`,
    payload: {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: failed.map((f) => f.name),
      event_type: 'hourly_status_digest',
    },
  });

  if (!sent?.ok) {
    console.error('[hourly-status-digest] 알람 발송 실패:', sent?.error);
    process.exit(1);
  }
  console.log('[hourly-status-digest] 완료');
}

main().catch((err: Error) => {
  console.error('[hourly-status-digest] 실패:', err.message);
  process.exit(1);
});
