#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOCUMENT = 'docs/codex/CODEX_SKILLS_MCP_ANALYSIS_2026-05-12.md';

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function checkFile(id, description, relativePath, required = true) {
  const ok = exists(relativePath);
  return {
    id,
    description,
    ok,
    required,
    evidence: ok ? [relativePath] : [],
    missing: ok ? [] : [relativePath],
  };
}

function checkContains(id, description, relativePath, tokens, required = true) {
  const fileExists = exists(relativePath);
  const content = fileExists ? read(relativePath) : '';
  const missingTokens = tokens.filter((token) => !content.includes(token));
  const ok = fileExists && missingTokens.length === 0;
  return {
    id,
    description,
    ok,
    required,
    evidence: ok ? [`${relativePath} contains ${tokens.join(', ')}`] : [],
    missing: fileExists ? missingTokens.map((token) => `${relativePath} token:${token}`) : [relativePath],
  };
}

function checkAnyContains(id, description, candidates, token, required = true) {
  const evidence = [];
  const inspected = [];

  for (const relativePath of candidates) {
    if (!exists(relativePath)) {
      inspected.push(relativePath);
      continue;
    }
    inspected.push(relativePath);
    if (read(relativePath).includes(token)) evidence.push(`${relativePath} contains ${token}`);
  }

  return {
    id,
    description,
    ok: evidence.length > 0,
    required,
    evidence,
    missing: evidence.length > 0 ? [] : inspected.map((relativePath) => `${relativePath} token:${token}`),
  };
}

function checkSkillBundle(skillName, files) {
  const evidence = [];
  const missing = [];

  for (const fileName of files) {
    const relativePath = `.claude/skills/${skillName}/${fileName}`;
    if (exists(relativePath)) evidence.push(relativePath);
    else missing.push(relativePath);
  }

  return {
    id: `skill:${skillName}`,
    description: `${skillName} skill documentation bundle`,
    ok: missing.length === 0,
    required: true,
    evidence,
    missing,
  };
}

function checkCoreSkill(skillName, exportName) {
  const modulePath = `packages/core/lib/skills/${skillName}.ts`;
  const indexPath = 'packages/core/lib/skills/index.ts';
  const evidence = [];
  const missing = [];

  if (exists(modulePath)) evidence.push(modulePath);
  else missing.push(modulePath);

  if (exists(indexPath) && read(indexPath).includes(exportName)) {
    evidence.push(`${indexPath} exports ${exportName}`);
  } else {
    missing.push(`${indexPath} export:${exportName}`);
  }

  return {
    id: `core-skill:${skillName}`,
    description: `${skillName} core module and index export`,
    ok: missing.length === 0,
    required: true,
    evidence,
    missing,
  };
}

function checkOpsPlaybookCount(minimumCount) {
  const skillsRoot = path.join(ROOT, 'skills');
  const playbooks = fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `skills/${entry.name}/SKILL.md`)
      .filter((relativePath) => exists(relativePath))
      .sort()
    : [];

  return {
    id: 'ops-playbook-count',
    description: `root operational playbooks >= ${minimumCount}`,
    ok: playbooks.length >= minimumCount,
    required: true,
    evidence: playbooks,
    missing: playbooks.length >= minimumCount ? [] : [`skills/*/SKILL.md count ${playbooks.length}/${minimumCount}`],
    meta: { count: playbooks.length, minimumCount },
  };
}

function optionalRoadmapCheck(id, description, candidatePaths) {
  const evidence = candidatePaths.filter((relativePath) => exists(relativePath));
  return {
    id,
    description,
    ok: evidence.length > 0,
    required: false,
    evidence,
    missing: evidence.length > 0 ? [] : candidatePaths,
  };
}

function buildReport() {
  const requiredChecks = [
    checkFile('document:source', 'source analysis document is present', DOCUMENT),
    checkCoreSkill('systematic-debugging', 'systematicDebugging'),
    checkCoreSkill('brainstorming', 'brainstorming'),
    checkCoreSkill('verification', 'verification'),
    checkCoreSkill('mcp-builder', 'mcpBuilder'),
    checkAnyContains(
      'mcp:context7',
      'Context7 MCP is registered in seed or free registry',
      ['bots/orchestrator/scripts/seed-skills-tools.ts', 'packages/core/lib/mcp/free-registry.ts'],
      'context7-mcp',
    ),
    checkAnyContains(
      'mcp:github',
      'GitHub MCP is registered in seed or free registry',
      ['bots/orchestrator/scripts/seed-skills-tools.ts', 'packages/core/lib/mcp/free-registry.ts'],
      'github',
    ),
    checkContains(
      'seed:p1-skills',
      'P1 skills are seed-visible',
      'bots/orchestrator/scripts/seed-skills-tools.ts',
      ['systematic-debugging', 'brainstorming', 'verification', 'mcp-builder'],
    ),
    checkContains(
      'seed:p2-p4-skills',
      'P2/P4 roadmap skills are seed-visible',
      'bots/orchestrator/scripts/seed-skills-tools.ts',
      [
        'subagent-driven-development',
        'using-git-worktrees',
        'playwright-mcp',
        'owasp-security',
        'team-router',
        'shadow-mode-runner',
        'karpathy-self-check',
      ],
    ),
    checkOpsPlaybookCount(5),
  ];

  const localChecks = [
    checkSkillBundle('systematic-debugging', ['AGENTS.md', 'SKILL.md', 'USAGE.md']),
    checkSkillBundle('brainstorming', ['AGENTS.md', 'SKILL.md', 'USAGE.md']),
    checkSkillBundle('verification', ['AGENTS.md', 'SKILL.md', 'USAGE.md']),
    checkSkillBundle('mcp-builder', ['AGENTS.md', 'SKILL.md', 'USAGE.md']),
    checkSkillBundle('context7', ['AGENTS.md', 'USAGE.md']),
    checkSkillBundle('github-mcp', ['AGENTS.md', 'USAGE.md']),
    checkFile('hook:systematic-debugging', 'systematic debugging post-tool hook is present', '.claude/hooks/scripts/posttooluse-systematic-debug.sh', false),
    checkFile('hook:verification', 'verification post-tool hook is present', '.claude/hooks/scripts/posttooluse-verify.sh', false),
  ].map((check) => ({ ...check, required: false, scope: 'local_ignored' }));

  const optionalChecks = [
    optionalRoadmapCheck('p2:subagent-driven-development', 'P2 subagent-driven-development skill', [
      '.claude/skills/subagent-driven-development/SKILL.md',
      'skills/subagent-driven-development/SKILL.md',
    ]),
    optionalRoadmapCheck('p2:git-worktrees', 'P2 git worktrees skill', [
      '.claude/skills/using-git-worktrees/SKILL.md',
      'skills/using-git-worktrees/SKILL.md',
    ]),
    optionalRoadmapCheck('p2:playwright-mcp', 'P2 Playwright MCP registration', [
      '.claude/skills/playwright-mcp/SKILL.md',
      'skills/playwright-mcp/SKILL.md',
    ]),
    optionalRoadmapCheck('p2:owasp-security', 'P2 OWASP security skill', [
      '.claude/skills/owasp-security/SKILL.md',
      'skills/owasp-security/SKILL.md',
    ]),
    optionalRoadmapCheck('p4:team-router', 'P4 Team Jay team-router skill', [
      '.claude/skills/team-router/SKILL.md',
      'skills/team-router/SKILL.md',
    ]),
    optionalRoadmapCheck('p4:shadow-mode-runner', 'P4 Team Jay shadow-mode-runner skill', [
      '.claude/skills/shadow-mode-runner/SKILL.md',
      'skills/shadow-mode-runner/SKILL.md',
    ]),
    optionalRoadmapCheck('p4:karpathy-self-check', 'P4 Team Jay karpathy-self-check skill', [
      '.claude/skills/karpathy-self-check/SKILL.md',
      'skills/karpathy-self-check/SKILL.md',
    ]),
  ];

  const failedRequired = requiredChecks.filter((check) => !check.ok);
  const missingOptional = optionalChecks.filter((check) => !check.ok);
  const warnings = missingOptional.map((check) => ({
    id: check.id,
    message: `${check.description} is not present yet; keep as roadmap unless this capability is now required.`,
    missing: check.missing,
  }));

  const nextRecommendations = missingOptional.slice(0, 5).map((check) => check.description);

  return {
    generatedAt: new Date().toISOString(),
    cwd: ROOT,
    document: DOCUMENT,
    ok: failedRequired.length === 0,
    summary: {
      requiredPassed: requiredChecks.length - failedRequired.length,
      requiredTotal: requiredChecks.length,
      requiredFailed: failedRequired.length,
      optionalMissing: missingOptional.length,
      localPassed: localChecks.filter((check) => check.ok).length,
      localTotal: localChecks.length,
    },
    requiredChecks,
    optionalChecks,
    localChecks,
    warnings,
    nextRecommendations,
  };
}

function printHuman(report) {
  console.log(`Skills/MCP analysis guard: ${report.ok ? 'PASS' : 'FAIL'}`);
  console.log(`Document: ${report.document}`);
  console.log(`Required: ${report.summary.requiredPassed}/${report.summary.requiredTotal}`);
  console.log(`Optional roadmap gaps: ${report.summary.optionalMissing}`);
  console.log(`Local ignored checks: ${report.summary.localPassed}/${report.summary.localTotal}`);

  const failed = report.requiredChecks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.log('\nFailed required checks:');
    for (const check of failed) {
      console.log(`- ${check.id}: ${check.missing.join(', ')}`);
    }
  }

  if (report.nextRecommendations.length > 0) {
    console.log('\nNext recommendations:');
    for (const recommendation of report.nextRecommendations) {
      console.log(`- ${recommendation}`);
    }
  }
}

function main() {
  const json = process.argv.includes('--json');
  const report = buildReport();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  process.exitCode = report.ok ? 0 : 1;
}

main();
