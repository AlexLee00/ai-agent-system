#!/usr/bin/env node
// @ts-nocheck

import { expireStaleAgentMessages, getMessageBusHygiene } from '../shared/agent-message-bus.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildAgentMessageBusHygienePlan } from '../shared/luna-operational-closure-pack.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    staleHours: Math.max(1, Number(argv.find((arg) => arg.startsWith('--stale-hours='))?.split('=')[1] || 24) || 24),
    limit: Math.max(1, Math.min(500, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 100) || 100)),
    incidentKeyPrefix: argv.find((arg) => arg.startsWith('--incident-prefix='))?.split('=')[1] || '',
    apply: argv.includes('--apply'),
    dryRun: argv.includes('--dry-run') || !argv.includes('--apply'),
    json: argv.includes('--json'),
    confirm: argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || null,
  };
}

export async function runAgentMessageBusHygiene(args = {}) {
  const staleHours = Math.max(1, Number(args.staleHours || 24) || 24);
  const limit = Math.max(1, Math.min(500, Number(args.limit || 100) || 100));
  const before = await getMessageBusHygiene({ staleHours, limit });
  if (args.apply === true && args.confirm !== 'luna-agent-bus-hygiene') {
    const result = {
      ok: false,
      status: 'agent_message_bus_hygiene_confirm_required',
      staleHours,
      before,
      action: {
        ok: false,
        dryRun: true,
        staleHours,
        candidates: 0,
        expired: 0,
        error: 'confirm_required:luna-agent-bus-hygiene',
      },
      after: before,
    };
    result.plan = buildAgentMessageBusHygienePlan(result);
    return result;
  }
  const action = await expireStaleAgentMessages({
    staleHours,
    limit,
    incidentKeyPrefix: args.incidentKeyPrefix || '',
    dryRun: args.apply !== true,
  });
  const after = args.apply === true ? await getMessageBusHygiene({ staleHours, limit }) : before;
  const result = {
    ok: before.ok !== false && action.ok !== false,
    status: action.expired > 0 ? 'agent_message_bus_stale_expired' : 'agent_message_bus_hygiene_clear',
    staleHours,
    before,
    action,
    after,
  };
  result.plan = buildAgentMessageBusHygienePlan(result);

  if (args.apply === true) {
    await db.run(
      `INSERT INTO investment.mapek_knowledge (event_type, payload)
       VALUES ($1, $2::jsonb)`,
      [
        'agent_message_bus_hygiene_audit',
        JSON.stringify({
          staleHours,
          limit,
          staleBefore: before.staleCount || 0,
          expired: action.expired || 0,
          confirmed: true,
          appliedAt: new Date().toISOString(),
        }),
      ],
    ).catch(() => {});
  }

  if (!args.suppressAlert && (args.apply === true || Number(before.staleCount || 0) > 0)) {
    await publishAlert({
      from_bot: 'luna',
      event_type: 'agent_message_bus_hygiene',
      alert_level: Number(before.staleCount || 0) > 0 ? 1 : 0,
      message: [
        '🧹 Luna Agent message bus hygiene',
        `status=${result.status}`,
        `stale_before=${before.staleCount || 0}, expired=${action.expired || 0}`,
      ].join('\n'),
      payload: result,
    }).catch(() => false);
  }

  return result;
}

async function main() {
  const args = parseArgs();
  const result = await runAgentMessageBusHygiene(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status} stale_before=${result.before?.staleCount || 0} expired=${result.action?.expired || 0}`);
  return result;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-agent-message-bus-hygiene 실패:',
  });
}
