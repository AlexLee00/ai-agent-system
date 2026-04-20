'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { normalizeDurationSec, SHORTFORM_DEFAULT_DURATION_SEC } = require('./shortform-planner.ts');

const execFileAsync = promisify(execFile);
const SHORTFORM_WIDTH = 1080;
const SHORTFORM_HEIGHT = 1920;
const SHORTFORM_FPS = 30;
const SHORTFORM_CRF = 18;
const SHORTFORM_PRESET = 'slow';
const SHORTFORM_SAFE_WIDTH = 996;
const SHORTFORM_SAFE_HEIGHT = 1400;

function buildShortformVideoFilter() {
  const bgScale = `scale=${SHORTFORM_WIDTH}:${SHORTFORM_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos`;
  const fgScale = `scale=${SHORTFORM_SAFE_WIDTH}:${SHORTFORM_SAFE_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos`;
  return [
    `[0:v]${bgScale}`,
    `crop=${SHORTFORM_WIDTH}:${SHORTFORM_HEIGHT}`,
    "zoompan=z='min(zoom+0.00035,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30",
    'gblur=sigma=18',
    'eq=brightness=-0.02:saturation=0.92',
    'setsar=1[bg]',
    `[0:v]${fgScale}`,
    'unsharp=5:5:0.8:5:5:0.0',
    "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0",
    'setsar=1[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto',
    'format=yuv420p',
    `fps=${SHORTFORM_FPS}`
  ].join(';');
}

function buildShortformRenderArgs({ thumbPath, outputPath, durationSec }) {
  return [
    '-y',
    '-loop', '1',
    '-i', thumbPath,
    '-t', String(durationSec),
    '-filter_complex', buildShortformVideoFilter(),
    '-c:v', 'libx264',
    '-preset', SHORTFORM_PRESET,
    '-profile:v', 'high',
    '-level:v', '4.2',
    '-crf', String(SHORTFORM_CRF),
    '-movflags', '+faststart',
    '-g', String(SHORTFORM_FPS * 2),
    '-r', String(SHORTFORM_FPS),
    '-maxrate', '12M',
    '-bufsize', '24M',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ];
}

async function renderShortformReel({
  thumbPath,
  outputPath,
  durationSec = SHORTFORM_DEFAULT_DURATION_SEC,
}) {
  if (!thumbPath || !fs.existsSync(thumbPath)) {
    throw new Error(`숏폼 렌더용 썸네일이 없습니다: ${thumbPath}`);
  }

  const safeDurationSec = normalizeDurationSec(durationSec);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = buildShortformRenderArgs({
    thumbPath,
    outputPath,
    durationSec: safeDurationSec,
  });

  try {
    await execFileAsync('ffmpeg', args, {
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const message = error?.stderr || error?.stdout || error?.message || String(error);
    throw new Error(`ffmpeg 숏폼 렌더 실패: ${message}`);
  }

  const stat = fs.statSync(outputPath);
  return {
    outputPath,
    fileSize: stat.size,
    durationSec: safeDurationSec,
    width: SHORTFORM_WIDTH,
    height: SHORTFORM_HEIGHT,
    safeWidth: SHORTFORM_SAFE_WIDTH,
    safeHeight: SHORTFORM_SAFE_HEIGHT,
    fps: SHORTFORM_FPS,
    qualityProfile: `libx264/${SHORTFORM_PRESET}/crf${SHORTFORM_CRF}`,
  };
}

module.exports = {
  buildShortformVideoFilter,
  buildShortformRenderArgs,
  renderShortformReel,
};
