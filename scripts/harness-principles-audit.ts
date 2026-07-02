#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const REQUIRED_DOC_PATTERNS = [
  /Planner \(P\)/,
  /Generator \(G\)/,
  /Evaluator \(E\)/,
  /Semiannual Review Template/,
  /Codex spec loop/,
  /Write report/,
  /Claude refactor-cycle/,
];

const PIPELINES = [
  {
    key: 'codex-spec-loop',
    planner: '~/project-docs/ai-agent-system/codex-specs',
    generator: 'Codex implementation',
    evaluator: 'code-review + verification',
    evidencePath: 'docs/platform/HARNESS_PRINCIPLES.md',
  },
  {
    key: 'write-report',
    planner: 'bots/orchestrator/lib/write/report-aggregator.ts',
    generator: 'bots/orchestrator/src/write.ts',
    evaluator: 'bots/orchestrator/scripts/nonstd-convergence-smoke.ts',
  },
  {
    key: 'claude-refactor-cycle',
    planner: 'bots/claude/scripts/refactor-cycle-runner.ts',
    generator: 'bots/claude/scripts/refactor-cycle-runner.ts',
    evaluator: 'bots/claude/__tests__/refactor-cycle-runner.test.ts',
  },
];

function existsMaybeRepo(filePath) {
  if (!filePath || filePath.startsWith('~') || filePath.includes(' + ')) return true;
  if (!filePath.includes('/') && !filePath.includes('.')) return true;
  return fs.existsSync(path.join(repoRoot, filePath));
}

export function buildHarnessPrinciplesAudit({ strict = false } = {}) {
  const docPath = path.join(repoRoot, 'docs/platform/HARNESS_PRINCIPLES.md');
  const content = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
  const missingDocPatterns = REQUIRED_DOC_PATTERNS
    .filter((pattern) => !pattern.test(content))
    .map((pattern) => String(pattern));
  const pipelineReports = PIPELINES.map((pipeline) => {
    const missing = ['planner', 'generator', 'evaluator']
      .filter((role) => !existsMaybeRepo(pipeline[role]));
    return { ...pipeline, ok: missing.length === 0, missing };
  });
  const ok = missingDocPatterns.length === 0 && pipelineReports.every((item) => item.ok);
  return {
    ok: strict ? ok : true,
    pass: ok,
    source: 'harness_principles_audit',
    checkedAt: new Date().toISOString(),
    advisoryOnly: true,
    liveMutation: false,
    missingDocPatterns,
    pipelines: pipelineReports,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const json = argv.includes('--json') || argv.includes('--smoke');
  const report = buildHarnessPrinciplesAudit({ strict });
  if (argv.includes('--smoke')) {
    assert.equal(report.pass, true);
    assert.equal(report.liveMutation, false);
    assert.equal(report.pipelines.length, 3);
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`[harness-principles-audit] pass=${report.pass} pipelines=${report.pipelines.length}`);
  if (strict && !report.pass) process.exit(1);
}

main();
