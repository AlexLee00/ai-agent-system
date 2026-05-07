#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { extractInvestmentRuntimeConfig } from '../shared/runtime-config.ts';

export function runRuntimeConfigOverlaySmoke() {
  const extracted = extractInvestmentRuntimeConfig({
    capital_management: {
      luna: {
        minConfidence: {
          live: {
            kis: 0.22,
            kis_overseas: 0.22,
          },
        },
      },
      runtime_config: {
        luna: {
          minConfidence: {
            live: {
              kis_overseas: 0.21,
            },
          },
        },
      },
    },
    runtime_config: {
      luna: {
        minConfidence: {
          live: {
            kis: 0.2,
          },
        },
      },
    },
  });

  assert.equal(extracted.luna.minConfidence.live.kis, 0.2);
  assert.equal(extracted.luna.minConfidence.live.kis_overseas, 0.21);

  return {
    ok: true,
    smoke: 'runtime-config-overlay',
    live: extracted.luna.minConfidence.live,
  };
}

async function main() {
  const result = runRuntimeConfigOverlaySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime-config-overlay-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-config-overlay-smoke 실패:',
  });
}
