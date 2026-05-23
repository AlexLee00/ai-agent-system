#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const LOCAL_DOCUMENTS = [
  'docs/codex/CODEX_STAGE1_P1_REFINED_SKILLS_REVIEW.md',
  'docs/codex/CODEX_STAGE1_P1_SKILLS_MCP_2026-05-12.md',
  'docs/codex/CODEX_STAGE1_P1_USAGE_AGENTS_MAPPING.md',
  'docs/codex/CODEX_TEAM_AUTONOMY_GAP_ANALYSIS_2026-05-13.md',
  'docs/codex/CODEX_TEAM_JAY_FULL_AUDIT_2026-05-12.md',
];

const TRACKED_DOCUMENT_CANDIDATES = [
  'docs/design/DESIGN_SKILLS_MCP.md',
];

const TEAMS = [
  {
    id: 'blog',
    name: 'Blog',
    card: 'bots/blog/a2a/blog-card.json',
    server: 'bots/blog/a2a/server.ts',
    skillsDir: 'bots/blog/a2a/skills',
    launchdDir: 'bots/blog/launchd',
    hooksDir: 'bots/blog/hooks',
    healthCandidates: ['bots/blog/scripts/health-check.ts', 'bots/blog/scripts/health-report.ts'],
  },
  {
    id: 'claude',
    name: 'Claude',
    card: 'bots/claude/a2a/claude-card.json',
    server: 'bots/claude/a2a/server.ts',
    skillsDir: 'bots/claude/a2a/skills',
    launchdDir: 'bots/claude/launchd',
    healthCandidates: ['bots/claude/a2a/skills/health-check.ts', 'bots/claude/scripts/health-check.ts'],
  },
  {
    id: 'darwin',
    name: 'Darwin',
    card: 'bots/darwin/a2a/darwin-card.json',
    server: 'bots/darwin/a2a/server.ts',
    skillsDir: 'bots/darwin/a2a/skills',
    launchdDir: 'bots/darwin/launchd',
    hooksDir: 'bots/darwin/hooks',
    healthCandidates: ['bots/darwin/scripts/darwin-weekly-ops-report.ts', 'bots/darwin/elixir/lib/darwin/v2/cycle/learn.ex'],
  },
  {
    id: 'luna',
    name: 'Luna',
    card: 'bots/investment/a2a/luna-card.json',
    server: 'bots/investment/a2a/server.ts',
    skillsDir: 'bots/investment/a2a/skills',
    launchdDir: 'bots/investment/launchd',
    healthCandidates: ['bots/investment/scripts/health-check.ts', 'bots/investment/scripts/health-report.ts'],
  },
  {
    id: 'sigma',
    name: 'Sigma',
    card: 'bots/sigma/a2a/sigma-card.json',
    server: 'bots/sigma/a2a/server.ts',
    skillsDir: 'bots/sigma/a2a/skills',
    launchdDir: 'bots/sigma/launchd',
    hooksDir: 'bots/sigma/hooks',
    healthCandidates: ['bots/sigma/a2a/skills/team-audit.ts', 'bots/sigma/scripts/runtime-sigma-7day-completion-report.ts'],
  },
  {
    id: 'ska',
    name: 'SKA',
    card: 'bots/ska/a2a/ska-card.json',
    server: 'bots/ska/a2a/server.ts',
    skillsDir: 'bots/ska/a2a/skills',
    launchdDir: 'bots/reservation/launchd',
    healthCandidates: ['bots/ska/a2a/skills/kiosk-health.ts', 'bots/reservation/scripts/health-check.ts'],
  },
];

function absolute(relativePath) {
  return path.join(ROOT, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(absolute(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(absolute(relativePath), 'utf8');
}

function listFiles(relativePath, predicate = () => true) {
  const dir = absolute(relativePath);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${relativePath}/${entry.name}`)
    .filter(predicate)
    .sort();
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

function checkAbsent(id, description, relativePath) {
  const ok = !exists(relativePath);
  return {
    id,
    description,
    ok,
    required: true,
    evidence: ok ? [`${relativePath} absent`] : [],
    missing: ok ? [] : [`${relativePath} should remain absent`],
  };
}

function checkAnyFile(id, description, candidatePaths, required = true) {
  const evidence = candidatePaths.filter((relativePath) => exists(relativePath));
  return {
    id,
    description,
    ok: evidence.length > 0,
    required,
    evidence,
    missing: evidence.length > 0 ? [] : candidatePaths,
  };
}

function checkFileCount(id, description, relativePath, minimumCount, predicate = () => true) {
  const files = listFiles(relativePath, predicate);
  return {
    id,
    description,
    ok: files.length >= minimumCount,
    required: true,
    evidence: files,
    missing: files.length >= minimumCount ? [] : [`${relativePath} count ${files.length}/${minimumCount}`],
    meta: { count: files.length, minimumCount },
  };
}

function checkJsonCard(team) {
  if (!exists(team.card)) {
    return {
      id: `team:${team.id}:a2a-card`,
      description: `${team.name} A2A card is present and parseable`,
      ok: false,
      required: true,
      evidence: [],
      missing: [team.card],
    };
  }

  try {
    const card = JSON.parse(readText(team.card));
    const missing = [];
    if (!card.name) missing.push('name');
    if (!card.version) missing.push('version');
    if (!Array.isArray(card.skills) || card.skills.length === 0) missing.push('skills[]');

    return {
      id: `team:${team.id}:a2a-card`,
      description: `${team.name} A2A card has name, version, and skills`,
      ok: missing.length === 0,
      required: true,
      evidence: missing.length === 0 ? [`${team.card} skills:${card.skills.length}`] : [team.card],
      missing: missing.map((field) => `${team.card} field:${field}`),
      meta: { skills: Array.isArray(card.skills) ? card.skills.length : 0 },
    };
  } catch (error) {
    return {
      id: `team:${team.id}:a2a-card`,
      description: `${team.name} A2A card is valid JSON`,
      ok: false,
      required: true,
      evidence: [team.card],
      missing: [`${team.card} parse error: ${error.message}`],
    };
  }
}

function checkTeam(team) {
  const checks = [
    checkJsonCard(team),
    checkFile(`team:${team.id}:a2a-server`, `${team.name} A2A server is present`, team.server),
    checkFileCount(
      `team:${team.id}:a2a-skills`,
      `${team.name} A2A skills are present`,
      team.skillsDir,
      1,
      (relativePath) => relativePath.endsWith('.ts'),
    ),
    checkFileCount(
      `team:${team.id}:launchd`,
      `${team.name} launchd automation exists`,
      team.launchdDir,
      1,
      (relativePath) => relativePath.endsWith('.plist'),
    ),
    checkAnyFile(`team:${team.id}:health`, `${team.name} health/report evidence exists`, team.healthCandidates),
  ];

  if (team.hooksDir) {
    checks.push(
      checkAnyFile(
        `team:${team.id}:hooks`,
        `${team.name} hooks baseline exists`,
        [`${team.hooksDir}/README.md`, ...listFiles(team.hooksDir, (relativePath) => relativePath.endsWith('.sh'))],
      ),
    );
  }

  return checks;
}

function checkContainsAny(id, description, candidatePaths, tokens, required = true) {
  const evidence = [];
  const inspected = [];

  for (const relativePath of candidatePaths) {
    if (!exists(relativePath)) {
      inspected.push(relativePath);
      continue;
    }
    const content = readText(relativePath);
    inspected.push(relativePath);
    if (tokens.every((token) => content.includes(token))) {
      evidence.push(`${relativePath} contains ${tokens.join(', ')}`);
    }
  }

  return {
    id,
    description,
    ok: evidence.length > 0,
    required,
    evidence,
    missing: evidence.length > 0 ? [] : inspected.map((relativePath) => `${relativePath} tokens:${tokens.join(',')}`),
  };
}

function buildReport() {
  const requiredChecks = [
    checkAnyFile(
      'document:source-evidence',
      'local Codex analysis docs or tracked Skills/MCP design evidence exists',
      [...LOCAL_DOCUMENTS, ...TRACKED_DOCUMENT_CANDIDATES],
    ),
    checkFile('stage1:p1-skills-guard', 'Stage1 P1 Skills/MCP guard is present', 'scripts/check-skills-mcp-analysis.js'),
    checkFile('template:retained', 'Team Jay template is retained', 'bots/_template/package.json'),
    checkAbsent('retired:academic', 'retired top-level academic bot directory is absent', 'bots/academic'),
    checkAbsent('retired:business', 'retired top-level business bot directory is absent', 'bots/business'),
    checkAbsent('retired:data', 'retired top-level data bot directory is absent', 'bots/data'),
    checkAbsent('retired:secretary', 'retired top-level secretary bot directory is absent', 'bots/secretary'),
    ...TEAMS.flatMap(checkTeam),
    checkFile('guard:billing-core', 'Shared BillingGuard exists', 'packages/core/lib/billing-guard.ts'),
    checkFile('guard:ska-promotion', 'SKA promotion gate exists', 'bots/ska/a2a/skills/promotion-gate.ts'),
    checkFile('guard:claude-learning', 'Claude learning skill exists', 'bots/claude/a2a/skills/hermes-learn.ts'),
    checkFile('guard:claude-self-heal', 'Claude self-healing skill exists', 'bots/claude/a2a/skills/self-heal.ts'),
    checkAnyFile('guard:ska-self-heal', 'SKA recovery/self-healing evidence exists', [
      'bots/reservation/lib/naver-pickko-recovery-service.ts',
      'bots/reservation/lib/naver-detached-recovery-service.ts',
      'bots/reservation/scripts/ska-self-healing-autodev-smoke.ts',
    ]),
    checkFile('hub:resource-api', 'Hub resource API protected runtime is retained', 'bots/hub/launchd/ai.hub.resource-api.plist'),
    checkContainsAny(
      'mapping:skills-seed',
      'Skills/MCP seed mapping includes P1 skills',
      ['bots/orchestrator/scripts/seed-skills-tools.ts'],
      ['systematic-debugging', 'brainstorming', 'verification', 'mcp-builder'],
    ),
  ];

  const advisoryChecks = [
    ...LOCAL_DOCUMENTS.map((document) => checkFile(
      `local-document:${path.basename(document)}`,
      'local ignored Codex analysis document is present',
      document,
      false,
    )),
    checkAnyFile('advisory:hub-mcp-shadow', 'Hub MCP migration shadow artifacts exist before REST replacement', [
      'bots/hub/scripts/agent-hub-transition-audit.ts',
      'bots/hub/scripts/active-runtime-legacy-gateway-isolation-smoke.ts',
      'bots/hub/scripts/legacy-gateway-independence-smoke.ts',
    ], false),
    checkAnyFile('advisory:team-llm-route-drill', 'Team LLM route drill/report evidence exists', [
      'bots/hub/scripts/team-llm-route-drill-report-smoke.ts',
      'bots/investment/scripts/luna-llm-route-health-smoke.ts',
      'bots/claude/a2a/skills/billing-check.ts',
    ], false),
  ];

  const failedRequired = requiredChecks.filter((check) => !check.ok);
  const warningChecks = advisoryChecks.filter((check) => !check.ok);

  return {
    generatedAt: new Date().toISOString(),
    cwd: ROOT,
    localDocuments: LOCAL_DOCUMENTS,
    trackedDocumentCandidates: TRACKED_DOCUMENT_CANDIDATES,
    ok: failedRequired.length === 0,
    summary: {
      requiredPassed: requiredChecks.length - failedRequired.length,
      requiredTotal: requiredChecks.length,
      requiredFailed: failedRequired.length,
      advisoryWarnings: warningChecks.length,
      teamCount: TEAMS.length,
    },
    requiredChecks,
    advisoryChecks,
    warnings: warningChecks.map((check) => ({
      id: check.id,
      message: `${check.description} is not present yet; keep as roadmap unless now required.`,
      missing: check.missing,
    })),
    nextRecommendations: failedRequired.length > 0
      ? failedRequired.slice(0, 5).map((check) => check.description)
      : warningChecks.slice(0, 5).map((check) => check.description),
  };
}

function printHuman(report) {
  console.log(`Team autonomy gap guard: ${report.ok ? 'PASS' : 'FAIL'}`);
  console.log(`Local ignored documents: ${report.localDocuments.length}`);
  console.log(`Required: ${report.summary.requiredPassed}/${report.summary.requiredTotal}`);
  console.log(`Advisory warnings: ${report.summary.advisoryWarnings}`);
  console.log(`Teams checked: ${report.summary.teamCount}`);

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
