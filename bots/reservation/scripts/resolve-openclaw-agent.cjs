#!/usr/bin/env node
'use strict';

const { fetchHubRuntimeProfile } = require('../../../packages/core/lib/hub-client.js');

async function main() {
  const team = String(process.argv[2] || '').trim();
  const purpose = String(process.argv[3] || 'default').trim() || 'default';
  const fallback = String(process.argv[4] || 'main').trim() || 'main';

  if (!team) {
    process.stdout.write(fallback);
    return;
  }

  try {
    const profile = await fetchHubRuntimeProfile(team, purpose, 2000);
    const agent = String(profile?.openclaw_agent || fallback).trim() || fallback;
    process.stdout.write(agent);
  } catch {
    process.stdout.write(fallback);
  }
}

main();
