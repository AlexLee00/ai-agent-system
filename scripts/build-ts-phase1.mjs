import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = '/Users/alexlee/projects/ai-agent-system';
const outdir = path.join(root, 'dist', 'ts-phase1');

const entryPoints = [
  path.join(root, 'packages/core/lib/message-envelope.core.ts'),
  path.join(root, 'packages/core/lib/event-lake.core.ts'),
  path.join(root, 'packages/core/lib/hiring-contract.core.ts'),
  path.join(root, 'packages/core/lib/pg-pool.core.ts'),
  path.join(root, 'packages/core/lib/shared-types.ts'),
  path.join(root, 'packages/core/lib/elixir-bridge.ts'),
  path.join(root, 'bots/investment/shared/market-regime.core.ts'),
];

await mkdir(outdir, { recursive: true });

await build({
  entryPoints,
  outdir,
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  sourcemap: true,
  logLevel: 'info',
  tsconfig: path.join(root, 'tsconfig.json'),
});

await writeFile(
  path.join(outdir, 'package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
  'utf8',
);

console.log(`[build-ts-phase1] built ${entryPoints.length} entries -> ${outdir}`);
