#!/usr/bin/env node
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { parseReservationCommand, isRetryRegistrationRequest } = require('../../reservation/lib/manual-reservation');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const rawText = String(args.text || args.raw_text || '').trim();

  if (!rawText) {
    console.log(JSON.stringify({
      ok: false,
      code: 'MISSING_TEXT',
      error: '예약 원문이 비어 있습니다. --text=\"민경수 010-2792-2221 3월 18일 15:00-16:30 A1 예약해줘\" 형식으로 실행하세요.',
    }));
    process.exit(1);
  }

  const parsed = parseReservationCommand({ raw_text: rawText });
  if (!parsed.ok) {
    console.log(JSON.stringify(parsed));
    process.exit(1);
  }

  const manualRetry = isRetryRegistrationRequest({ raw_text: rawText });

  const commandArgs = {
    command: 'register_reservation',
    raw_text: rawText,
    source: 'openclaw_exec',
    manual_retry: manualRetry,
    reservation: parsed.reservation || null,
    reservations: parsed.reservations || null,
    batch: parsed.mode === 'batch',
  };

  const rows = await pgPool.query('claude', `
    INSERT INTO bot_commands (to_bot, command, args)
    VALUES ($1, $2, $3)
    RETURNING id, to_bot, command, status, created_at
  `, ['ska', 'register_reservation', JSON.stringify(commandArgs)]);

  const row = rows[0];
  console.log(JSON.stringify({
    ok: true,
    queued: true,
    id: row?.id || null,
    to_bot: row?.to_bot || 'ska',
    command: row?.command || 'register_reservation',
    status: row?.status || 'pending',
    created_at: row?.created_at || null,
    reservation: parsed.reservation || null,
    reservations: parsed.reservations || null,
    batch: parsed.mode === 'batch',
    manual_retry: manualRetry,
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: 'QUEUE_INSERT_FAILED',
    error: error?.message || String(error),
  }));
  process.exit(1);
});
