#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const { generateReport } = require('./edux-promotion-gate.ts');
const {
  OUTPUT_DIR,
  PROMOTION_GATE_REPORT,
  ensureDir,
  assertLivePublishAllowed,
} = require('../lib/edux-runtime-support.ts');

async function main() {
  const report = await generateReport({ fixture: true });
  assert.equal(report.allPass, true);
  assert.equal(report.mode, 'fixture');
  assert.equal(report.fixture, true);
  assert.equal(report.checks.length, 7);

  const originalEnv = {
    EDUX_DRY_RUN: process.env.EDUX_DRY_RUN,
    EDUX_LIVE_PUBLISH_APPROVED: process.env.EDUX_LIVE_PUBLISH_APPROVED,
    EDUX_PROMOTION_GATE_PASSED: process.env.EDUX_PROMOTION_GATE_PASSED,
  };
  const originalReport = fs.existsSync(PROMOTION_GATE_REPORT)
    ? fs.readFileSync(PROMOTION_GATE_REPORT, 'utf8')
    : null;

  try {
    ensureDir(OUTPUT_DIR);
    fs.writeFileSync(PROMOTION_GATE_REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.env.EDUX_DRY_RUN = 'false';
    process.env.EDUX_LIVE_PUBLISH_APPROVED = 'true';
    process.env.EDUX_PROMOTION_GATE_PASSED = 'true';
    const liveGate = assertLivePublishAllowed({ tableOk: true });
    assert.equal(liveGate.ok, false);
    assert.ok(liveGate.reasons.includes('promotion gate report is fixture-only'));
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalReport == null) {
      try { fs.unlinkSync(PROMOTION_GATE_REPORT); } catch {}
    } else {
      fs.writeFileSync(PROMOTION_GATE_REPORT, originalReport, 'utf8');
    }
  }

  console.log(JSON.stringify({ ok: true, summary: report.summary }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
