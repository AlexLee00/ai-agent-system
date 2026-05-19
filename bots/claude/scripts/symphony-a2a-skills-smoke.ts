#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXPECTED_A2A_SKILLS = [
  'dispatch-ticket',
  'poll-tasks',
  'assign-agent',
  'report-status',
  'sync-github',
  'hermes-learn',
  'self-heal',
  'quality-gate',
];
const EXPECTED_FILESYSTEM_SKILLS = [
  'dexter-skill',
  'doctor-skill',
  'archer-skill',
  'guardian-skill',
  'builder-skill',
  'reviewer-skill',
  'orchestrator-skill',
  'learning-skill',
];

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function outputOf(result) {
  return result && result.output ? result.output : {};
}

async function runSmoke() {
  const skills = await import('../a2a/skills/index.ts');
  const declaredSkillIds = skills.SYMPHONY_A2A_SKILLS.map((skill) => skill.id);
  assert.deepStrictEqual(declaredSkillIds, EXPECTED_A2A_SKILLS);

  const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'bots/claude/a2a/claude-card.json'), 'utf8'));
  const cardSkillIds = new Set((card.skills || []).map((skill) => skill.id));
  for (const skillId of EXPECTED_A2A_SKILLS) assert.ok(cardSkillIds.has(skillId), `card missing ${skillId}`);

  for (const skillId of EXPECTED_FILESYSTEM_SKILLS) {
    const skillPath = path.join(ROOT, 'bots/claude/skills', skillId, 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), `filesystem skill missing: ${skillPath}`);
  }

  const dispatch = outputOf(await skills.runDispatchTicket({
    title: 'Luna crypto Binance universe blocker',
    body: '암호화폐 자동매매 후보 선정 로직을 점검',
  }));
  assert.strictEqual(dispatch.dispatch.targetTeam, 'luna');
  assert.strictEqual(dispatch.safety.mutatesHub, false);

  const poll = outputOf(await skills.runPollTasks({
    offline: true,
    status: 'todo',
    team: 'claude',
    fixtureTaskIds: ['task_fixture_1'],
  }));
  assert.strictEqual(poll.hubReachable, false);
  assert.strictEqual(poll.tasks.length, 1);

  const assignment = outputOf(await skills.runAssignAgent({
    task: {
      id: 'task_fixture_1',
      title: 'Security regression secret leak',
      target_team: 'claude',
      priority: 'high',
    },
    dryRun: true,
  }));
  assert.strictEqual(assignment.dispatch.agent, 'guardian');
  assert.strictEqual(assignment.workspace.mutatesGit, false);
  assert.strictEqual(assignment.patchPayload.workspace_id, undefined);
  assert.strictEqual(
    assignment.patchPayload.metadata.symphonyAssignment.plannedWorkspace.worktreePath,
    assignment.workspace.worktreePath
  );

  const report = outputOf(await skills.runReportStatus({
    taskId: 'task_fixture_1',
    fromStatus: 'todo',
    status: 'in_progress',
    dryRun: true,
  }));
  assert.strictEqual(report.transitionAllowed, true);
  assert.strictEqual(report.safety.mutatesHub, false);

  const github = outputOf(await skills.runSyncGithub({
    action: 'opened',
    issue: {
      number: 42,
      title: 'Fix Luna trading candidate promotion',
      body: 'promotion candidate is not created',
      labels: [{ name: 'team:luna' }],
      html_url: 'https://github.com/example/repo/issues/42',
    },
    repository: { full_name: 'example/repo' },
    dryRun: true,
  }));
  assert.strictEqual(github.dispatch.targetTeam, 'luna');

  const learning = outputOf(await skills.runHermesLearn({
    team: 'claude',
    title: 'repeated blocker pattern',
    evidence: ['반복 blocker', 'verified smoke pass', 'same failure signature'],
  }));
  assert.ok(learning.confidence >= 0.7);
  assert.strictEqual(learning.skillCandidate.targetFilesystemSkill, 'learning-skill');

  const heal = outputOf(await skills.runSelfHeal({
    target: 'claude-a2a',
    severity: 2,
    dryRun: true,
  }));
  assert.strictEqual(heal.level, 2);
  assert.strictEqual(heal.safety.mutatesHub, false);

  const blockedHeal = outputOf(await skills.runSelfHeal({
    target: 'claude-a2a',
    body: 'rollback and protected launchd unload requested',
    execute: true,
    dryRun: false,
  }));
  assert.strictEqual(blockedHeal.level, 3);
  assert.strictEqual(blockedHeal.mode, 'self_heal_blocked');
  assert.strictEqual(blockedHeal.healResult, null);
  assert.strictEqual(blockedHeal.safety.mutatesHub, false);

  const gatePass = outputOf(await skills.runQualityGate({
    reviewer: { pass: true },
    guardian: { pass: true },
    builder: { pass: true },
    tests: { pass: true },
  }));
  assert.strictEqual(gatePass.pass, true);

  const gateBlock = outputOf(await skills.runQualityGate({
    reviewer: { pass: true },
    guardian: { pass: true },
    builder: { pass: true },
    tests: { pass: false },
  }));
  assert.strictEqual(gateBlock.pass, false);
  assert.deepStrictEqual(gateBlock.failed, ['test_runner']);

  return {
    ok: true,
    checked: {
      a2aSkillCount: declaredSkillIds.length,
      cardSkillExposure: true,
      filesystemSkillCount: EXPECTED_FILESYSTEM_SKILLS.length,
      dispatch: true,
      poll: true,
      assignment: true,
      reportStatus: true,
      syncGithub: true,
      hermesLearn: true,
      selfHeal: true,
      qualityGate: true,
    },
  };
}

runSmoke()
  .then((result) => {
    if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
    else console.log('symphony A2A skills smoke passed');
  })
  .catch((error) => {
    console.error(`symphony A2A skills smoke failed: ${error?.message || error}`);
    process.exit(1);
  });
