import path from 'node:path';
import { build } from 'esbuild';

const root = '/Users/alexlee/projects/ai-agent-system';
const entryPoint = path.join(root, 'bots/hub/src/hub.ts');
const outfile = path.join(root, 'dist/ts-runtime/bots/hub/src/hub.js');

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  sourcemap: true,
  logLevel: 'info',
});

console.log(`[build-hub-runtime] wrote ${outfile}`);
