// @ts-nocheck
'use strict';

const path = require('path');

const { loadConfig } = require('../src/index');
const { analyzeNarration, buildOfflineNarrationFixture } = require('../lib/narration-analyzer');

function parseArgs(argv) {
  const parsed = { sourceAudio: null, allowOfflineFixture: true };
  for (const arg of argv) {
    if (arg.startsWith('--source-audio=')) {
      parsed.sourceAudio = arg.slice('--source-audio='.length);
    }
    if (arg === '--no-offline-fixture') {
      parsed.allowOfflineFixture = false;
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sourceAudio) {
    throw new Error('--source-audio는 필수입니다.');
  }
  const config = loadConfig();
  const sourceAudio = path.resolve(args.sourceAudio);
  let result;
  try {
    result = await analyzeNarration(sourceAudio, config, { correct: true });
  } catch (error) {
    if (!args.allowOfflineFixture) throw error;
    console.warn('[video] test-narration-analyzer 오프라인 fixture fallback:', error.message);
    result = await buildOfflineNarrationFixture(sourceAudio);
  }
  console.log(JSON.stringify({
    source_audio: result.source_audio,
    duration_s: result.duration_s,
    total_entries: result.total_entries,
    total_segments: result.total_segments,
    output_path: result.output_path,
    offline_fixture: Boolean(result.offline_fixture),
    first_segment: result.segments?.[0] || null,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[video] test-narration-analyzer 실패:', error.message);
    process.exit(1);
  });
}
