#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function main() {
  let webPush = null;
  try {
    webPush = require('web-push');
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: 'missing_web_push_dependency',
      message: String(error?.message || error),
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const keys = webPush.generateVAPIDKeys();
  console.log(JSON.stringify({
    ok: true,
    note: 'Output only. Do not store or commit private keys. Master should set launchd/env secrets.',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    env: {
      OPS_CONSOLE_VAPID_PUBLIC_KEY: keys.publicKey,
      OPS_CONSOLE_VAPID_PRIVATE_KEY: keys.privateKey,
      OPS_CONSOLE_VAPID_SUBJECT: 'mailto:ops-console@localhost',
    },
  }, null, 2));
}

main();
