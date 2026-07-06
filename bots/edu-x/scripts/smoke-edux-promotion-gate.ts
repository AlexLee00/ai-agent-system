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
    EDUX_REQUIRE_PROMOTION_GATE: process.env.EDUX_REQUIRE_PROMOTION_GATE,
    EDUX_ONE_OFF_LIVE_TEST_APPROVED: process.env.EDUX_ONE_OFF_LIVE_TEST_APPROVED,
  };
  const originalReport = fs.existsSync(PROMOTION_GATE_REPORT)
    ? fs.readFileSync(PROMOTION_GATE_REPORT, 'utf8')
    : null;

  try {
    ensureDir(OUTPUT_DIR);
    fs.writeFileSync(PROMOTION_GATE_REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.env.EDUX_DRY_RUN = 'false';
    process.env.EDUX_LIVE_PUBLISH_APPROVED = 'true';
    process.env.EDUX_PROMOTION_GATE_PASSED = 'false';
    const liveGate = assertLivePublishAllowed({ tableOk: true });
    assert.equal(liveGate.ok, false);
    assert.equal(liveGate.mode, 'promotion_gate');
    assert.equal(liveGate.promotionGateRequired, true);
    assert.ok(liveGate.reasons.includes('EDUX_PROMOTION_GATE_PASSED is not true'));
    process.env.EDUX_REQUIRE_PROMOTION_GATE = 'false';
    const relaxedGate = assertLivePublishAllowed({ tableOk: true });
    assert.equal(relaxedGate.ok, true);
    assert.equal(relaxedGate.mode, 'live_approved');
    assert.equal(relaxedGate.promotionGateRequired, false);
    delete process.env.EDUX_REQUIRE_PROMOTION_GATE;
    process.env.EDUX_PROMOTION_GATE_PASSED = 'true';

    const staleReport = {
      generatedAt: '2026-05-27T06:30:59.654Z',
      mode: 'live-db-readonly',
      fixture: false,
      summary: '5/5 통과',
      allPass: true,
      checks: Array.from({ length: 5 }, () => ({ ok: true })),
    };
    fs.writeFileSync(PROMOTION_GATE_REPORT, `${JSON.stringify(staleReport, null, 2)}\n`, 'utf8');
    const staleGate = assertLivePublishAllowed({ tableOk: true });
    assert.equal(staleGate.ok, false);
    assert.equal(staleGate.mode, 'promotion_gate');
    assert.ok(staleGate.reasons.includes('promotion gate report is stale'));
    assert.ok(staleGate.reasons.includes('promotion gate report has fewer than 7 checks'));
    process.env.EDUX_REQUIRE_PROMOTION_GATE = 'false';
    const relaxedStaleGate = assertLivePublishAllowed({ tableOk: true });
    assert.equal(relaxedStaleGate.ok, true);
    assert.equal(relaxedStaleGate.mode, 'live_approved');
    process.env.EDUX_REQUIRE_PROMOTION_GATE = 'true';
    process.env.EDUX_PROMOTION_GATE_PASSED = 'true';
    const requiredStaleGate = assertLivePublishAllowed({ tableOk: true });
    assert.equal(requiredStaleGate.ok, false);
    assert.equal(requiredStaleGate.mode, 'promotion_gate');
    assert.equal(requiredStaleGate.promotionGateRequired, true);
    assert.ok(requiredStaleGate.reasons.includes('promotion gate report is stale'));
    assert.ok(requiredStaleGate.reasons.includes('promotion gate report has fewer than 7 checks'));
    process.env.EDUX_PROMOTION_GATE_PASSED = 'false';
    const requiredFlagGate = assertLivePublishAllowed({ tableOk: true });
    assert.ok(requiredFlagGate.reasons.includes('EDUX_PROMOTION_GATE_PASSED is not true'));
    process.env.EDUX_ONE_OFF_LIVE_TEST_APPROVED = 'true';
    const staleOneOffGate = assertLivePublishAllowed({ tableOk: true, oneOffLiveTest: true });
    assert.equal(staleOneOffGate.ok, true);
    assert.ok(staleOneOffGate.warnings.includes('promotion gate is not PASS; one-off live test override active'));
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
