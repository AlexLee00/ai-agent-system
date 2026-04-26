import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { describeLLMSelector, selectLLMChain } = require('../../../packages/core/lib/llm-model-selector.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VIDEO_CONFIG_PATH = path.join(REPO_ROOT, 'bots/video/config/video-config.yaml');

const REQUIRED_VIDEO_SELECTORS = [
  'video.step-proposal',
  'video.critic',
  'video.subtitle-correction',
  'video.scene-indexer',
  'video.narration-analyzer',
  'video.refiner',
  'video.intro-outro',
];

function main() {
  const configText = fs.readFileSync(VIDEO_CONFIG_PATH, 'utf8');
  assert(!/^\s*llm_provider\s*:/m.test(configText), 'video config must not pin llm_provider directly');
  assert(!/^\s*llm_model\s*:/m.test(configText), 'video config must not pin llm_model directly');
  assert(!/^\s*red_model\s*:/m.test(configText), 'video config must not pin red_model directly');

  const selectors = REQUIRED_VIDEO_SELECTORS.map((key) => {
    const chain = selectLLMChain(key);
    assert(chain.length > 0, `${key} must resolve to a non-empty Hub-managed chain`);
    assert(chain.every((entry: any) => entry.provider && entry.model), `${key} chain entries must include provider/model`);
    const description = describeLLMSelector(key);
    assert.equal(description.kind, 'chain', `${key} must describe a chain`);
    return {
      key,
      primary_provider: chain[0].provider,
      primary_model: chain[0].model,
      fallback_count: Math.max(0, chain.length - 1),
    };
  });

  console.log(JSON.stringify({
    ok: true,
    config_openclaw_free: true,
    direct_model_pins: false,
    selectors,
  }));
}

main();
