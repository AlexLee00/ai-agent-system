'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

const SHORTFORM_MIN_DURATION_SEC = 15;
const SHORTFORM_MAX_DURATION_SEC = 20;
const SHORTFORM_DEFAULT_DURATION_SEC = 18;

function slugify(text = '') {
  return String(text)
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function pickHook(title = '', category = '') {
  const clean = String(title).trim();
  if (category === '백엔드/개발자 커리어' || /node|백엔드|개발/i.test(clean)) {
    return `이거 모르고 ${clean.slice(0, 18)} 시작하면 손해봅니다`;
  }
  if (category === '최신IT트렌드') {
    return `${clean.slice(0, 20)} 지금 놓치면 감각이 늦습니다`;
  }
  return `${clean.slice(0, 22)} 핵심만 15초 안에 정리합니다`;
}

function normalizeDurationSec(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return SHORTFORM_DEFAULT_DURATION_SEC;
  return Math.min(SHORTFORM_MAX_DURATION_SEC, Math.max(SHORTFORM_MIN_DURATION_SEC, Math.round(num)));
}

function buildOverlayLines(title = '', category = '') {
  const short = String(title).trim();
  if (category === '최신IT트렌드') {
    return [
      '지금 왜 이 얘기가 뜨는지',
      short.slice(0, 24) || '핵심 포인트 요약',
      '블로그 본문에서 바로 확인'
    ];
  }
  if (category === '백엔드/개발자 커리어') {
    return [
      '실무에서 바로 체감되는 포인트',
      short.slice(0, 24) || '개발자 관점 핵심 요약',
      '블로그에서 예시까지 확인'
    ];
  }
  return [
    '핵심만 빠르게 정리',
    short.slice(0, 24) || '오늘의 인사이트',
    '전체 내용은 블로그에서'
  ];
}

function buildStoryboard(title = '', category = '', durationSec = SHORTFORM_DEFAULT_DURATION_SEC) {
  const overlayLines = buildOverlayLines(title, category);
  const safeDurationSec = normalizeDurationSec(durationSec);
  const beatDuration = Number((safeDurationSec / 3).toFixed(2));
  return overlayLines.map((line, index) => ({
    index: index + 1,
    startSec: Number((index * beatDuration).toFixed(2)),
    endSec: index === overlayLines.length - 1
      ? safeDurationSec
      : Number(((index + 1) * beatDuration).toFixed(2)),
    overlay: line,
    motion: index === 0 ? 'slow_zoom_in' : index === 1 ? 'pan_right' : 'slow_zoom_out'
  }));
}

function buildFfmpegPreview({ thumbPath, outputPath, durationSec = SHORTFORM_DEFAULT_DURATION_SEC }) {
  const safeDurationSec = normalizeDurationSec(durationSec);
  const safeInput = JSON.stringify(String(thumbPath));
  const safeOutput = JSON.stringify(String(outputPath));
  return [
    'ffmpeg -y',
    `-loop 1 -i ${safeInput}`,
    `-t ${safeDurationSec}`,
    '-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z=\'min(zoom+0.0008,1.18)\':d=250:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\',fps=25"',
    '-c:v libx264 -pix_fmt yuv420p',
    safeOutput
  ].join(' ');
}

function buildShortformPlan({
  title,
  category,
  thumbPath,
  blogUrl = '',
  durationSec = SHORTFORM_DEFAULT_DURATION_SEC,
  content = ''
}) {
  const safeTitle = String(title || '').trim();
  const safeCategory = String(category || '일반');
  const safeDurationSec = normalizeDurationSec(durationSec);
  const hook = pickHook(safeTitle, safeCategory);
  const storyboard = buildStoryboard(safeTitle, safeCategory, safeDurationSec);
  const slug = slugify(safeTitle || 'blog_shortform');
  const outputDir = path.join(env.PROJECT_ROOT, 'bots/blog/output/shortform');
  const outputPath = path.join(outputDir, `${slug}_reel.mp4`);
  const cta = blogUrl
    ? `자세한 내용은 블로그에서 확인하세요 👉 ${blogUrl}`
    : '자세한 내용은 블로그에서 확인하세요 👉 프로필 링크';

  return {
    title: safeTitle,
    category: safeCategory,
    hook,
    durationSec: safeDurationSec,
    thumbPath,
    outputPath,
    storyboard,
    cta,
    ffmpegPreview: buildFfmpegPreview({ thumbPath, outputPath, durationSec: safeDurationSec }),
    contentSnippet: String(content || '').slice(0, 280),
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildShortformPlan,
  normalizeDurationSec,
  SHORTFORM_MIN_DURATION_SEC,
  SHORTFORM_MAX_DURATION_SEC,
  SHORTFORM_DEFAULT_DURATION_SEC,
};
