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
const QA_SHEET_WIDTH = 1440;
const QA_SHEET_HEIGHT = 1920;

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

function buildShortformCoverArgs({ inputPath, outputPath, captureSec = 1.2 }) {
  return [
    '-y',
    '-ss', String(captureSec),
    '-i', inputPath,
    '-frames:v', '1',
    '-q:v', '2',
    outputPath,
  ];
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

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildQaSheetSvg({ title = '', hook = '', cta = '', outputPath = '' } = {}) {
  const safeTitle = escapeHtml(title);
  const safeHook = escapeHtml(hook || '첫 훅 미리보기');
  const safeCta = escapeHtml(cta || 'CTA 없음');
  const safeFile = escapeHtml(path.basename(outputPath || 'reel.mp4'));
  return `
  <svg width="${QA_SHEET_WIDTH}" height="${QA_SHEET_HEIGHT}" viewBox="0 0 ${QA_SHEET_WIDTH} ${QA_SHEET_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGradient" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#0b1020" />
        <stop offset="100%" stop-color="#141a2f" />
      </linearGradient>
      <linearGradient id="cardGradient" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,0.12)" />
        <stop offset="100%" stop-color="rgba(255,255,255,0.04)" />
      </linearGradient>
    </defs>
    <rect width="${QA_SHEET_WIDTH}" height="${QA_SHEET_HEIGHT}" fill="url(#bgGradient)" />
    <rect x="48" y="48" width="${QA_SHEET_WIDTH - 96}" height="${QA_SHEET_HEIGHT - 96}" rx="42" ry="42" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="2" />
    <text x="84" y="118" fill="#ffd666" font-size="34" font-weight="700" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">Instagram Reel QA Sheet</text>
    <text x="84" y="164" fill="rgba(255,255,255,0.82)" font-size="26" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">${safeFile}</text>

    <rect x="84" y="214" width="600" height="1068" rx="28" ry="28" fill="url(#cardGradient)" stroke="rgba(255,255,255,0.1)" stroke-width="2" />
    <text x="116" y="266" fill="#ffffff" font-size="28" font-weight="700" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">Reel Thumb</text>
    <rect x="756" y="214" width="600" height="1068" rx="28" ry="28" fill="url(#cardGradient)" stroke="rgba(255,255,255,0.1)" stroke-width="2" />
    <text x="788" y="266" fill="#ffffff" font-size="28" font-weight="700" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">Reel Cover</text>

    <rect x="84" y="1328" width="${QA_SHEET_WIDTH - 168}" height="510" rx="32" ry="32" fill="rgba(9,12,20,0.72)" stroke="rgba(255,255,255,0.08)" stroke-width="2" />
    <text x="124" y="1398" fill="#85dcff" font-size="24" font-weight="700" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">Title</text>
    <text x="124" y="1450" fill="#ffffff" font-size="42" font-weight="800" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">${safeTitle}</text>
    <text x="124" y="1546" fill="#ffd666" font-size="24" font-weight="700" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">Hook</text>
    <text x="124" y="1598" fill="#ffffff" font-size="34" font-weight="700" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">${safeHook}</text>
    <text x="124" y="1688" fill="#85dcff" font-size="24" font-weight="700" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">CTA</text>
    <text x="124" y="1740" fill="rgba(255,255,255,0.9)" font-size="30" font-weight="600" font-family="Apple SD Gothic Neo, Helvetica Neue, sans-serif">${safeCta}</text>
  </svg>`;
}

async function buildReelQaSheet({ thumbPath, coverPath, outputPath, title = '', hook = '', cta = '' }) {
  const qaSheetPath = outputPath.replace(/\.mp4$/i, '_qa.jpg');
  const svg = buildQaSheetSvg({ title, hook, cta, outputPath });
  const base = sharp({
    create: {
      width: QA_SHEET_WIDTH,
      height: QA_SHEET_HEIGHT,
      channels: 4,
      background: '#0b1020',
    },
  }).composite([
    { input: Buffer.from(svg), left: 0, top: 0 },
    { input: await sharp(thumbPath).resize(536, 952, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer(), left: 116, top: 300 },
    { input: await sharp(coverPath).resize(536, 952, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer(), left: 788, top: 300 },
  ]);
  await base.jpeg({ quality: 92 }).toFile(qaSheetPath);
  return qaSheetPath;
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
  title = '',
  hook = '',
  cta = '',
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
  const coverPath = outputPath.replace(/\.mp4$/i, '_cover.jpg');
  try {
    await execFileAsync('ffmpeg', buildShortformCoverArgs({
      inputPath: outputPath,
      outputPath: coverPath,
      captureSec: Math.min(1.2, Math.max(0.4, safeDurationSec / 6)),
    }), {
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const message = error?.stderr || error?.stdout || error?.message || String(error);
    throw new Error(`릴스 커버 추출 실패: ${message}`);
  }
  let qaSheetPath = '';
  try {
    qaSheetPath = await buildReelQaSheet({
      thumbPath,
      coverPath,
      outputPath,
      title,
      hook,
      cta,
    });
  } catch (error) {
    const message = error?.message || String(error);
    throw new Error(`릴스 QA 시트 생성 실패: ${message}`);
  }

  return {
    outputPath,
    coverPath,
    qaSheetPath,
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
  buildShortformCoverArgs,
  renderShortformReel,
};
