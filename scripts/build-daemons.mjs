import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const root = process.env.PROJECT_ROOT
  ? path.resolve(process.env.PROJECT_ROOT)
  : '/Users/alexlee/projects/ai-agent-system';
const outdir = path.join(root, 'dist', 'daemons');

const entries = [
  { label: 'ai.jay.runtime', entry: 'bots/orchestrator/src/jay-runtime.ts' },
  { label: 'ai.orchestrator', entry: 'bots/orchestrator/src/orchestrator.ts' },
  { label: 'ai.claude.auto-dev', entry: 'bots/claude/scripts/auto-dev-runner.ts' },
  { label: 'ai.claude.codex-notifier', entry: 'bots/claude/scripts/codex-notifier-runner.ts' },
  { label: 'ai.blog.node-server', entry: 'bots/blog/api/node-server.ts' },
  { label: 'ai.luna.marketdata-mcp', entry: 'bots/investment/mcp/luna-marketdata-mcp/src/server.ts' },
  { label: 'ai.luna.crypto-holding-monitor-6h', entry: 'bots/investment/scripts/crypto-holding-monitor.ts', format: 'esm' },
  { label: 'ai.ska.commander', entry: 'bots/reservation/src/ska.ts', protected: true },
  { label: 'ai.ska.dashboard', entry: 'bots/reservation/scripts/dashboard-server.ts', protected: true },
  { label: 'ai.ska.preflight', entry: 'bots/reservation/scripts/preflight.ts', format: 'cjs', protected: true },
  { label: 'ai.ska.naver-monitor', entry: 'bots/reservation/auto/monitors/naver-monitor.ts', format: 'cjs', protected: true },
  { label: 'ai.ska.pickko-verify', entry: 'bots/reservation/manual/admin/pickko-verify.ts', format: 'cjs', protected: true },
  { label: 'ai.ska.pickko-accurate', entry: 'bots/reservation/manual/reservation/pickko-accurate.ts', format: 'cjs', protected: true },
  { label: 'ai.ska.pickko-pay-pending', entry: 'bots/reservation/manual/reports/pickko-pay-pending.ts', format: 'cjs', protected: true },
  { label: 'ai.ska.bug-report', entry: 'bots/reservation/src/bug-report.ts', format: 'cjs', protected: true },
  { label: 'ai.hub.resource-api', entry: 'bots/hub/src/hub.ts', protected: true },
];

const external = [
  'pg',
  'pg-native',
  'playwright',
  'playwright-core',
  'puppeteer',
  'puppeteer-core',
  'sharp',
  'better-sqlite3',
  'fsevents',
  'canvas',
  'tesseract.js',
  'tesseract.js-core',
  'technicalindicators',
  'ccxt',
  'langfuse',
  'langfuse-core',
  'openai',
  'groq-sdk',
];

mkdirSync(outdir, { recursive: true });
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const results = [];
for (const item of entries) {
  const entryPoint = path.join(root, item.entry);
  const format = item.format === 'cjs' ? 'cjs' : 'esm';
  const extension = format === 'esm' ? '.mjs' : '.cjs';
  const outfile = path.join(outdir, `${item.label}${extension}`);
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    target: ['node26'],
    format,
    sourcemap: true,
    absWorkingDir: root,
    external,
    outExtension: { '.js': extension },
    logLevel: 'silent',
    tsconfig: path.join(root, 'tsconfig.json'),
    packages: 'external',
  });
  results.push({
    label: item.label,
    entry: item.entry,
    outfile: path.relative(root, outfile),
    format,
    protected: item.protected === true,
  });
}

console.log(JSON.stringify({
  ok: true,
  outdir: path.relative(root, outdir),
  count: results.length,
  entries: results,
}, null, 2));
