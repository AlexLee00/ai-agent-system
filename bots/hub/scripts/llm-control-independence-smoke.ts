import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUPPORT_PATH = require.resolve('../../../packages/core/lib/llm-control/tester-support.ts');
const ROOT = path.resolve(__dirname, '../../..');
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
      assert.equal(models.some((model: string) => model.includes('gemini')), false, 'retired Gemini models must be excluded from speed tests');
      assert.equal(support.loadOpenAIKey(fs), null, 'missing auth profile should not throw or read retired gateway');

      const selected = support.applyFastest(fs, [
        { ok: true, provider: 'gemini-cli-oauth', modelId: 'gemini-cli-oauth/gemini-2.5-flash' },
        { ok: true, provider: 'groq', modelId: 'groq/llama-3.1-8b-instant' },
      ]);
      assert.equal(selected, 'groq/llama-3.1-8b-instant');
      const saved = JSON.parse(fs.readFileSync(support.LLM_CONTROL_CONFIG, 'utf8'));
      assert.equal(saved.agents.defaults.model.primary, 'groq/llama-3.1-8b-instant');
    });

    const speedHome = path.join(tempRoot, 'missing-speed-home');
    const speedWorkspace = path.join(tempRoot, 'missing-speed-workspace');
    const speedRun = spawnSync(
      path.join(ROOT, 'node_modules/.bin/tsx'),
      ['scripts/speed-test.ts', '--runs=1', '--model=gemini-2.5-flash-lite'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          AI_AGENT_HOME: speedHome,
          AI_AGENT_WORKSPACE: speedWorkspace,
          HUB_LLM_CONTROL_DIR: path.join(speedHome, 'llm-control'),
          HUB_LLM_CONTROL_CONFIG: path.join(speedHome, 'llm-control', 'missing-models.json'),
          HUB_LLM_AUTH_PROFILES_FILE: path.join(speedHome, 'llm-control', 'missing-auth-profiles.json'),
          HUB_LLM_SPEED_TEST_KEYS_FILE: path.join(speedHome, 'llm-control', 'missing-speed-test-keys.json'),
          HUB_ENABLE_OPENAI_PUBLIC_API: 'false',
        },
      },
    );
    assert.equal(speedRun.status, 0, `speed-test should skip missing llm-control config without failing: ${speedRun.stderr || speedRun.stdout}`);
    assert.match(speedRun.stdout, /속도 테스트 스킵|실행 가능한 모델\/인증/);

    console.log(JSON.stringify({
      ok: true,
      llm_control_legacy_gateway_free_defaults: true,
      hub_native_model_catalog: true,
      missing_control_speed_test_skip: true,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    resetSupportModule();
  }
}

main();
