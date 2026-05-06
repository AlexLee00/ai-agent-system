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
const { getLaunchctlStatus } = require('../../../packages/core/lib/health-provider');
const { isExpectedIdleService, isOptionalService } = require('../../../packages/core/lib/service-ownership');

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const TIMEOUT_MS = 8_000;

interface BotHealth {
  name: string;
  url: string;
  label: string;
}

interface BotLaunchdHealth {
  name: string;
  label: string;
  labels: string[];
}

const BOT_HEALTH_ENDPOINTS: BotHealth[] = [
  { name: 'hub',         url: `${HUB_BASE}/hub/health`,                label: 'Hub' },
  { name: 'alarm',       url: `${HUB_BASE}/hub/alarm/readiness`,        label: 'Alarm' },
];

const BOT_LAUNCHD_HEALTHS: BotLaunchdHealth[] = [
  {
    name: 'luna',
    label: 'Luna',
    labels: [
      'ai.luna.marketdata-mcp',
      'ai.luna.tradingview-ws',
    ],
  },
  {
    name: 'blog',
    label: 'Blog',
    labels: [
      'ai.blog.node-server',
    ],
  },
  {
    name: 'claude',
    label: 'Claude',
    labels: [
      'ai.claude.commander',
      'ai.claude.auto-dev.autonomous',
    ],
  },
  {
    name: 'ska',
    label: 'SKA',
    labels: [
      'ai.ska.commander',
      'ai.ska.naver-monitor',
    ],
  },
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

function checkLaunchdGroup(bot: BotLaunchdHealth): { name: string; label: string; ok: boolean; detail?: string } {
  try {
    const status = getLaunchctlStatus(bot.labels);
    const failingDetails = bot.labels
      .map((label) => {
        const svc = status?.[label];
        if (isExpectedIdleService(label) || isOptionalService(label)) {
          if (!svc || svc.loaded === false) return null;
          if (svc.running === true) return null;
          if (String(svc.state || '').trim() === 'not running') return null;
        }
        if (!svc) return `${label.replace(/^ai\./, '')}: launchctl unknown`;
        if (svc.loaded === false) return `${label.replace(/^ai\./, '')}: launchd unloaded`;
        if (svc.running === true) return null;
        const state = String(svc.state || '').trim();
        if (state && state !== 'not running') {
          return `${label.replace(/^ai\./, '')}: ${state}`;
        }
        if (Number.isFinite(svc.exitCode) && Number(svc.exitCode) !== 0) {
          return `${label.replace(/^ai\./, '')}: exited(${svc.exitCode})`;
        }
        return `${label.replace(/^ai\./, '')}: not running`;
      })
      .filter(Boolean);
    if (failingDetails.length === 0) {
      return { name: bot.name, label: bot.label, ok: true, detail: 'launchd ok' };
    }
    return {
      name: bot.name,
      label: bot.label,
      ok: false,
      detail: failingDetails.join(', '),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: bot.name, label: bot.label, ok: false, detail: `launchctl error: ${msg}` };
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
  const [endpointResults, alarmReadiness] = await Promise.allSettled([
    Promise.all(BOT_HEALTH_ENDPOINTS.map(checkEndpoint)),
    fetchAlarmReadiness(),
  ]);

  const httpResults = endpointResults.status === 'fulfilled' ? endpointResults.value : [];
  const launchdResults = BOT_LAUNCHD_HEALTHS.map(checkLaunchdGroup);
  const results = [...httpResults, ...launchdResults];
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
