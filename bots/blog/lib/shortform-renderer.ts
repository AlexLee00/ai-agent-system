'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const { normalizeDurationSec, SHORTFORM_DEFAULT_DURATION_SEC } = require('./shortform-planner.ts');

const execFileAsync = promisify(execFile);
const SHORTFORM_WIDTH = 1080;
const SHORTFORM_HEIGHT = 1920;
const SHORTFORM_FPS = 30;
const SHORTFORM_CRF = 18;
const SHORTFORM_PRESET = 'slow';
const SHORTFORM_SAFE_WIDTH = 996;
const SHORTFORM_SAFE_HEIGHT = 1400;
const SHORTFORM_OVERLAY_DIR = path.join(os.tmpdir(), 'blog-shortform-overlays');

function escapeFilterPath(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function buildShortformVideoFilter(overlaySpecs = []) {
  const bgScale = `scale=${SHORTFORM_WIDTH}:${SHORTFORM_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos`;
  const fgScale = `scale=${SHORTFORM_SAFE_WIDTH}:${SHORTFORM_SAFE_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos`;
  const chain = [
    `[0:v]${bgScale}[bgsrc]`,
    `[bgsrc]crop=${SHORTFORM_WIDTH}:${SHORTFORM_HEIGHT},zoompan=z='min(zoom+0.00035,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,gblur=sigma=18,eq=brightness=-0.02:saturation=0.92,setsar=1[bg]`,
    `[0:v]${fgScale},unsharp=5:5:0.8:5:5:0.0,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p,fps=${SHORTFORM_FPS}[basev]`,
  ];

  let current = 'basev';
  overlaySpecs.forEach((spec, index) => {
    const inputIndex = index + 1;
    const next = index === overlaySpecs.length - 1 ? 'vout' : `vtxt${index + 1}`;
    chain.push(
      `[${current}][${inputIndex}:v]overlay=0:0:enable='between(t,${spec.startSec},${spec.endSec})'[${next}]`
    );
    current = next;
  });

  if (overlaySpecs.length === 0) {
    chain.push('[basev]copy[vout]');
  }

  return chain.join(';');
}

function buildShortformRenderArgs({ thumbPath, outputPath, durationSec, overlaySpecs = [] }) {
  const args = [
    '-y',
    '-loop', '1',
    '-i', thumbPath,
  ];

  overlaySpecs.forEach((spec) => {
    args.push('-loop', '1', '-i', spec.overlayPath);
  });

  args.push(
    '-t', String(durationSec),
    '-filter_complex', buildShortformVideoFilter(overlaySpecs),
    '-map', '[vout]',
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
  );

  return args;
}

function getOverlayStyle(style = 'value') {
  if (style === 'hook') {
    return {
      fontSize: 74,
      y: 176,
      rectY: 120,
      rectHeight: 210,
      boxColor: 'rgba(10,10,10,0.46)',
    };
  }
  if (style === 'cta') {
    return {
      fontSize: 56,
      y: 1390,
      rectY: 1338,
      rectHeight: 168,
      boxColor: 'rgba(14,14,14,0.34)',
    };
  }
  return {
    fontSize: 62,
    y: 320,
    rectY: 266,
    rectHeight: 188,
    boxColor: 'rgba(10,10,10,0.38)',
  };
}

function buildOverlaySvg(text = '', style = 'value') {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const visual = getOverlayStyle(style);
  return `
  <svg width="${SHORTFORM_WIDTH}" height="${SHORTFORM_HEIGHT}" viewBox="0 0 ${SHORTFORM_WIDTH} ${SHORTFORM_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <style>
      .title {
        font-family: "Apple SD Gothic Neo", "Helvetica Neue", sans-serif;
        font-size: ${visual.fontSize}px;
        font-weight: 800;
        fill: #ffffff;
      }
      .shadow {
        fill: rgba(0,0,0,0.45);
      }
    </style>
    <rect x="80" y="${visual.rectY}" rx="36" ry="36" width="920" height="${visual.rectHeight}" fill="${visual.boxColor}" />
    <text class="shadow" x="540" y="${visual.y + 6}" text-anchor="middle">${escaped}</text>
    <text class="title" x="540" y="${visual.y}" text-anchor="middle">${escaped}</text>
  </svg>`;
}

async function prepareStoryboardOverlays(storyboard = [], outputPath = '') {
  const steps = Array.isArray(storyboard) ? storyboard.filter((step) => step && step.overlay) : [];
  if (steps.length === 0) return [];

  fs.mkdirSync(SHORTFORM_OVERLAY_DIR, { recursive: true });
  const baseName = path.basename(outputPath || 'reel', path.extname(outputPath || ''));
  const overlaySpecs = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const overlayPath = path.join(SHORTFORM_OVERLAY_DIR, `${baseName}_overlay_${index + 1}.png`);
    const svg = buildOverlaySvg(step.overlay || '', step.style || 'value');
    await sharp(Buffer.from(svg)).png().toFile(overlayPath);
    overlaySpecs.push({
      overlayPath,
      startSec: Number.isFinite(Number(step.startSec)) ? Number(step.startSec) : 0,
      endSec: Number.isFinite(Number(step.endSec)) ? Number(step.endSec) : 6,
    });
  }

  return overlaySpecs;
}

async function renderShortformReel({
  thumbPath,
  outputPath,
  durationSec = SHORTFORM_DEFAULT_DURATION_SEC,
  storyboard = [],
}) {
  if (!thumbPath || !fs.existsSync(thumbPath)) {
    throw new Error(`숏폼 렌더용 썸네일이 없습니다: ${thumbPath}`);
  }

  const safeDurationSec = normalizeDurationSec(durationSec);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const overlaySpecs = await prepareStoryboardOverlays(storyboard, outputPath);
  const args = buildShortformRenderArgs({
    thumbPath,
    outputPath,
    durationSec: safeDurationSec,
    overlaySpecs,
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
    overlays: overlaySpecs.length,
  };
}

module.exports = {
  buildShortformVideoFilter,
  buildShortformRenderArgs,
  renderShortformReel,
};
