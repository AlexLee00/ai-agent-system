#!/usr/bin/env tsx

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), 'backups', 'hub');

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name) {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    command: [command, ...args].join(' '),
    stdout: String(result.stdout || '').slice(0, 2_000),
    stderr: String(result.stderr || '').slice(0, 2_000),
  };
}

function buildPlan() {
  const database = process.env.PGDATABASE || process.env.POSTGRES_DB || 'jay';
  const backupDir = argValue('--backup-dir') || process.env.HUB_STAGE_D_BACKUP_DIR || DEFAULT_BACKUP_DIR;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const runDir = path.join(backupDir, stamp);
  return {
    ok: true,
    stage: 'hub_stage_d',
    task: 'D4_daily_backup',
    mode: hasFlag('--plan') ? 'plan_only' : 'backup',
    database,
    backupDir,
    runDir,
    files: {
      agentSchema: path.join(runDir, 'hub_agent_schema.sql'),
      routingLogSchema: path.join(runDir, 'hub_routing_log_schema.sql'),
      hubSchema: path.join(runDir, 'hub_schema.sql'),
      hubRuntime: path.join(runDir, 'hub_runtime.sql'),
      launchdArchive: path.join(runDir, 'hub_launchd.tar.gz'),
      secretsEncrypted: path.join(runDir, 'secrets-store.json.gpg'),
      manifest: path.join(runDir, 'manifest.json'),
    },
    safety: {
      productionRestore: false,
      protectedRestart: false,
      cleartextSecretsBackup: false,
    },
  };
}

async function main() {
  const json = hasFlag('--json');
  const planOnly = hasFlag('--plan');
  const plan = buildPlan();
  if (planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  fs.mkdirSync(plan.runDir, { recursive: true, mode: 0o700 });
  const results = [];
  results.push(run('pg_dump', [
    '-d', plan.database,
    '--schema-only',
    '--schema=agent',
    '-f', plan.files.agentSchema,
  ]));
  results.push(run('pg_dump', [
    '-d', plan.database,
    '--schema-only',
    '-t', 'public.llm_routing_log',
    '-f', plan.files.routingLogSchema,
  ]));
  results.push(run('pg_dump', ['-d', plan.database, '--schema=hub', '--schema-only', '-f', plan.files.hubSchema]));
  results.push(run('pg_dump', [
    '-d', plan.database,
    '-t', 'public.llm_routing_log',
    '-t', 'agent.event_lake',
    '-f', plan.files.hubRuntime,
  ]));
  results.push(run('tar', ['-czf', plan.files.launchdArchive, '-C', PROJECT_ROOT, 'bots/hub/launchd']));

  let secretsBackup = { ok: false, status: 'gpg_config_missing' };
  const recipient = process.env.HUB_BACKUP_GPG_RECIPIENT;
  if (recipient) {
    const secretsPath = path.join(PROJECT_ROOT, 'bots/hub/secrets-store.json');
    const gpg = run('gpg', ['--batch', '--yes', '--encrypt', '--recipient', recipient, '--output', plan.files.secretsEncrypted, secretsPath]);
    secretsBackup = { ok: gpg.ok, status: gpg.ok ? 'encrypted' : 'gpg_failed', stderr: gpg.stderr };
  }

  const files = Object.entries(plan.files)
    .filter(([key, filePath]) => key !== 'manifest' && fs.existsSync(filePath))
    .map(([key, filePath]) => ({
      key,
      path: filePath,
      bytes: fs.statSync(filePath).size,
      sha256: sha256(filePath),
    }));

  const manifest = {
    ...plan,
    completedAt: new Date().toISOString(),
    ok: results.every((item) => item.ok),
    commandResults: results,
    secretsBackup,
    artifacts: files,
  };
  fs.writeFileSync(plan.files.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`[hub-stage-d-backup] ok=${manifest.ok} dir=${plan.runDir}`);
  }
  if (!manifest.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
