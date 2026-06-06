#!/usr/bin/env tsx

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), 'backups', 'hub');
const DEFAULT_RETENTION_DAYS = 14;

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name) {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
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

function isBackupRunDirName(name) {
  return /^\d{8}T\d{6}Z$/.test(String(name || ''));
}

function isHubStageDBackupDir(dirPath) {
  const manifestPath = path.join(dirPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest?.stage === 'hub_stage_d' && manifest?.task === 'D4_daily_backup';
  } catch {
    return false;
  }
}

function pruneOldBackups(backupDir, currentRunDir, retentionDays) {
  if (hasFlag('--no-prune')) return { enabled: false, retentionDays, removed: [] };
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const current = path.resolve(currentRunDir);
  const removed = [];

  if (!fs.existsSync(backupDir)) return { enabled: true, retentionDays, removed };

  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isBackupRunDirName(entry.name)) continue;
    const dirPath = path.resolve(backupDir, entry.name);
    if (dirPath === current) continue;
    if (!isHubStageDBackupDir(dirPath)) continue;
    const stat = fs.statSync(dirPath);
    if (stat.mtimeMs > cutoffMs) continue;
    fs.rmSync(dirPath, { recursive: true, force: true });
    removed.push({ path: dirPath, mtime: stat.mtime.toISOString() });
  }

  return { enabled: true, retentionDays, removed };
}

function buildPlan() {
  const database = process.env.PGDATABASE || process.env.POSTGRES_DB || 'jay';
  const backupDir = argValue('--backup-dir') || process.env.HUB_STAGE_D_BACKUP_DIR || DEFAULT_BACKUP_DIR;
  const retentionDays = parsePositiveInt(
    argValue('--retention-days') || process.env.HUB_STAGE_D_BACKUP_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
  );
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
    retention: {
      enabled: !hasFlag('--no-prune'),
      days: retentionDays,
    },
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
  const pruneOnly = hasFlag('--prune-only');
  const plan = buildPlan();
  if (planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (pruneOnly) {
    const prunedBackups = pruneOldBackups(plan.backupDir, plan.runDir, plan.retention.days);
    const payload = {
      ok: true,
      stage: plan.stage,
      task: plan.task,
      mode: 'prune_only',
      backupDir: plan.backupDir,
      retention: plan.retention,
      prunedBackups,
    };
    console.log(json ? JSON.stringify(payload, null, 2) : `[hub-stage-d-backup] pruned=${prunedBackups.removed.length}`);
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

  const files = await Promise.all(
    Object.entries(plan.files)
      .filter(([key, filePath]) => key !== 'manifest' && fs.existsSync(filePath))
      .map(async ([key, filePath]) => ({
        key,
        path: filePath,
        bytes: fs.statSync(filePath).size,
        sha256: await sha256(filePath),
      })),
  );

  const manifest = {
    ...plan,
    completedAt: new Date().toISOString(),
    ok: results.every((item) => item.ok) && secretsBackup.ok,
    commandResults: results,
    secretsBackup,
    artifacts: files,
    prunedBackups: null,
  };
  if (manifest.ok) {
    manifest.prunedBackups = pruneOldBackups(plan.backupDir, plan.runDir, plan.retention.days);
  }
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
