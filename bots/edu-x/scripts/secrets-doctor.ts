#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { EduxClient, getEduxSecrets, REQUIRED_SECRET_KEYS } = require('../lib/edux-client.ts');
const { parseArgs, emitJsonIfRequested } = require('../lib/edux-runtime-support.ts');

function redactCredential(key, value) {
  if (!value) return null;
  if (key === 'base_url') {
    try {
      const parsed = new URL(String(value));
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return 'configured';
    }
  }
  return 'configured';
}

async function main() {
  const args = parseArgs();
  const health = process.argv.includes('--health');
  const result = {
    ok: false,
    credentialSources: ['hub:edux'],
    requiredKeys: REQUIRED_SECRET_KEYS,
    source: null,
    present: {},
    redacted: {},
    health: null,
    checkedAt: new Date().toISOString(),
  };

  let secrets = null;
  try {
    secrets = await getEduxSecrets();
    result.source = secrets?._source || null;
  } catch (err) {
    result.error = `getEduxSecrets_failed:${err?.message || err}`;
  }

  for (const key of result.requiredKeys) {
    result.present[key] = Boolean(secrets?.[key]);
    result.redacted[key] = redactCredential(key, secrets?.[key]);
  }
  result.ok = result.requiredKeys.every((key) => result.present[key]);

  if (health && result.ok) {
    const client = new EduxClient({ secrets });
    result.health = await client.health();
  }

  if (args.json) emitJsonIfRequested(true, result);
  else {
    console.log(`[edu-x/secrets-doctor] ok=${result.ok}`);
    console.log(JSON.stringify({ source: result.source, present: result.present, redacted: result.redacted, health: result.health }, null, 2));
  }

  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[edu-x/secrets-doctor] 오류:', err);
    process.exit(1);
  });
}
