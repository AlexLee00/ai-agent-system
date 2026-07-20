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
  /Challenge\/Consensus Gate/,
  /Read-only hard test/i,
  /stale-row delta/i,
  /Runtime configuration drift/i,
  /Governed implementation/,
  /T0 Lean/,
  /T1 Governed/,
  /T2 Protected/,
  /one implementation owner/i,
];

const REQUIRED_GOVERNANCE_PATTERNS = [
  /^triggers:/m,
  /## Mode Classification/,
  /T0 Lean/,
  /T1 Governed/,
  /T2 Protected/,
  /## Expert Challenge Contract/,
  /## Required Loop/,
  /\*\*RED\*\*/,
  /\*\*GREEN\*\*/,
  /Read-only hard test/i,
  /stale-row delta/i,
  /Runtime configuration drift/i,
  /Independent review/i,
  /## Stop Conditions/,
];

const REQUIRED_ROOT_POLICY_PATTERNS = [
  /skills\/implementation-governance\/SKILL\.md/,
  /T0 Lean/,
  /T1 Governed/,
  /T2 Protected/,
  /line count/i,
  /one implementation owner/i,
];

const REQUIRED_CLAUDE_POLICY_PATTERNS = [
  /AGENTS\.md/,
  /implementation-governance/,
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
  {
    key: 'governed-implementation',
    planner: 'skills/implementation-governance/SKILL.md',
    generator: 'Codex implementation',
    evaluator: 'scripts/harness-principles-audit.ts',
    evidencePath: 'docs/platform/HARNESS_PRINCIPLES.md',
  },
];

function existsMaybeRepo(filePath) {
  if (!filePath || filePath.startsWith('~') || filePath.includes(' + ')) return true;
  if (!filePath.includes('/') && !filePath.includes('.')) return true;
  return fs.existsSync(path.join(repoRoot, filePath));
}

export function isHarnessAuditConnected(packageJson: any): boolean {
  const scripts = packageJson?.scripts || {};
  const checkCommand = String(scripts.check || '');
  const checkStages = checkCommand
    .split('&&')
    .map((stage) => stage.trim())
    .filter(Boolean);
  return !checkCommand.includes('||')
    && checkStages.includes('npm run -s smoke:harness-principles-audit')
    && String(scripts['smoke:harness-principles-audit'] || '').trim()
      === 'tsx scripts/harness-principles-audit.ts --smoke';
}

export function buildHarnessPrinciplesAudit({ strict = false } = {}) {
  const docPath = path.join(repoRoot, 'docs/platform/HARNESS_PRINCIPLES.md');
  const content = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
  const governancePath = path.join(repoRoot, 'skills/implementation-governance/SKILL.md');
  const governanceContent = fs.existsSync(governancePath) ? fs.readFileSync(governancePath, 'utf8') : '';
  const rootPolicyPath = path.join(repoRoot, 'AGENTS.md');
  const rootPolicyContent = fs.existsSync(rootPolicyPath) ? fs.readFileSync(rootPolicyPath, 'utf8') : '';
  const claudePolicyPath = path.join(repoRoot, 'CLAUDE.md');
  const claudePolicyContent = fs.existsSync(claudePolicyPath) ? fs.readFileSync(claudePolicyPath, 'utf8') : '';
  const packagePath = path.join(repoRoot, 'package.json');
  const packageJson = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, 'utf8')) : {};
  const missingDocPatterns = REQUIRED_DOC_PATTERNS
    .filter((pattern) => !pattern.test(content))
    .map((pattern) => String(pattern));
  const missingGovernancePatterns = REQUIRED_GOVERNANCE_PATTERNS
    .filter((pattern) => !pattern.test(governanceContent))
    .map((pattern) => String(pattern));
  const missingRootPolicyPatterns = REQUIRED_ROOT_POLICY_PATTERNS
    .filter((pattern) => !pattern.test(rootPolicyContent))
    .map((pattern) => String(pattern));
  const missingClaudePolicyPatterns = REQUIRED_CLAUDE_POLICY_PATTERNS
    .filter((pattern) => !pattern.test(claudePolicyContent))
    .map((pattern) => String(pattern));
  const packageCheckConnected = isHarnessAuditConnected(packageJson);
  const pipelineReports = PIPELINES.map((pipeline) => {
    const missing = ['planner', 'generator', 'evaluator']
      .filter((role) => !existsMaybeRepo(pipeline[role]));
    return { ...pipeline, ok: missing.length === 0, missing };
  });
  const ok = missingDocPatterns.length === 0
    && missingGovernancePatterns.length === 0
    && missingRootPolicyPatterns.length === 0
    && missingClaudePolicyPatterns.length === 0
    && packageCheckConnected
    && pipelineReports.every((item) => item.ok);
  return {
    ok: strict ? ok : true,
    pass: ok,
    source: 'harness_principles_audit',
    checkedAt: new Date().toISOString(),
    advisoryOnly: !strict,
    liveMutation: false,
    missingDocPatterns,
    missingGovernancePatterns,
    missingRootPolicyPatterns,
    missingClaudePolicyPatterns,
    packageCheckConnected,
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
    assert.equal(report.pipelines.length, 4);
    assert.deepEqual(report.missingRootPolicyPatterns, []);
    assert.deepEqual(report.missingClaudePolicyPatterns, []);
    assert.equal(report.packageCheckConnected, true);
    assert.equal(isHarnessAuditConnected({
      scripts: {
        check: 'echo smoke:harness-principles-audit',
        'smoke:harness-principles-audit': 'tsx scripts/harness-principles-audit.ts --smoke',
      },
    }), false);
    assert.equal(isHarnessAuditConnected({
      scripts: {
        check: 'npm run -s smoke:harness-principles-audit-disabled',
        'smoke:harness-principles-audit': 'tsx scripts/harness-principles-audit.ts --smoke',
      },
    }), false);
    assert.equal(isHarnessAuditConnected({
      scripts: {
        check: 'npm run -s smoke:harness-principles-audit || true',
        'smoke:harness-principles-audit': 'tsx scripts/harness-principles-audit.ts --smoke',
      },
    }), false);
    assert.equal(isHarnessAuditConnected({
      scripts: {
        check: 'npm run -s smoke:harness-principles-audit && npm run -s typecheck || true',
        'smoke:harness-principles-audit': 'tsx scripts/harness-principles-audit.ts --smoke',
      },
    }), false);
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`[harness-principles-audit] pass=${report.pass} pipelines=${report.pipelines.length}`);
  if (strict && !report.pass) process.exit(1);
}

main();
