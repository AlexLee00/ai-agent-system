#!/usr/bin/env node
// @ts-nocheck
// Persistent integration only: never include this confirmation-gated rollback test in the canonical smoke catalog.

import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runMeetingSession } from '../services/meeting-room/server/orchestrator/meeting-session.ts';
import { applyMeetingDecisionAction } from '../services/meeting-room/server/meeting-decision-actions.ts';
import {
  regenerateMeetingMinutesMarkdown,
  renderMeetingMinutesMarkdown,
} from '../services/meeting-room/server/minutes.ts';
import { summarizeMeetingRoomResult } from './runtime-luna-meeting-room.ts';
import { fixturePlanNote } from './luna-meeting-room-smoke.ts';

export const LUNA_MEETING_ROOM_PERSISTENCE_CONFIRM = 'LUNA_MEETING_ROOM_PERSISTENCE_INTEGRATION';
const ROLLBACK_SENTINEL = 'luna_meeting_room_persistence_integration_rollback';
const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(INVESTMENT_ROOT, 'migrations', '20260611000004_luna_meeting_room.sql');

function splitSqlStatements(sql: string) {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);
}

async function loadMeetingRoomMigration(runFn: any) {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  for (const statement of splitSqlStatements(sql)) await runFn(statement);
}

async function countMeetingRows(queryFn: any, startedAt: string) {
  const sessions = await queryFn(
    `SELECT COUNT(*)::int AS count FROM luna_meeting_sessions WHERE started_at = $1`,
    [startedAt],
  );
  const minutes = await queryFn(
    `SELECT COUNT(*)::int AS count
       FROM luna_meeting_minutes m
       JOIN luna_meeting_sessions s ON s.id = m.session_id
      WHERE s.started_at = $1`,
    [startedAt],
  );
  const decisions = await queryFn(
    `SELECT COUNT(*)::int AS count
       FROM luna_meeting_decisions d
       JOIN luna_meeting_sessions s ON s.id = d.session_id
      WHERE s.started_at = $1`,
    [startedAt],
  );
  return {
    sessions: Number(sessions?.[0]?.count || 0),
    minutes: Number(minutes?.[0]?.count || 0),
    decisions: Number(decisions?.[0]?.count || 0),
  };
}

function kstDateKey(value: any) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function runLunaMeetingRoomPersistenceIntegration(options: any = {}) {
  if (options.confirm !== LUNA_MEETING_ROOM_PERSISTENCE_CONFIRM) {
    throw new Error(`confirmation_required:${LUNA_MEETING_ROOM_PERSISTENCE_CONFIRM}`);
  }
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-meeting-room-persistence-'));
  const fixtureStartedAt = new Date().toISOString();
  let before;
  let appliedRows;
  try {
    try {
      await db.withTransaction(async (tx: any) => {
        await loadMeetingRoomMigration(tx.run);
        before = await countMeetingRows(tx.query, fixtureStartedAt);
        await runMeetingSession({
          type: 'morning',
          now: fixtureStartedAt,
          dryRun: true,
          noLlm: true,
          planNote: fixturePlanNote(),
          outputPath: path.join(outputDir, 'dry-run.md'),
        }, { queryFn: tx.query, runFn: tx.run });
        assert.deepEqual(await countMeetingRows(tx.query, fixtureStartedAt), before);

        let sentTelegramInput: any = null;
        const applied = await runMeetingSession({
          type: 'morning',
          now: fixtureStartedAt,
          dryRun: false,
          apply: true,
          noLlm: true,
          planNote: fixturePlanNote(),
          outputPath: path.join(outputDir, 'apply.md'),
        }, {
          queryFn: tx.query,
          runFn: tx.run,
          postAlarm: async (input: any) => {
            sentTelegramInput = input;
            return { ok: true, fixture: true };
          },
        });
        appliedRows = await countMeetingRows(tx.query, fixtureStartedAt);
        assert.equal(Number(applied.session.id) > 0, true);
        assert.equal(applied.telegram.attempted, true);
        assert.equal(applied.telegram.ok, true);
        const appliedSummary = summarizeMeetingRoomResult(applied);
        assert.match(appliedSummary, /- telegram: attempted=true ok=true sent=1 pending=\d+/);
        assert.equal(appliedSummary.includes('pending_master'), false);
        assert.ok(sentTelegramInput);
        assert.ok(sentTelegramInput.message.includes('Luna 회의 완료: 아침 통합 회의'));
        assert.ok(sentTelegramInput.message.includes('마스터 액션 대기:'));
        assert.ok(sentTelegramInput.message.includes('회의 #'));
        assert.ok(sentTelegramInput.message.includes('회의록'));
        assert.equal(sentTelegramInput.message.includes('pending_master'), false);
        assert.equal(sentTelegramInput.message.includes('session='), false);
        assert.equal(sentTelegramInput.message.includes('minutes='), false);
        assert.equal(sentTelegramInput.message.includes('morning'), false);
        assert.ok(Array.isArray(sentTelegramInput.inlineKeyboard));
        assert.equal(appliedRows.sessions, before.sessions + 1);
        assert.ok(appliedRows.minutes > before.minutes);
        assert.ok(appliedRows.decisions > before.decisions);

        const decisionId = applied.decisions[0].id;
        const confirmed = await applyMeetingDecisionAction({
          id: decisionId,
          action: 'confirm',
          note: 'telegram fixture',
          changedVia: 'telegram',
          actor: { actorId: '123', actorUsername: 'master' },
          callback: { data: `luna_meeting:${decisionId}:confirm` },
        }, { withTransactionFn: async (fn: any) => fn(tx) });
        assert.equal(confirmed.ok, true);
        assert.equal(confirmed.logicalStatus, 'confirmed');
        const idempotent = await applyMeetingDecisionAction({
          id: decisionId,
          action: 'confirm',
          changedVia: 'telegram',
        }, { withTransactionFn: async (fn: any) => fn(tx) });
        assert.equal(idempotent.idempotent, true);
        const auditRows = await tx.query(
          `SELECT content, meta FROM luna_meeting_minutes WHERE meta->>'changed_via' = 'telegram' AND content LIKE '%telegram fixture%'`,
        );
        assert.equal(auditRows.length >= 1, true);
        assert.ok(auditRows.some((row: any) => String(row.content).includes('결정 확정 처리 · 경로=텔레그램 · 메모=telegram fixture')));
        assert.equal(auditRows.some((row: any) => String(row.content).includes('meeting decision')), false);

        const regenerated = await regenerateMeetingMinutesMarkdown(applied.session.id, {
          queryFn: tx.query,
          outputDir,
        });
        const dbMinuteRows = await tx.query(
          `SELECT COUNT(*)::int AS count FROM luna_meeting_minutes WHERE session_id = $1`,
          [applied.session.id],
        );
        assert.equal(regenerated.ok, true);
        assert.equal(regenerated.minutes.length, Number(dbMinuteRows?.[0]?.count || 0));
        assert.equal(path.basename(regenerated.markdownPath), `${kstDateKey(applied.startedAt)}-morning.md`);
        assert.ok(regenerated.markdown.startsWith('# Luna Meeting Room — 아침 통합 회의'));
        assert.equal(regenerated.markdown.includes('# Luna Meeting Room — morning'), false);
        assert.ok(regenerated.markdown.includes('- 상태: 완료'));
        assert.ok(regenerated.markdown.includes('- 드라이런: 아니오'));
        assert.equal(regenerated.markdown.includes('- status:'), false);
        assert.equal(regenerated.markdown.includes('- dry_run:'), false);
        assert.equal(regenerated.markdown.includes('MR-A output is advisory/shadow only'), false);
        assert.ok(regenerated.markdown.includes(`회의 #${applied.session.id}`));
        assert.equal(regenerated.markdown.includes(`session #${applied.session.id}`), false);
        assert.ok(regenerated.markdown.includes('요약: 아침 통합 회의 완료:'));
        assert.equal(regenerated.markdown.includes('summary: 아침 통합 회의 완료:'), false);
        assert.ok(regenerated.markdown.includes('## 회의 데이터 요약'));
        assert.ok(regenerated.markdown.includes('## 회의록'));
        assert.ok(regenerated.markdown.includes('## 결정 기록(ADR)'));
        assert.equal(regenerated.markdown.includes('## Plan Note'), false);
        assert.equal(regenerated.markdown.includes('## Minutes'), false);
        assert.equal(regenerated.markdown.includes('## ADR'), false);

        const emptyMarkdown = renderMeetingMinutesMarkdown({
          session: { id: 999, type: 'morning', status: 'closed' },
          minutes: [],
          decisions: [],
          dryRun: true,
        });
        assert.ok(emptyMarkdown.includes('회의 데이터 요약 없음'));
        assert.ok(emptyMarkdown.includes('- 회의록 없음'));
        assert.equal(emptyMarkdown.includes('plan-note 없음'), false);
        const partialMarkdown = renderMeetingMinutesMarkdown({
          session: { id: 1000, type: 'morning', status: 'closed' },
          planNote: { briefMarkdown: '요약' },
          minutes: [{ content: '' }],
          decisions: [{}],
          dryRun: false,
        });
        assert.ok(partialMarkdown.includes('### 회의록. 안건 — 기록 / 시스템'));
        assert.ok(partialMarkdown.includes('내용 없음'));
        assert.ok(partialMarkdown.includes('결정 내용 없음 (기한: 기한 미정)'));
        assert.equal(partialMarkdown.includes('undefined'), false);
        assert.equal(partialMarkdown.includes('n/a'), false);
        assert.equal(partialMarkdown.includes('due:'), false);
        throw new Error(ROLLBACK_SENTINEL);
      });
    } catch (error) {
      if (error?.message !== ROLLBACK_SENTINEL) throw error;
    }
    const afterRollback = await countMeetingRows(db.query, fixtureStartedAt);
    assert.deepEqual(afterRollback, before);
    return { ok: true, integration: 'luna-meeting-room-persistence', before, appliedRows, afterRollback, rolledBack: true };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: () => runLunaMeetingRoomPersistenceIntegration({ confirm: argValue('confirm') }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-meeting-room-persistence-integration failed:',
  });
}
