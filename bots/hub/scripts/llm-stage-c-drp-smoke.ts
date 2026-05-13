#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const {
  buildBackupCommands,
  buildDrpReadiness,
} = require('../lib/stage-c/resilience');

async function main(): Promise<void> {
  const commands = buildBackupCommands();
  assert(commands.length >= 3, 'Stage C DRP must define concrete backup commands');
  for (const command of commands) {
    assert(!/\b(drop|delete|truncate|restore)\b/i.test(command), `backup command must be non-destructive: ${command}`);
    assert(/pg_dump|mkdir/.test(command), `backup command must be pg_dump/mkdir only: ${command}`);
  }

  const drp = await buildDrpReadiness({ skipDb: true });
  assert.equal(drp.ok, true, 'DRP dry-run readiness should pass without DB access');
  assert.equal(drp.mode, 'read_only_plan');
  assert.equal(drp.restoreToProduction, 'confirm_required_and_out_of_scope');

  console.log(JSON.stringify({
    ok: true,
    stage: 'hub_stage_c',
    drp_mode: drp.mode,
    backup_command_count: commands.length,
    production_restore: drp.restoreToProduction,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
