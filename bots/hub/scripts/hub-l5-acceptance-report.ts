#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const outputPath = path.join(repoRoot, 'bots/hub/output/l5-acceptance-report.json');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function has(relativePath, needle) {
  return read(relativePath).includes(needle);
}

function packageJson() {
  return JSON.parse(read('bots/hub/package.json'));
}

function gate(name, ok, evidence, blockers = []) {
  return {
    name,
    ok: Boolean(ok),
    blockers,
    evidence,
  };
}

function buildReport() {
  const pkg = packageJson();
  const scripts = pkg.scripts || {};
  const tsconfig = JSON.parse(read('bots/hub/tsconfig.json'));
  const strictFiles = tsconfig.files || [];

  const gates = [
    gate('Load', Boolean(scripts['load:k6'] && scripts['load:k6:short']), {
      scripts: ['load:k6', 'load:k6:short'],
      guide: 'docs/hub/LOAD_TEST_GUIDE.md',
      mapped: has('docs/hub/LOAD_TEST_GUIDE.md', 'L5 자동 게이트 매핑'),
    }, [
      ...(!scripts['load:k6'] ? ['missing_load_k6_script'] : []),
      ...(!has('docs/hub/LOAD_TEST_GUIDE.md', 'L5 자동 게이트 매핑') ? ['missing_load_gate_mapping'] : []),
    ]),
    gate('Backpressure', has('bots/hub/lib/routes/llm.ts', 'providerBackpressure')
      && has('bots/hub/lib/routes/llm.ts', "res.set('Retry-After'")
      && has('bots/hub/lib/llm/admission-control.ts', 'HUB_LLM_OVERFLOW_TO_JOB'), {
      retryAfter: 'provider 429/cooldown responses include Retry-After',
      overflow: 'HUB_LLM_OVERFLOW_TO_JOB converts queue_full into async job when enabled',
    }, []),
    gate('DistributedLimiter', has('bots/hub/lib/llm/shared-limiter.ts', 'HUB_LLM_SHARED_LIMITER_BACKEND')
      && has('bots/hub/lib/llm/shared-limiter.ts', 'hub_llm_limiter_leases'), {
      defaultBackend: 'file',
      multinodeBackend: 'pg',
      table: 'agent.hub_llm_limiter_leases',
    }, []),
    gate('AsyncQueue', has('bots/hub/lib/llm/job-store.ts', 'HUB_LLM_JOB_STORE_BACKEND')
      && has('bots/hub/lib/llm/job-store.ts', 'hub_llm_jobs')
      && has('bots/hub/src/route-registry.ts', "app.post('/hub/llm/jobs'"), {
      defaultBackend: 'file',
      multinodeBackend: 'pg',
      table: 'agent.hub_llm_jobs',
      routes: ['/hub/llm/jobs', '/hub/llm/jobs/:id', '/hub/llm/jobs/:id/result'],
    }, []),
    gate('Rollback', has('bots/hub/lib/llm/shared-limiter.ts', "return raw === 'pg'")
      && has('bots/hub/lib/llm/job-store.ts', "return raw === 'pg'"), {
      limiterFlag: 'HUB_LLM_SHARED_LIMITER_BACKEND=file|pg',
      jobStoreFlag: 'HUB_LLM_JOB_STORE_BACKEND=file|pg',
      overflowFlag: 'HUB_LLM_OVERFLOW_TO_JOB',
    }, []),
    gate('StrictTS', scripts['typecheck:strict']
      && tsconfig.compilerOptions?.strict === true
      && strictFiles.includes('src/app.ts')
      && strictFiles.includes('src/route-registry.ts')
      && strictFiles.includes('lib/llm/job-store.ts'), {
      script: 'typecheck:strict',
      files: strictFiles,
    }, []),
  ];

  for (const entry of gates) {
    if (!entry.ok && entry.blockers.length === 0) entry.blockers.push(`${entry.name.toLowerCase()}_gate_failed`);
  }

  return {
    ok: gates.every((entry) => entry.ok),
    generatedAt: new Date().toISOString(),
    status: gates.every((entry) => entry.ok) ? 'l5_acceptance_evidence_ready' : 'l5_acceptance_evidence_blocked',
    gates,
    nextActions: gates.every((entry) => entry.ok)
      ? ['Run load:k6:short or load:k6 in an approved runtime window for live latency/fail-rate evidence.']
      : gates.flatMap((entry) => entry.blockers),
  };
}

function main() {
  const report = buildReport();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  assert.equal(report.ok, true, `L5 acceptance report blocked: ${JSON.stringify(report.nextActions)}`);
  console.log(JSON.stringify(report, null, 2));
}

main();
