#!/usr/bin/env tsx
import assert from 'node:assert/strict';

function isEnabled(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

async function main() {
  const live = isEnabled(process.env.JAY_TELEGRAM_LIVE_DRY_RUN);
  const originalThreeTier = process.env.JAY_3TIER_TELEGRAM;
  const originalDedupeTtl = process.env.JAY_MEETING_DEDUPE_TTL_MS;
  const sender = require('../../../packages/core/lib/telegram-sender');
  const originalSendBuffered = sender.sendBuffered;
  const captured = [];

  process.env.JAY_3TIER_TELEGRAM = 'true';
  process.env.JAY_MEETING_DEDUPE_TTL_MS = '60000';
  if (!live) {
    sender.sendBuffered = async (team, text) => {
      captured.push({ team, text });
      return true;
    };
  }

  try {
    const { publishMeetingSummary } = require('../../orchestrator/lib/jay-meeting-reporter.ts');
    const incidentKey = `jay:telegram-meeting-dry-run:${Date.now()}`;
    const result = await publishMeetingSummary({
      incidentKey,
      phase: 'review',
      team: 'general',
      title: live ? 'Jay Telegram live dry-run' : 'Jay Telegram captured dry-run',
      summary: '회의형 Telegram 알림 라우팅을 1회 검증합니다. 기본 모드는 실제 전송 없이 캡처만 수행합니다.',
      dedupeKey: `${incidentKey}:review`,
    });
    assert.equal(result?.ok, true, `meeting publish failed: ${result?.error || 'unknown'}`);
    if (!live) {
      assert.equal(captured.length, 1, 'dry-run should capture one meeting message');
      assert.equal(captured[0].team, 'meeting', 'meeting summary should route to meeting topic');
      assert.match(captured[0].text, /Jay 회의/, 'meeting card should use Jay meeting format');
      assert.match(captured[0].text, /팀검토/, 'review phase should be labeled');
    }
    console.log(JSON.stringify({
      ok: true,
      live,
      captured: captured.length,
      sent: Boolean(result?.sent),
      team: 'meeting',
      incidentKey,
    }));
  } finally {
    if (!live) sender.sendBuffered = originalSendBuffered;
    if (originalThreeTier == null) delete process.env.JAY_3TIER_TELEGRAM;
    else process.env.JAY_3TIER_TELEGRAM = originalThreeTier;
    if (originalDedupeTtl == null) delete process.env.JAY_MEETING_DEDUPE_TTL_MS;
    else process.env.JAY_MEETING_DEDUPE_TTL_MS = originalDedupeTtl;
  }
}

main().catch((error) => {
  console.error(`jay_telegram_meeting_dry_run_failed: ${error?.message || error}`);
  process.exit(1);
});
