#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const AUDIT_ITEMS = [];

function renderText(payload) {
  return [
    '🧭 Runtime Static Limit Audit',
    `remaining: ${payload.remainingCount}`,
    `lowPriority: ${payload.lowPriorityCount}`,
    '',
    '남은 항목:',
    ...payload.items.map((item) => `- ${item.key} | ${item.status} | ${item.reason}`),
  ].join('\n');
}

export async function buildRuntimeStaticLimitAudit({ json = false } = {}) {
  const payload = {
    ok: true,
    remainingCount: AUDIT_ITEMS.filter((item) => item.status === 'remaining_static').length,
    lowPriorityCount: AUDIT_ITEMS.filter((item) => item.status !== 'remaining_static').length,
    items: AUDIT_ITEMS,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const json = process.argv.includes('--json');
  const result = await buildRuntimeStaticLimitAudit({ json });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-static-limit-audit 오류:',
  });
}
