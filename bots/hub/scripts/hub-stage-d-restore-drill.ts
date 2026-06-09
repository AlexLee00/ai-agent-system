#!/usr/bin/env tsx

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIRM = 'hub-stage-d-restore-drill';
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), 'backups', 'hub');

type RestoreStep = {
  ok: boolean;
  status: number | null;
  command: string;
  stdout: string;
  stderr: string;
};

type RestoreResult = {
  ok: boolean;
  checkedAt: string;
  stage: string;
  task: string;
  dryRun: boolean;
  backupDir: string;
  manifestPath: string | null;
  smokeDb: string;
  productionRestore: boolean;
  applyGate: string;
  steps: RestoreStep[];
  error?: string;
  supportSchemaFile?: string | null;
  agentSchemaFile?: string | null;
  routingLogSchemaFile?: string | null;
  schemaFile?: string | null;
  skipped?: boolean;
  skipReason?: string;
  requiredConfirm?: string;
};

type ManifestArtifact = {
  key?: string;
  path?: string;
};

type RestoreManifest = {
  files?: Record<string, string | undefined>;
  artifacts?: ManifestArtifact[];
};

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function argValue(name: string) {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

function run(command: string, args: string[]): RestoreStep {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
  return {
    ok: result.status === 0,
    status: result.status,
    command: [command, ...args].join(' '),
    stdout: String(result.stdout || '').slice(0, 2_000),
    stderr: String(result.stderr || '').slice(0, 2_000),
  };
}

function latestManifest(backupDir: string): string | null {
  if (!fs.existsSync(backupDir)) return null;
  const candidates = fs.readdirSync(backupDir)
    .map((name: string) => path.join(backupDir, name, 'manifest.json'))
    .filter((filePath: string) => fs.existsSync(filePath))
    .sort();
  return candidates.pop() || null;
}

async function main() {
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm');
  const backupDir = argValue('--backup-dir') || process.env.HUB_STAGE_D_BACKUP_DIR || DEFAULT_BACKUP_DIR;
  const manifestPath = argValue('--manifest') || latestManifest(backupDir);
  const smokeDb = `hub_restore_smoke_${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`;

  const result: RestoreResult = {
    ok: true,
    checkedAt: new Date().toISOString(),
    stage: 'hub_stage_d',
    task: 'D4_restore_drill',
    dryRun: !apply,
    backupDir,
    manifestPath,
    smokeDb,
    productionRestore: false,
    applyGate: `--apply --confirm=${CONFIRM}`,
    steps: [],
  };

  if (!manifestPath) {
    result.ok = false;
    result.error = 'backup_manifest_missing';
    console.log(JSON.stringify(result, null, 2));
    process.exit(apply ? 1 : 0);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RestoreManifest;
  const supportSchemaFile = manifest.files?.supportSchema || manifest.artifacts?.find?.((item) => item.key === 'supportSchema')?.path;
  const agentSchemaFile = manifest.files?.agentSchema || manifest.artifacts?.find?.((item) => item.key === 'agentSchema')?.path;
  const routingLogSchemaFile = manifest.files?.routingLogSchema || manifest.artifacts?.find?.((item) => item.key === 'routingLogSchema')?.path;
  const schemaFile = manifest.files?.hubSchema || manifest.files?.hub_schema || manifest.artifacts?.find?.((item) => item.key === 'hubSchema')?.path;
  result.supportSchemaFile = supportSchemaFile || null;
  result.agentSchemaFile = agentSchemaFile || null;
  result.routingLogSchemaFile = routingLogSchemaFile || null;
  result.schemaFile = schemaFile;
  if (!schemaFile || !fs.existsSync(schemaFile)) {
    result.ok = false;
    result.error = 'hub_schema_backup_missing';
    console.log(JSON.stringify(result, null, 2));
    process.exit(apply ? 1 : 0);
  }

  if (!apply) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!hasFlag('--force')) {
    const dayOfMonth = new Date().getDate();
    if (dayOfMonth > 7) {
      result.skipped = true;
      result.skipReason = 'monthly_restore_drill_runs_only_during_first_week';
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  }
  if (confirm !== CONFIRM) {
    result.ok = false;
    result.error = 'confirm_required';
    result.requiredConfirm = CONFIRM;
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  result.steps.push(run('createdb', [smokeDb]));
  if (result.steps.at(-1)?.ok) {
    const needsLegacyAgentSchema = !agentSchemaFile && supportSchemaFile && fs.existsSync(supportSchemaFile);
    if (needsLegacyAgentSchema) {
      result.steps.push(run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', smokeDb, '-c', 'CREATE SCHEMA IF NOT EXISTS agent;']));
    }
    if (agentSchemaFile && fs.existsSync(agentSchemaFile)) {
      result.steps.push(run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', smokeDb, '-f', agentSchemaFile]));
    }
    if (routingLogSchemaFile && fs.existsSync(routingLogSchemaFile) && result.steps.at(-1)?.ok) {
      result.steps.push(run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', smokeDb, '-f', routingLogSchemaFile]));
    }
    if (supportSchemaFile && fs.existsSync(supportSchemaFile)) {
      result.steps.push(run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', smokeDb, '-f', supportSchemaFile]));
    }
    if (result.steps.at(-1)?.ok) {
      result.steps.push(run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', smokeDb, '-f', schemaFile]));
    }
  }
  result.steps.push(run('dropdb', ['--if-exists', smokeDb]));
  result.ok = result.steps.every((step) => step.ok);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
