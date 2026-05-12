#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildLunaCommunicationInfrastructureReport,
  COMMUNICATION_CHANNEL_CONTRACT,
  REQUIRED_A2A_SKILLS,
} from '../shared/luna-communication-infrastructure.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export function runLunaCommunicationInfraSmoke() {
  const report = buildLunaCommunicationInfrastructureReport();

  assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2));
  assert.equal(report.shadowMode, true);
  assert.equal(report.liveMutation, false);
  assert.equal(report.broadcastDefault, 'off_unless_LUNA_A2A_BROADCAST_ENABLED_true');
  for (const skillId of REQUIRED_A2A_SKILLS) {
    assert.ok(report.requiredSkills.includes(skillId), `required skill missing from report: ${skillId}`);
  }
  for (const channel of COMMUNICATION_CHANNEL_CONTRACT) {
    assert.ok(report.channels.includes(channel), `channel missing from contract: ${channel}`);
  }

  return {
    ok: true,
    smoke: 'luna-communication-infra-phase9',
    status: report.status,
    totalChecks: report.summary.totalChecks,
    a2aSkills: report.summary.a2aSkills,
    channels: report.channels,
    liveMutation: report.liveMutation,
  };
}

async function main() {
  const result = runLunaCommunicationInfraSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna communication infra smoke failed:',
  });
}
