#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SPEC_ID = 'SPEC_PLATFORM_ORCH_HUB_CONVERGENCE_2026-07-02';
const DEFAULT_SCOPES = ['bots/orchestrator', 'bots/hub', 'packages/core', 'scripts/reviews'];
const TEXT_FILE_PATTERN = /\.(?:ts|tsx|js|mjs|cjs|json|md|sql|sh)$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'output', 'coverage', '.next', 'tmp', 'logs']);

const AREAS = [
  {
    id: 'agent_registry',
    title: 'Agent Registry Lookup',
    patterns: [
      /\bagent\.registry\b/,
      /\bregisterAgent\b/,
      /\bupdateStatus\b/,
      /\blistByTeam\b/,
      /\bseed-agent-registry\b/,
      /\bphase-b-registry\b/,
    ],
    candidateMove: 'Hub를 agent registry 조회 source of truth로 두고, Orchestrator는 env-gated dual-read shadow에서 diff 0을 확인한 뒤 전환한다.',
    nextGate: 'CONV-S2: ORCH_REGISTRY_VIA_HUB=false 기본값 유지, shadow diff 24h 수집.',
  },
  {
    id: 'llm_policy',
    title: 'LLM Policy Decision',
    patterns: [
      /\bselectLLMChain\b/,
      /\bcallHubLlm\b/,
      /\bjay-model-policy\b/,
      /\bllm-model-selector\b/,
      /\bllm_routing_log\b/,
      /\bhub selector\b/i,
    ],
    candidateMove: 'Hub selector와 core llm-model-selector를 정책 기준으로 유지하고, Orchestrator jay-model-policy는 env-gated shadow 비교 후 Hub 조회로 수렴한다.',
    nextGate: 'CONV-S3: policy equality smoke와 gateway primary check 갱신.',
  },
  {
    id: 'health_ops',
    title: 'Health And Ops Collection',
    patterns: [
      /\/hub\/health/,
      /\/hub\/metrics/,
      /\/ops-health/,
      /\bhealth-report\b/,
      /\bdaily-ops-report\b/,
      /\bhourly-status-digest\b/,
    ],
    candidateMove: 'Hub의 live/metrics endpoint와 Orchestrator ops-health 집계를 분리해 역할을 명시하고, 중복 수집은 read-only proxy 또는 report adapter로 통합한다.',
    nextGate: 'CONV-S1 review: 이관 대상과 유지 대상 분류 후 Step별 owner 확정.',
  },
];

function parseArgs(argv) {
  const args = {
    json: false,
    smoke: false,
    noWrite: false,
    out: '',
    scopes: DEFAULT_SCOPES.slice(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--smoke') args.smoke = true;
    else if (arg === '--no-write') args.noWrite = true;
    else if (arg === '--out') args.out = argv[++index] || '';
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--scope') args.scopes = (argv[++index] || '').split(',').filter(Boolean);
    else if (arg.startsWith('--scope=')) args.scopes = arg.slice('--scope='.length).split(',').filter(Boolean);
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function normalizePath(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

function listFiles(root, scopes) {
  const files = [];

  function walk(absPath) {
    if (!fs.existsSync(absPath)) return;
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      const base = path.basename(absPath);
      if (shouldSkipDir(base)) return;
      for (const entry of fs.readdirSync(absPath).sort()) walk(path.join(absPath, entry));
      return;
    }
    if (!stat.isFile() || !TEXT_FILE_PATTERN.test(absPath)) return;
    if (stat.size > 512 * 1024) return;
    files.push(absPath);
  }

  for (const scope of scopes) walk(path.join(root, scope));
  return files.sort();
}

function ownerForFile(relPath) {
  if (relPath.startsWith('bots/hub/')) return 'hub';
  if (relPath.startsWith('bots/orchestrator/')) return 'orchestrator';
  if (relPath.startsWith('packages/core/')) return 'core';
  if (relPath.startsWith('scripts/reviews/')) return 'ops-review';
  return relPath.split('/')[0] || 'unknown';
}

function excerpt(line) {
  return line.trim().replace(/\s+/g, ' ').slice(0, 180);
}

function scanArea(files, repoRoot, area) {
  const byFile = new Map();
  let totalHits = 0;

  for (const absFile of files) {
    const relFile = normalizePath(absFile, repoRoot);
    const lines = fs.readFileSync(absFile, 'utf8').split(/\r?\n/);
    const hits = [];

    lines.forEach((line, index) => {
      const matched = area.patterns.filter((pattern) => pattern.test(line));
      if (matched.length === 0) return;
      totalHits += matched.length;
      hits.push({
        line: index + 1,
        markers: matched.map((pattern) => pattern.source),
        excerpt: excerpt(line),
      });
    });

    if (hits.length > 0) {
      byFile.set(relFile, {
        file: relFile,
        owner: ownerForFile(relFile),
        hitCount: hits.length,
        samples: hits.slice(0, 3),
      });
    }
  }

  const filesWithHits = Array.from(byFile.values()).sort((left, right) => left.file.localeCompare(right.file));
  const owners = Array.from(new Set(filesWithHits.map((item) => item.owner))).sort();
  return {
    id: area.id,
    title: area.title,
    ownerCount: owners.length,
    owners,
    totalHits,
    fileCount: filesWithHits.length,
    files: filesWithHits.slice(0, 20),
    truncatedFiles: Math.max(0, filesWithHits.length - 20),
    candidateMove: area.candidateMove,
    nextGate: area.nextGate,
  };
}

function buildCandidateMoves(overlaps) {
  return overlaps.map((overlap) => ({
    area: overlap.id,
    action: overlap.candidateMove,
    gate: overlap.nextGate,
    risk: overlap.ownerCount >= 2 ? 'dual_owner_overlap' : 'single_owner_reference',
    readyForImplementation: overlap.id === 'agent_registry' ? false : 'after_mapping_review',
  }));
}

function platformCardsExist(repoRoot) {
  return [
    'bots/hub/a2a/hub-card.json',
    'bots/orchestrator/a2a/orchestrator-card.json',
  ].every((relPath) => fs.existsSync(path.join(repoRoot, relPath)));
}

function buildBlockers(overlaps, repoRoot) {
  const blockers = [];
  const registry = overlaps.find((item) => item.id === 'agent_registry');
  const llm = overlaps.find((item) => item.id === 'llm_policy');

  if (!registry || registry.fileCount === 0) blockers.push('agent_registry_overlap_not_detected');
  if (!llm || llm.fileCount === 0) blockers.push('llm_policy_overlap_not_detected');
  blockers.push('no_dual_read_shadow_evidence_yet');
  if (!platformCardsExist(repoRoot)) blockers.push('no_agent_card_pair_yet');
  return blockers;
}

export function buildPlatformConvergenceMap(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const scopes = options.scopes || DEFAULT_SCOPES;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const files = listFiles(repoRoot, scopes);
  const overlaps = AREAS.map((area) => scanArea(files, repoRoot, area));
  const candidateMoves = buildCandidateMoves(overlaps);
  const blockers = buildBlockers(overlaps, repoRoot);

  return {
    ok: blockers.filter((blocker) => blocker.endsWith('_not_detected')).length === 0,
    spec: SPEC_ID,
    generatedAt,
    mode: 'read_only_static_analysis',
    readOnly: true,
    liveMutation: false,
    sourceScopes: scopes,
    summary: {
      filesScanned: files.length,
      overlapAreas: overlaps.length,
      overlapFiles: overlaps.reduce((total, overlap) => total + overlap.fileCount, 0),
      multiOwnerAreas: overlaps.filter((overlap) => overlap.ownerCount >= 2).map((overlap) => overlap.id),
    },
    overlaps,
    candidateMoves,
    blockers,
    nextSteps: [
      'Meti reviews this map and confirms exact S2 dual-read target endpoints.',
      'Keep ORCH_REGISTRY_VIA_HUB default false until shadow diff evidence is collected.',
      'Do not remove legacy Orchestrator paths in this spec.',
    ],
  };
}

function writeReport(report, outPath, noWrite) {
  if (!outPath || noWrite) return null;
  const absOut = path.resolve(REPO_ROOT, outPath);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, `${JSON.stringify(report, null, 2)}\n`);
  return absOut;
}

function createFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-convergence-map-'));
  const files = {
    'bots/orchestrator/lib/registry.ts': "const sql = 'SELECT * FROM agent.registry';\nexport const x = 'health-report';\n",
    'bots/orchestrator/lib/jay-model-policy.ts': "selectLLMChain('jay.intent'); callHubLlm({});\n",
    'bots/orchestrator/src/router.ts': "const route = '/ops-health summary';\n",
    'bots/hub/src/route-registry.ts': "app.get('/hub/health/live', noop); app.get('/hub/metrics', noop);\n",
    'packages/core/lib/agent-registry.ts': "async function registerAgent(){} async function updateStatus(){}\n",
    'packages/core/lib/llm-model-selector.ts': "export function selectLLMChain() { return []; }\n",
    'scripts/reviews/daily-ops-report.ts': "const source = 'daily-ops-report health-report';\n",
    'bots/hub/a2a/hub-card.json': '{"name":"Hub Kernel Agent"}\n',
    'bots/orchestrator/a2a/orchestrator-card.json': '{"name":"Orchestrator Control Plane Agent"}\n',
  };
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  return root;
}

function runSmoke(json) {
  const fixtureRoot = createFixtureRepo();
  const report = buildPlatformConvergenceMap({
    repoRoot: fixtureRoot,
    generatedAt: '2026-07-02T00:00:00.000Z',
  });

  assert.equal(report.ok, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.liveMutation, false);
  assert.deepEqual(report.summary.multiOwnerAreas.sort(), ['agent_registry', 'health_ops', 'llm_policy']);
  assert(report.overlaps.find((area) => area.id === 'agent_registry').fileCount >= 2);
  assert(report.overlaps.find((area) => area.id === 'llm_policy').fileCount >= 2);
  assert(report.overlaps.find((area) => area.id === 'health_ops').fileCount >= 2);
  assert(report.blockers.includes('no_dual_read_shadow_evidence_yet'));
  assert.equal(report.blockers.includes('no_agent_card_pair_yet'), false);
  assert.equal(JSON.stringify(report).includes('launchctl'), false);

  const result = {
    ok: true,
    suite: 'platform-convergence-map-smoke',
    spec: SPEC_ID,
    areas: report.overlaps.map((area) => area.id),
    filesScanned: report.summary.filesScanned,
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log('platform-convergence-map-smoke ok');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.smoke) {
    runSmoke(args.json);
    return;
  }

  const report = buildPlatformConvergenceMap({ scopes: args.scopes });
  const written = writeReport(report, args.out, args.noWrite);

  if (args.json) {
    console.log(JSON.stringify({ ...report, written }, null, 2));
    return;
  }

  console.log(`platform convergence map: ${report.summary.filesScanned} files, ${report.summary.overlapFiles} overlap files`);
  for (const overlap of report.overlaps) {
    console.log(`- ${overlap.id}: ${overlap.fileCount} files, owners=${overlap.owners.join(',') || 'none'}`);
  }
  if (written) console.log(`written: ${written}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`platform-convergence-map failed: ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  });
}
