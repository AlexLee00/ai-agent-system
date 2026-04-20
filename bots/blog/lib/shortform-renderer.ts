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
const OVERLAY_FADE_IN_SEC = 0.24;
const OVERLAY_FADE_OUT_SEC = 0.28;

function escapeFilterPath(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function buildMotionOverlayExpressions(storyboard = []) {
  const steps = Array.isArray(storyboard) ? storyboard.filter((step) => step && Number.isFinite(Number(step.startSec)) && Number.isFinite(Number(step.endSec))) : [];
  const xTerms = [];
  const yTerms = [];

  for (const step of steps) {
    const start = Number(step.startSec);
    const end = Number(step.endSec);
    const span = Math.max(0.4, end - start);
    const motion = String(step.motion || '');
    if (motion === 'pan_right') {
      xTerms.push(`if(between(t\\,${start}\\,${end})\\,((-18)+((t-${start})/${span})*36)\\,0)`);
    } else if (motion === 'slow_zoom_out') {
      yTerms.push(`if(between(t\\,${start}\\,${end})\\,(-10+((t-${start})/${span})*20)\\,0)`);
    } else if (motion === 'slow_zoom_in') {
      yTerms.push(`if(between(t\\,${start}\\,${end})\\,(8-((t-${start})/${span})*16)\\,0)`);
    }
  }

  const xExpr = xTerms.length ? `(${xTerms.join('+')})` : '0';
  const yExpr = yTerms.length ? `(${yTerms.join('+')})` : '0';
  return { xExpr, yExpr };
}

function buildShortformVideoFilter(overlaySpecs = [], storyboard = []) {
  const bgScale = `scale=${SHORTFORM_WIDTH}:${SHORTFORM_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos`;
  const fgScale = `scale=${SHORTFORM_SAFE_WIDTH}:${SHORTFORM_SAFE_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos`;
  const motionExpr = buildMotionOverlayExpressions(storyboard);
  const chain = [
    `[0:v]${bgScale}[bgsrc]`,
    `[bgsrc]crop=${SHORTFORM_WIDTH}:${SHORTFORM_HEIGHT},zoompan=z='min(zoom+0.00035,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,gblur=sigma=18,eq=brightness=-0.02:saturation=0.92,setsar=1[bg]`,
    `[0:v]${fgScale},unsharp=5:5:0.8:5:5:0.0,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1[fg]`,
    `[bg][fg]overlay=x='(W-w)/2+${motionExpr.xExpr}':y='(H-h)/2+${motionExpr.yExpr}':format=auto,format=yuv420p,fps=${SHORTFORM_FPS}[basev]`,
  ];

  let current = 'basev';
  overlaySpecs.forEach((spec, index) => {
    const inputIndex = index + 1;
    const prepared = `ovr${index + 1}`;
    const next = index === overlaySpecs.length - 1 ? 'vout' : `vtxt${index + 1}`;
    const span = Math.max(0.4, Number(spec.endSec) - Number(spec.startSec));
    const fadeIn = Math.min(OVERLAY_FADE_IN_SEC, Math.max(0.08, span / 3));
    const fadeOut = Math.min(OVERLAY_FADE_OUT_SEC, Math.max(0.08, span / 3));
    const fadeOutStart = Math.max(0, span - fadeOut);
    chain.push(
      `[${inputIndex}:v]format=rgba,fade=t=in:st=0:d=${fadeIn}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeOut}:alpha=1[${prepared}]`
    );
    chain.push(
      `[${current}][${prepared}]overlay=0:0:enable='between(t,${spec.startSec},${spec.endSec})'[${next}]`
    );
    current = next;
  });

  if (overlaySpecs.length === 0) {
    chain.push('[basev]copy[vout]');
  }

  return chain.join(';');
}

function buildShortformRenderArgs({ thumbPath, outputPath, durationSec, overlaySpecs = [], storyboard = [] }) {
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
    '-filter_complex', buildShortformVideoFilter(overlaySpecs, storyboard),
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
      boxStart: 'rgba(8,8,12,0.72)',
      boxEnd: 'rgba(18,18,28,0.44)',
      accent: 'rgba(255,214,102,0.95)',
      glow: 'rgba(255,214,102,0.18)',
      maxCharsPerLine: 14,
    };
  }
  if (style === 'cta') {
    return {
      fontSize: 56,
      y: 1390,
      rectY: 1338,
      rectHeight: 168,
      boxStart: 'rgba(10,16,22,0.54)',
      boxEnd: 'rgba(10,10,16,0.30)',
      accent: 'rgba(133,220,255,0.9)',
      glow: 'rgba(133,220,255,0.14)',
      maxCharsPerLine: 20,
    };
  }
  return {
    fontSize: 62,
    y: 320,
    rectY: 266,
    rectHeight: 188,
    boxStart: 'rgba(12,12,18,0.62)',
    boxEnd: 'rgba(18,18,24,0.34)',
    accent: 'rgba(255,255,255,0.75)',
    glow: 'rgba(255,255,255,0.10)',
    maxCharsPerLine: 17,
  };
}

function wrapOverlayText(text = '', maxCharsPerLine = 16) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  if (clean.length <= maxCharsPerLine) return [clean];

  const words = clean.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharsPerLine || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);

  if (lines.length <= 2) return lines;

  const merged = [lines[0], lines.slice(1).join(' ')];
  if (merged[1].length > maxCharsPerLine + 6) {
    merged[1] = `${merged[1].slice(0, maxCharsPerLine + 3).trim()}…`;
  }
  return merged;
}

function buildOverlaySvg(text = '', style = 'value') {
  const visual = getOverlayStyle(style);
  const lines = wrapOverlayText(text, visual.maxCharsPerLine);
  const lineHeight = Math.round(visual.fontSize * 1.2);
  const paddingY = 38;
  const dynamicRectHeight = Math.max(visual.rectHeight, (paddingY * 2) + (lines.length * lineHeight));
  const baselineOffset = visual.rectY + Math.round((dynamicRectHeight - ((lines.length - 1) * lineHeight)) / 2);
  const tspanYValues = lines.map((_, index) => baselineOffset + (index * lineHeight));
  const shadowSpans = lines.map((line, index) => {
    const escaped = String(line)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<tspan x="540" y="${tspanYValues[index] + 6}">${escaped}</tspan>`;
  }).join('');
  const titleSpans = lines.map((line, index) => {
    const escaped = String(line)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<tspan x="540" y="${tspanYValues[index]}">${escaped}</tspan>`;
  }).join('');
  return `
  <svg width="${SHORTFORM_WIDTH}" height="${SHORTFORM_HEIGHT}" viewBox="0 0 ${SHORTFORM_WIDTH} ${SHORTFORM_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="boxGradient" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${visual.boxStart}" />
        <stop offset="100%" stop-color="${visual.boxEnd}" />
      </linearGradient>
      <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="18" result="blurred" />
      </filter>
    </defs>
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
    <rect x="112" y="${visual.rectY + 18}" rx="42" ry="42" width="856" height="${dynamicRectHeight - 12}" fill="${visual.glow}" filter="url(#softGlow)" />
    <rect x="80" y="${visual.rectY}" rx="36" ry="36" width="920" height="${dynamicRectHeight}" fill="url(#boxGradient)" />
    <rect x="120" y="${visual.rectY + 18}" rx="6" ry="6" width="180" height="10" fill="${visual.accent}" opacity="0.95" />
    <rect x="80" y="${visual.rectY}" rx="36" ry="36" width="920" height="${dynamicRectHeight}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2" />
    <text class="shadow" x="540" y="${visual.y + 6}" text-anchor="middle">${shadowSpans}</text>
    <text class="title" x="540" y="${visual.y}" text-anchor="middle">${titleSpans}</text>
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
    storyboard,
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
