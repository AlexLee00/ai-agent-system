// @ts-nocheck
'use strict';

const path = require('path');

const { loadConfig } = require('../src/index');
const { indexVideo } = require('../lib/scene-indexer');

function parseArgs(argv) {
  const parsed = { sourceVideo: null, ocrEngine: 'cli' };
  for (const arg of argv) {
    if (arg.startsWith('--source-video=')) {
      parsed.sourceVideo = arg.slice('--source-video='.length);
    }
    if (arg.startsWith('--ocr-engine=')) {
      parsed.ocrEngine = arg.slice('--ocr-engine='.length) || 'cli';
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sourceVideo) {
    throw new Error('--source-video는 필수입니다.');
  }
  const config = loadConfig();
  const result = await indexVideo(path.resolve(args.sourceVideo), config, { ocrEngine: args.ocrEngine });
  console.log(JSON.stringify({
    source_video: result.source_video,
    duration_s: result.duration_s,
    total_frames_captured: result.total_frames_captured,
    unique_frames: result.unique_frames,
    scene_count: Array.isArray(result.scenes) ? result.scenes.length : 0,
    output_path: result.output_path,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[video] test-scene-indexer 실패:', error.message);
    process.exit(1);
  });
}
