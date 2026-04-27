#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv: Record<string, string | undefined> = {
  GEMINI_CLI_COMMAND: process.env.GEMINI_CLI_COMMAND,
  HUB_BUDGET_GUARDIAN_ENABLED: process.env.HUB_BUDGET_GUARDIAN_ENABLED,
  HUB_LLM_PROVIDER_CIRCUIT_ENABLED: process.env.HUB_LLM_PROVIDER_CIRCUIT_ENABLED,
};

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-cli-adapter-'));
  const mockGemini = path.join(tempRoot, 'mock-gemini-cli.js');
  const argvFile = path.join(tempRoot, 'argv.json');

  fs.writeFileSync(mockGemini, `#!/usr/bin/env node
const fs = require('fs');
const argvFile = process.env.HUB_GEMINI_CLI_ADAPTER_ARGV_FILE;
if (argvFile) fs.writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({
  response: 'gemini cli adapter ok',
  session_id: 'session_gemini_cli_smoke',
  stats: { input_tokens: 8, cached: 2, output_tokens: 4 }
}));
`, { encoding: 'utf8', mode: 0o755 });

  process.env.GEMINI_CLI_COMMAND = mockGemini;
  process.env.HUB_GEMINI_CLI_ADAPTER_ARGV_FILE = argvFile;
  process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';
  process.env.HUB_LLM_PROVIDER_CIRCUIT_ENABLED = 'false';

  try {
    const { callWithFallback } = await import('../lib/llm/unified-caller.ts');
    const result = await callWithFallback({
      callerTeam: 'orchestrator',
      agent: 'steward',
      selectorKey: 'hub.gemini.cli.adapter.smoke',
      chain: [{ provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-pro', maxTokens: 64, temperature: 0 }],
      systemPrompt: 'You are a smoke test.',
      prompt: 'Reply with adapter ok.',
      timeoutMs: 5_000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'gemini-cli-oauth');
    assert.equal(result.selected_route, 'gemini-cli-oauth/gemini-2.5-pro');
    assert.equal(result.result, 'gemini cli adapter ok');
    assert.equal(result.modelUsage.input_tokens, 6);
    assert.equal(result.modelUsage.cache_read, 2);

    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    assert.deepEqual(argv.slice(0, 5), ['--skip-trust', '--output-format', 'json', '--model', 'gemini-2.5-pro']);
    assert.equal(argv.includes('--prompt'), true);

    console.log(JSON.stringify({
      ok: true,
      provider: 'gemini-cli-oauth',
      cli_args_checked: true,
      usage_normalized: true,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.HUB_GEMINI_CLI_ADAPTER_ARGV_FILE;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error('[gemini-cli-oauth-adapter-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
