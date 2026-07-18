import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { build } from 'esbuild';

const root = process.env.PROJECT_ROOT
  ? path.resolve(process.env.PROJECT_ROOT)
  : '/Users/alexlee/projects/ai-agent-system';
const outdir = process.env.DAEMON_BUILD_OUTDIR
  ? path.resolve(process.env.DAEMON_BUILD_OUTDIR)
  : path.join(root, 'dist', 'daemons');

const entries = [
  { label: 'ai.jay.runtime', entry: 'bots/orchestrator/src/jay-runtime.ts', format: 'cjs' },
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
  'openai',
  'groq-sdk',
];

const labelsArg = process.argv.find((arg) => arg.startsWith('--labels='));
const requestedLabels = new Set(
  String(labelsArg?.slice('--labels='.length) || '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean),
);
const unknownLabels = [...requestedLabels].filter((label) => !entries.some((entry) => entry.label === label));
if (unknownLabels.length > 0) {
  throw new Error(`unknown daemon labels: ${unknownLabels.join(', ')}`);
}
const selectedEntries = requestedLabels.size > 0
  ? entries.filter((entry) => requestedLabels.has(entry.label))
  : entries;

function computeFileHash(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function computeSourcesHash(sources) {
  const hash = createHash('sha256');
  for (const source of [...sources].sort()) {
    const relative = path.relative(root, source).split(path.sep).join('/');
    hash.update(relative);
    hash.update('\0');
    hash.update(readFileSync(source));
    hash.update('\0');
  }
  return hash.digest('hex');
}

mkdirSync(outdir, { recursive: true });
const tempDir = mkdtempSync(path.join(outdir, '.build-'));

const results = [];
try {
  for (const item of selectedEntries) {
    const entryPoint = path.join(root, item.entry);
    const format = item.format === 'cjs' ? 'cjs' : 'esm';
    const extension = format === 'esm' ? '.mjs' : '.cjs';
    const tempOutfile = path.join(tempDir, `${item.label}${extension}`);
    const outfile = path.join(outdir, `${item.label}${extension}`);
    const buildResult = await build({
      entryPoints: [entryPoint],
      outfile: tempOutfile,
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
      metafile: true,
    });
    const sourceFiles = Object.keys(buildResult.metafile.inputs).map((input) => (
      path.isAbsolute(input) ? input : path.join(root, input)
    ));
    const tempManifest = `${tempOutfile}.manifest.json`;
    const finalManifest = `${outfile}.manifest.json`;
    writeFileSync(tempManifest, JSON.stringify({
      version: 1,
      label: item.label,
      entry: item.entry,
      sourceHash: computeSourcesHash(sourceFiles),
      bundleHash: computeFileHash(tempOutfile),
      sources: sourceFiles.map((source) => path.relative(root, source).split(path.sep).join('/')).sort(),
    }, null, 2));
    results.push({
      label: item.label,
      entry: item.entry,
      outputRel: path.relative(root, outfile),
      tempOutfile,
      finalOutfile: outfile,
      tempManifest,
      finalManifest,
      format,
      protected: item.protected === true,
    });
  }

  for (const result of results) {
    const tempMap = `${result.tempOutfile}.map`;
    if (existsSync(tempMap)) renameSync(tempMap, `${result.finalOutfile}.map`);
    renameSync(result.tempManifest, result.finalManifest);
    renameSync(result.tempOutfile, result.finalOutfile);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  outdir: path.relative(root, outdir),
  count: results.length,
  targeted: requestedLabels.size > 0,
  entries: results.map(({
    tempOutfile: _tempOutfile,
    finalOutfile: _finalOutfile,
    tempManifest: _tempManifest,
    finalManifest: _finalManifest,
    outputRel,
    ...result
  }) => ({
    ...result,
    outfile: outputRel,
  })),
}, null, 2));
