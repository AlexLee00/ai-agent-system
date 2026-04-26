#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import http from 'node:http';

const { configureHttpServer, parsePositiveIntEnv } = require('../src/server-hardening');

async function main(): Promise<void> {
  assert.equal(parsePositiveIntEnv('HUB_SERVER_HARDENING_SMOKE_MISSING', 17), 17);

  process.env.HUB_SERVER_HARDENING_SMOKE_VALUE = '42';
  assert.equal(parsePositiveIntEnv('HUB_SERVER_HARDENING_SMOKE_VALUE', 17), 42);

  process.env.HUB_SERVER_HARDENING_SMOKE_VALUE = '-1';
  assert.equal(parsePositiveIntEnv('HUB_SERVER_HARDENING_SMOKE_VALUE', 17), 17);

  let fatalErrorSeen = false;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  configureHttpServer(server, {
    onFatalError: () => {
      fatalErrorSeen = true;
    },
  });

  assert.equal(server.requestTimeout, 120000);
  assert.equal(server.headersTimeout, 65000);
  assert.equal(server.keepAliveTimeout, 5000);
  assert.equal(server.maxRequestsPerSocket, 1000);

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    server.emit('error', new Error('server_hardening_smoke_error'));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(fatalErrorSeen, true);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('server_hardening_smoke_ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
