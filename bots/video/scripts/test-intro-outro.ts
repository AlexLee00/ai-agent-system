// @ts-nocheck
'use strict';

const path = require('path');

const { loadConfig } = require('../src/index');
const { processIntroOutro } = require('../lib/intro-outro-handler');

async function main() {
  const config = loadConfig();
  const tempDir = path.join(config.paths.temp, `run-intro-outro-test-${Date.now()}`);
  const result = await processIntroOutro(config, {
    intro: {
      mode: 'prompt',
      prompt: '테스트 인트로 3초 + 제목 페이드인',
      durationSec: 3,
      title: '테스트 인트로',
    },
    outro: {
      mode: 'prompt',
      prompt: '구독 CTA 5초',
      durationSec: 5,
      title: '테스트 아웃트로',
    },
    targetWidth: Number(config.ffmpeg.render_width || 2560),
    targetHeight: Number(config.ffmpeg.render_height || 1440),
    targetFps: Number(config.ffmpeg.render_fps || 60),
    tempDir,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[video] test-intro-outro 실패:', error.message);
    process.exit(1);
  });
}
