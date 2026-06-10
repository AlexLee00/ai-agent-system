#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const reporter = require('../../orchestrator/lib/jay-meeting-reporter.ts');
  const originalFlag = process.env.JAY_3TIER_TELEGRAM;
  process.env.JAY_3TIER_TELEGRAM = 'true';

  const sent: Array<{ team: string; message: string }> = [];
  reporter._testOnly.setTelegramSenderForTests({
    sendBuffered: async (team: string, message: string) => {
      sent.push({ team, message });
      return true;
    },
  });

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

    const meetingMessages = sent.filter((row: { team: string }) => row.team === 'meeting');
    const lunaMessages = sent.filter((row: { team: string }) => row.team === 'luna');
    assert.equal(meetingMessages.length, 3, 'meeting should receive frame/review/final');
    assert.match(meetingMessages[0].message, /Jay 회의/, 'meeting card should use compact Korean card format');
    assert.match(meetingMessages[1].message, /팀검토/, 'review phase should have readable phase label');
    assert.equal(lunaMessages.length, 1, 'team topic should receive progress detail');

    const sendOnlyMessages: Array<{ team: string; message: string }> = [];
    reporter._testOnly.setTelegramSenderForTests({
      send: async (team: string, message: string) => {
        sendOnlyMessages.push({ team, message });
        return true;
      },
    });

    const sendOnlyIncidentKey = `routing-smoke-send-only:${Date.now()}`;
    const sendOnlyMeeting = await reporter.publishMeetingSummary({
      incidentKey: sendOnlyIncidentKey,
      phase: 'frame',
      team: 'luna',
      title: 'send only fallback check',
      summary: 'sender exposes send only',
      dedupeKey: `${sendOnlyIncidentKey}:frame`,
    });
    assert.equal(sendOnlyMeeting?.ok, true, 'meeting reporter should fall back to sender.send');

    const sendOnlyProgress = await reporter.publishTeamProgress({
      incidentKey: sendOnlyIncidentKey,
      team: 'luna',
      status: 'running',
      message: 'send only progress',
    });
    assert.equal(sendOnlyProgress?.ok, true, 'team progress should fall back to sender.send');
    assert.equal(sendOnlyMessages.length, 2, 'send-only fallback should publish meeting and progress');

    console.log('jay_3tier_routing_smoke_ok');
  } finally {
    reporter._testOnly.setTelegramSenderForTests(null);
    if (originalFlag == null) delete process.env.JAY_3TIER_TELEGRAM;
    else process.env.JAY_3TIER_TELEGRAM = originalFlag;
  }
}

main().catch((error) => {
  console.error(`jay_3tier_routing_smoke_failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
