#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const reporter = require('../../orchestrator/lib/jay-meeting-reporter.ts');
  const sender = require('../../../packages/core/lib/telegram-sender.ts');
  const originalFlag = process.env.JAY_3TIER_TELEGRAM;
  const originalSendBuffered = sender.sendBuffered;
  process.env.JAY_3TIER_TELEGRAM = 'true';

  const sent = [];
  sender.sendBuffered = async (team, message) => {
    sent.push({ team, message });
    return true;
  };

  try {
    const incidentKey = `routing-smoke:${Date.now()}`;
    const frame = await reporter.publishMeetingSummary({
      incidentKey,
      phase: 'frame',
      team: 'luna',
      title: 'frame check',
      summary: 'frame summary',
    });
    assert.equal(frame?.ok, true);

    const review = await reporter.publishMeetingSummary({
      incidentKey,
      phase: 'review',
      team: 'luna',
      title: 'review check',
      summary: 'review summary',
    });
    assert.equal(review?.ok, true, 'review phase should be sent in meeting summary');

    const final = await reporter.publishMeetingSummary({
      incidentKey,
      phase: 'final',
      team: 'luna',
      title: 'final check',
      summary: 'final summary',
    });
    assert.equal(final?.ok, true);

    const teamProgress = await reporter.publishTeamProgress({
      incidentKey,
      team: 'luna',
      status: 'running',
      message: 'detail progress',
    });
    assert.equal(teamProgress?.ok, true);

    const meetingMessages = sent.filter((row) => row.team === 'meeting');
    const lunaMessages = sent.filter((row) => row.team === 'luna');
    assert.equal(meetingMessages.length, 3, 'meeting should receive frame/review/final');
    assert.equal(lunaMessages.length, 1, 'team topic should receive progress detail');
    console.log('jay_3tier_routing_smoke_ok');
  } finally {
    sender.sendBuffered = originalSendBuffered;
    if (originalFlag == null) delete process.env.JAY_3TIER_TELEGRAM;
    else process.env.JAY_3TIER_TELEGRAM = originalFlag;
  }
}

main().catch((error) => {
  console.error(`jay_3tier_routing_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
