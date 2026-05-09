import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const sigmaRoot = path.join(repoRoot, 'bots/sigma');
const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');

const output = execFileSync(tsxBin, [
  'scripts/runtime-sigma-autonomous-operation-gate.ts',
  '--json',
  '--skip-mcp-runtime',
], {
  cwd: sigmaRoot,
  encoding: 'utf8',
});
const result = JSON.parse(output);
assert.equal(result.codeComplete, true);
assert.ok([
  'sigma_autonomous_operation_blocked',
  'sigma_autonomous_operation_ready',
  'code_complete_operational_pending',
].includes(result.status));
assert.equal(result.selfImprovementCandidateQuality.ok, true);
assert.equal(result.selfImprovementCandidateQuality.routineAvoidCandidates.length, 0);
assert.equal(result.mcpRuntime.status, 'mcp_runtime_check_skipped');
assert.equal(Array.isArray(result.pendingObservation), true);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_autonomous_operation_gate_smoke_passed',
  gateStatus: result.status,
  pendingObservation: result.pendingObservation,
}, null, 2));
