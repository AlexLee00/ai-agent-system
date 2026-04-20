'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

const SHORTFORM_MIN_DURATION_SEC = 15;
const SHORTFORM_MAX_DURATION_SEC = 20;
const SHORTFORM_DEFAULT_DURATION_SEC = 18;
const SHORTFORM_CANVAS = { width: 1080, height: 1920 };
const SHORTFORM_SAFE_ZONE = { width: 996, height: 1400 };

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

function normalizeTitleText(text = '') {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/[!?]+/g, '')
    .trim();
}

function compactTitle(text = '', maxLength = 18) {
  const clean = normalizeTitleText(text)
    .replace(/체크리스트\s*\d+가지/gi, '체크포인트')
    .replace(/가장 먼저 확인할 포인트/gi, '먼저 볼 포인트')
    .replace(/요구사항 정의 전에/gi, '요구사항 전에')
    .replace(/서비스 신뢰를 만드는/gi, '신뢰를 만드는')
    .replace(/상태 설명/gi, '상태 안내')
    .replace(/결제 직전 이탈을 줄이는/gi, '결제 이탈 줄이는')
    .replace(/왜 요즘 /gi, '')
    .replace(/왜 /gi, '')
    .replace(/핵심만 \d+초 안에 정리합니다/gi, '')
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength).trim()}…` : clean;
}

function buildHookLine(title = '', category = '') {
  const clean = normalizeTitleText(title);
  if (category === '홈페이지와App') {
    if (/결제/.test(clean) && /이탈/.test(clean)) return '결제 직전, 여기서 이탈합니다';
    if (/상태/.test(clean) || /설명|안내|UX/.test(clean)) return '신뢰는 화면 설명에서 갈립니다';
    return '앱은 기능보다 흐름이 먼저입니다';
  }
  if (category === '개발기획과컨설팅') {
    if (/요구사항/.test(clean)) return '요구사항 전에 틀어집니다';
    if (/일정/.test(clean)) return '일정은 합의 전제에서 갈립니다';
    return '기획은 기능보다 전제가 먼저입니다';
  }
  if (category === '최신IT트렌드') {
    return '기술보다 흐름을 먼저 보세요';
  }
  if (category === '성장과성공') {
    return '성장은 의지보다 구조가 만듭니다';
  }
  return `${compactTitle(clean, 16)} 지금 놓치면 아쉽습니다`;
}

function buildValueLine(title = '', category = '') {
  const clean = normalizeTitleText(title);
  if (category === '홈페이지와App') {
    if (/결제/.test(clean)) return '버튼보다 망설이는 순간을 보세요';
    if (/상태/.test(clean) || /설명|안내|UX/.test(clean)) return '고장보다 불안한 순간을 줄여야 합니다';
  }
  if (category === '개발기획과컨설팅') {
    if (/요구사항/.test(clean)) return '문서보다 빠진 전제를 먼저 잡으세요';
    if (/일정/.test(clean)) return '일정표보다 기대치 정렬이 먼저입니다';
  }
  if (category === '최신IT트렌드') {
    return '기능보다 덜 흔들리는 구조가 핵심입니다';
  }
  return compactTitle(clean, 22);
}

function buildCtaLine(title = '', category = '') {
  const clean = normalizeTitleText(title);
  if (/체크리스트|\d+가지|포인트/.test(clean)) {
    return '블로그에서 3가지를 바로 확인하세요';
  }
  if (category === '홈페이지와App') return '블로그에서 실제 화면 기준으로 확인';
  if (category === '개발기획과컨설팅') return '블로그에서 실무 예시까지 확인';
  return '전체 내용은 블로그에서 확인';
}

function normalizeDurationSec(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return SHORTFORM_DEFAULT_DURATION_SEC;
  return Math.min(SHORTFORM_MAX_DURATION_SEC, Math.max(SHORTFORM_MIN_DURATION_SEC, Math.round(num)));
}

function buildOverlayLines(title = '', category = '') {
  return [
    buildHookLine(title, category),
    buildValueLine(title, category),
    buildCtaLine(title, category),
  ];
}

function buildStoryboard(title = '', category = '', durationSec = SHORTFORM_DEFAULT_DURATION_SEC) {
  const overlayLines = buildOverlayLines(title, category);
  const safeDurationSec = normalizeDurationSec(durationSec);
  const ratios = [0.28, 0.4, 0.32];
  let cursor = 0;
  return overlayLines.map((line, index) => {
    const span = index === overlayLines.length - 1
      ? Number((safeDurationSec - cursor).toFixed(2))
      : Number((safeDurationSec * ratios[index]).toFixed(2));
    const startSec = Number(cursor.toFixed(2));
    const endSec = index === overlayLines.length - 1
      ? safeDurationSec
      : Number((cursor + span).toFixed(2));
    cursor = endSec;
    return {
      index: index + 1,
      startSec,
      endSec,
      overlay: line,
      style: index === 0 ? 'hook' : index === 1 ? 'value' : 'cta',
      motion: index === 0 ? 'slow_zoom_in' : index === 1 ? 'pan_right' : 'slow_zoom_out'
    };
  });
}

function buildFfmpegPreview({ thumbPath, outputPath, durationSec = SHORTFORM_DEFAULT_DURATION_SEC }) {
  const safeDurationSec = normalizeDurationSec(durationSec);
  const safeInput = JSON.stringify(String(thumbPath));
  const safeOutput = JSON.stringify(String(outputPath));
  return [
    'ffmpeg -y',
    `-loop 1 -i ${safeInput}`,
    `-t ${safeDurationSec}`,
    '-filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos[bgsrc];[bgsrc]crop=1080:1920,zoompan=z=\'min(zoom+0.00035,1.06)\':d=1:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1080x1920:fps=30,gblur=sigma=18,eq=brightness=-0.02:saturation=0.92,setsar=1[bg];[0:v]scale=996:1400:force_original_aspect_ratio=decrease:flags=lanczos,unsharp=5:5:0.8:5:5:0.0,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p,fps=30[vout]"',
    '-map [vout]',
    '-c:v libx264 -preset slow -profile:v high -level:v 4.2 -crf 18 -movflags +faststart -g 60 -r 30 -maxrate 12M -bufsize 24M -pix_fmt yuv420p',
    safeOutput
  ].join(' ');
}

function buildShortformOutputPath(title = '') {
  const slug = slugify(title || 'blog_shortform');
  const outputDir = path.join(env.PROJECT_ROOT, 'bots/blog/output/shortform');
  return path.join(outputDir, `${slug}_reel.mp4`);
}

function buildShortformCta(blogUrl = '') {
  return blogUrl
    ? `자세한 내용은 블로그에서 확인하세요 👉 ${blogUrl}`
    : '자세한 내용은 블로그에서 확인하세요 👉 프로필 링크';
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
  const outputPath = buildShortformOutputPath(safeTitle);
  const cta = buildShortformCta(blogUrl);

  return {
    title: safeTitle,
    category: safeCategory,
    hook,
    durationSec: safeDurationSec,
    thumbPath,
    outputPath,
    storyboard,
    cta,
    canvas: SHORTFORM_CANVAS,
    safeZone: SHORTFORM_SAFE_ZONE,
    overlayCount: storyboard.length,
    ffmpegPreview: buildFfmpegPreview({ thumbPath, outputPath, durationSec: safeDurationSec }),
    contentSnippet: String(content || '').slice(0, 280),
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildShortformPlan,
  buildShortformOutputPath,
  buildShortformCta,
  normalizeDurationSec,
  SHORTFORM_MIN_DURATION_SEC,
  SHORTFORM_MAX_DURATION_SEC,
  SHORTFORM_DEFAULT_DURATION_SEC,
  SHORTFORM_CANVAS,
  SHORTFORM_SAFE_ZONE,
};
