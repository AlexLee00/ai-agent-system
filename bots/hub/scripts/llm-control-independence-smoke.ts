import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUPPORT_PATH = require.resolve('../../../packages/core/lib/llm-control/tester-support.ts');
const RETIRED_WORKSPACE_SEGMENT = `.open${'claw'}`;

function resetSupportModule() {
  delete require.cache[SUPPORT_PATH];
}

function withEnvPatch(patch: Record<string, string | null>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    resetSupportModule();
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    resetSupportModule();
  }
}

function assertNotRetiredGatewayPath(label: string, value: string) {
  assert(value, `${label} must be set`);
  assert(
    !String(value).includes(`${path.sep}${RETIRED_WORKSPACE_SEGMENT}${path.sep}`),
    `${label} must not default to retired gateway path: ${value}`,
  );
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-llm-control-'));
  const agentHome = path.join(tempRoot, 'agent-home');

  try {
    withEnvPatch({
      AI_AGENT_HOME: agentHome,
      JAY_HOME: null,
      HUB_LLM_CONTROL_DIR: null,
      JAY_LLM_CONTROL_DIR: null,
      HUB_LLM_CONTROL_CONFIG: null,
      HUB_LLM_AUTH_PROFILES_FILE: null,
      HUB_LLM_SPEED_TEST_KEYS_FILE: null,
      OPENAI_API_KEY: null,
    }, () => {
      const support = require('../../../packages/core/lib/llm-control/tester-support.ts');

      assertNotRetiredGatewayPath('LLM_CONTROL_CONFIG', support.LLM_CONTROL_CONFIG);
      assertNotRetiredGatewayPath('AUTH_PROFILES_FILE', support.AUTH_PROFILES_FILE);
      assertNotRetiredGatewayPath('SPEED_TEST_KEYS_FILE', support.SPEED_TEST_KEYS_FILE);

      const models = support.loadModels(fs);
      assert(models.includes('openai/gpt-4o-mini'), 'default Hub-native model catalog should include OpenAI smoke model');
      assert(models.includes('groq/llama-3.3-70b-versatile'), 'default Hub-native model catalog should include Groq smoke model');
      assert.equal(support.loadOpenAIKey(fs), null, 'missing auth profile should not throw or read retired gateway');

      const selected = support.applyFastest(fs, [
        { ok: true, provider: 'gemini-oauth', modelId: 'gemini-oauth/gemini-2.5-flash' },
      ]);
      assert.equal(selected, 'gemini-oauth/gemini-2.5-flash');
      const saved = JSON.parse(fs.readFileSync(support.LLM_CONTROL_CONFIG, 'utf8'));
      assert.equal(saved.agents.defaults.model.primary, 'gemini-oauth/gemini-2.5-flash');
    });

    console.log(JSON.stringify({
      ok: true,
      llm_control_legacy_gateway_free_defaults: true,
      hub_native_model_catalog: true,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    resetSupportModule();
  }
}

main();
