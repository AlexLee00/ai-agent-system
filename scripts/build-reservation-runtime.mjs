import path from 'node:path';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { build } from 'esbuild';

const root = '/Users/alexlee/projects/ai-agent-system';
const reservationRoot = path.join(root, 'bots', 'reservation');
const runtimeOutdir = process.env.RESERVATION_RUNTIME_OUTDIR
  ? path.resolve(process.env.RESERVATION_RUNTIME_OUTDIR)
  : path.join(root, 'dist', 'ts-runtime');
const coreRuntimeFiles = [
  'packages/core/lib/agent-heartbeats.js',
  'packages/core/lib/db/helpers.js',
  'packages/core/lib/env.js',
  'packages/core/lib/hub-client.js',
  'packages/core/lib/kst.js',
  'packages/core/lib/hub-alarm-client.js',
  'packages/core/lib/pg-pool.js',
  'packages/core/lib/reservation-rag.js',
  'packages/core/lib/runtime-config-loader.js',
];

function walkTs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'context' || entry.name === 'launchd' || entry.name === 'node_modules') continue;
      results.push(...walkTs(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    results.push(full);
  }
  return results;
}

function walkLegacyJs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'context' || entry.name === 'launchd' || entry.name === 'node_modules') continue;
      results.push(...walkLegacyJs(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.legacy.js')) continue;
    results.push(full);
  }
  return results;
}

const entryPoints = walkTs(reservationRoot).filter((file) => statSync(file).isFile());
const legacyFiles = walkLegacyJs(reservationRoot).filter((file) => statSync(file).isFile());

await build({
  entryPoints,
  outdir: runtimeOutdir,
  outbase: root,
  bundle: false,
  platform: 'node',
  format: 'cjs',
  target: ['node22'],
  sourcemap: true,
  logLevel: 'info',
  tsconfig: path.join(root, 'tsconfig.strict.json'),
});

for (const file of legacyFiles) {
  const relative = path.relative(root, file);
  const target = path.join(runtimeOutdir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(file, target);
}

for (const relative of coreRuntimeFiles) {
  const source = path.join(root, relative);
  const target = path.join(runtimeOutdir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);

  if (relative.endsWith('.js')) {
    const legacyRelative = relative.replace(/\.js$/, '.legacy.js');
    const legacySource = path.join(root, legacyRelative);
    try {
      if (statSync(legacySource).isFile()) {
        const legacyTarget = path.join(runtimeOutdir, legacyRelative);
        mkdirSync(path.dirname(legacyTarget), { recursive: true });
        copyFileSync(legacySource, legacyTarget);
      }
    } catch {
      // No legacy sibling file for this runtime helper.
    }
  }
}

console.log(`[build-reservation-runtime] built ${entryPoints.length} entries -> ${runtimeOutdir}`);
