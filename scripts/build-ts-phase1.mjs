import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = '/Users/alexlee/projects/ai-agent-system';
const outdir = path.join(root, 'dist', 'ts-phase1');
const runtimeOutdir = path.join(root, 'dist', 'ts-runtime');

const entryPoints = [
  path.join(root, 'packages/core/lib/message-envelope.core.ts'),
  path.join(root, 'packages/core/lib/event-lake.core.ts'),
  path.join(root, 'packages/core/lib/hiring-contract.core.ts'),
  path.join(root, 'packages/core/lib/pg-pool.core.ts'),
  path.join(root, 'packages/core/lib/shared-types.ts'),
  path.join(root, 'packages/core/lib/elixir-bridge.ts'),
  path.join(root, 'bots/investment/shared/market-regime.core.ts'),
];

const runtimeEntryPoints = [
  path.join(root, 'packages/core/lib/llm-timeouts.ts'),
  path.join(root, 'packages/core/lib/runtime-selector.ts'),
  path.join(root, 'packages/core/lib/llm-keys.ts'),
  path.join(root, 'packages/core/lib/tool-selector.ts'),
  path.join(root, 'packages/core/lib/token-tracker.ts'),
  path.join(root, 'packages/core/lib/trace-collector.ts'),
  path.join(root, 'packages/core/lib/hub-client.ts'),
  path.join(root, 'packages/core/lib/llm-logger.ts'),
  path.join(root, 'packages/core/lib/pg-pool.ts'),
  path.join(root, 'packages/core/lib/llm-model-selector.ts'),
  path.join(root, 'packages/core/lib/llm-fallback.ts'),
  path.join(root, 'packages/core/lib/reporting-hub.ts'),
  path.join(root, 'packages/core/lib/telegram-sender.ts'),
  path.join(root, 'packages/core/lib/openclaw-client.ts'),
  path.join(root, 'packages/core/lib/message-envelope.ts'),
  path.join(root, 'packages/core/lib/event-lake.ts'),
  path.join(root, 'packages/core/lib/central-logger.ts'),
  path.join(root, 'packages/core/lib/trace.ts'),
  path.join(root, 'packages/core/lib/kst.ts'),
  path.join(root, 'packages/core/lib/env.ts'),
  path.join(root, 'packages/core/lib/health-core.ts'),
  path.join(root, 'packages/core/lib/runtime-config-loader.ts'),
  path.join(root, 'packages/core/lib/billing-guard.ts'),
  path.join(root, 'packages/core/lib/agent-registry.ts'),
];

await mkdir(outdir, { recursive: true });
await mkdir(runtimeOutdir, { recursive: true });

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

await build({
  entryPoints: runtimeEntryPoints,
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

await writeFile(
  path.join(outdir, 'package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
  'utf8',
);

console.log(`[build-ts-phase1] built ${entryPoints.length} entries -> ${outdir}`);
console.log(`[build-ts-phase1] built ${runtimeEntryPoints.length} runtime entries -> ${runtimeOutdir}`);
