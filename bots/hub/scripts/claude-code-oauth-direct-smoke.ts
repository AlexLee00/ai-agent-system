import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalClaudeCodeBin = process.env.CLAUDE_CODE_BIN;
const originalCapturePath = process.env.CLAUDE_CODE_SMOKE_CAPTURE;

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-oauth-smoke-'));
  const fakeClaudePath = path.join(tmpDir, 'fake-claude.mjs');
  const fakeClaudeBudgetErrorPath = path.join(tmpDir, 'fake-claude-budget-error.mjs');
  const capturePath = path.join(tmpDir, 'capture.json');

  fs.writeFileSync(fakeClaudePath, `#!/usr/bin/env node
import fs from 'node:fs';
const capturePath = process.env.CLAUDE_CODE_SMOKE_CAPTURE;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: process.argv.slice(2),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY
  }, null, 2));
}
process.stdout.write(JSON.stringify({
  result: 'claude oauth ok',
  structured_output: { ok: true },
  is_error: false,
  duration_api_ms: 11,
  total_cost_usd: 0.0001,
  modelUsage: { input_tokens: 4, output_tokens: 3 },
  session_id: 'claude-oauth-smoke-session'
}));
`, 'utf8');
  fs.chmodSync(fakeClaudePath, 0o755);

  fs.writeFileSync(fakeClaudeBudgetErrorPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'error_max_budget_usd',
  is_error: true,
  duration_api_ms: 7,
  total_cost_usd: 0.045,
  modelUsage: { sonnet: { costUSD: 0.045 } },
  session_id: 'claude-budget-error-session',
  errors: ['Reached maximum budget ($0.02)']
}));
process.exit(1);
`, 'utf8');
  fs.chmodSync(fakeClaudeBudgetErrorPath, 0o755);

  process.env.CLAUDE_CODE_BIN = fakeClaudePath;
  process.env.CLAUDE_CODE_SMOKE_CAPTURE = capturePath;

  const { callClaudeCodeOAuth } = await import('../lib/llm/claude-code-oauth.ts');
  const result = await callClaudeCodeOAuth({
    prompt: 'Return a tiny success string.',
    model: 'sonnet',
    systemPrompt: 'You are a smoke test.',
    jsonSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    timeoutMs: 5000,
    maxBudgetUsd: 0.01,
  });

  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'claude-code-oauth');
  assert.equal(result.result, 'claude oauth ok');
  assert.equal(capture.anthropicApiKey, '');
  assert.deepEqual(capture.argv.slice(0, 2), ['-p', 'Return a tiny success string.']);
  assert(capture.argv.includes('--output-format'));
  assert(capture.argv.includes('json'));
  assert(capture.argv.includes('--no-session-persistence'));
  assert(capture.argv.includes('--model'));
  assert(capture.argv.includes('sonnet'));
  assert(capture.argv.includes('--append-system-prompt'));
  assert(capture.argv.includes('--json-schema'));
  assert(capture.argv.includes('--max-budget-usd'));
  assert(!capture.argv.some((arg: string) => String(arg).toLowerCase().includes('open' + 'claw')));

  process.env.CLAUDE_CODE_BIN = fakeClaudeBudgetErrorPath;
  const budgetError = await callClaudeCodeOAuth({
    prompt: 'Budget failure smoke.',
    model: 'sonnet',
    timeoutMs: 5000,
    maxBudgetUsd: 0.02,
  });
  assert.equal(budgetError.ok, false);
  assert.equal(budgetError.provider, 'failed');
  assert.match(String(budgetError.error || ''), /error_max_budget_usd|maximum budget/i);
  assert.equal(budgetError.sessionId, 'claude-budget-error-session');

  console.log(JSON.stringify({
    ok: true,
    provider: result.provider,
    model: 'sonnet',
    claude_code_direct: true,
    legacy_gateway_used: false,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (originalClaudeCodeBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = originalClaudeCodeBin;
    if (originalCapturePath === undefined) delete process.env.CLAUDE_CODE_SMOKE_CAPTURE;
    else process.env.CLAUDE_CODE_SMOKE_CAPTURE = originalCapturePath;
  });
