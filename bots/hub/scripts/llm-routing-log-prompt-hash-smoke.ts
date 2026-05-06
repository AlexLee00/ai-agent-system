#!/usr/bin/env tsx
// @ts-nocheck

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const routeFile = path.join(repoRoot, 'bots', 'hub', 'lib', 'routes', 'llm.ts');
const auditFile = path.join(repoRoot, 'bots', 'hub', 'scripts', 'llm-leak-duplicate-audit.ts');
const migrationFile = path.join(repoRoot, 'bots', 'hub', 'migrations', '20261001000061_llm_routing_log_audit_columns.sql');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const route = read(routeFile);
const audit = read(auditFile);
const migration = read(migrationFile);

assert(route.includes("require('node:crypto')"), 'llm route must use node:crypto for prompt hashing');
assert(route.includes('prompt_hash') && route.includes('request_fingerprint'), 'llm route must write audit columns');
assert(route.includes("createHash('sha256')") || route.includes('createHash(\"sha256\")'), 'llm route must hash with sha256');
assert(route.includes('ensureRoutingLogAuditColumns'), 'llm route must ensure audit columns at runtime');

assert(audit.includes('duplicate_prompt_groups'), 'audit must expose duplicate prompt groups');
assert(audit.includes('duplicate_prompt_group_count'), 'audit summary must include duplicate prompt group count');
assert(audit.includes('HUB_LLM_DUP_AUDIT_BLOCK_PROMPT_DUPES'), 'audit must support opt-in duplicate prompt blocking');

assert(migration.includes('ADD COLUMN IF NOT EXISTS prompt_hash'), 'migration must add prompt_hash');
assert(migration.includes('ADD COLUMN IF NOT EXISTS request_fingerprint'), 'migration must add request_fingerprint');

console.log(JSON.stringify({
  ok: true,
  audit_columns: ['prompt_hash', 'system_prompt_hash', 'request_fingerprint', 'prompt_chars'],
  duplicate_prompt_detection: true,
}, null, 2));
