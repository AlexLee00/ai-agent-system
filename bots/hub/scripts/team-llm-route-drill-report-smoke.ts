#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-llm-route-drill-'));
const outputPath = path.join(tempDir, 'report.json');
const fakeToken = 'hub_report_smoke_secret_token_123456';

try {
  const result = spawnSync(tsxBin, [path.join(__dirname, 'team-llm-route-drill.ts')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HUB_AUTH_TOKEN: fakeToken,
      HUB_TEAM_LLM_DRILL_LIVE: '0',
      HUB_TEAM_LLM_DRILL_WRITE_REPORT: '1',
      HUB_TEAM_LLM_DRILL_OUTPUT: outputPath,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath), 'team LLM drill report was not written');

  const stdout = String(result.stdout || '');
  const reportText = fs.readFileSync(outputPath, 'utf8');
  const report = JSON.parse(reportText);

  assert.equal(report.ok, true);
  assert.equal(report.mode, 'mock');
  assert.equal(report.failed, 0);
  assert.equal(report.output_json, outputPath);
  assert.ok(report.checked >= 1, 'expected at least one team route check');

  const combined = `${stdout}\n${reportText}`;
  assert.equal(combined.includes(fakeToken), false, 'report leaked HUB_AUTH_TOKEN');
  assert.equal(/authorization/i.test(combined), false, 'report leaked auth header naming');
  assert.equal(/access_token|refresh_token|api_key|client_secret/i.test(combined), false, 'report leaked token-like key names');

  console.log(JSON.stringify({
    ok: true,
    checked: report.checked,
    output_json_redacted: true,
  }));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
