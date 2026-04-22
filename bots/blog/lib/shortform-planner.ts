'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { loadStrategyBundle, normalizeExecutionDirectives } = require('./strategy-loader.ts');

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

function pickHook(title = '', category = '', strategy = null) {
  return buildHookLine(title, category, strategy);
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

function pickVariantIndex(seed = '', count = 1) {
  const safeCount = Math.max(1, Number(count) || 1);
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  }
  return hash % safeCount;
}

function chooseVariant(seed = '', variants = [], fallback = '') {
  if (!Array.isArray(variants) || variants.length === 0) return fallback;
  return variants[pickVariantIndex(seed, variants.length)] || fallback;
}

function buildHookLine(title = '', category = '', strategy = null) {
  const clean = normalizeTitleText(title);
  const directives = normalizeExecutionDirectives(strategy);
  if (directives.creativePolicy.hookStyle === 'scroll_stop') {
    return chooseVariant(clean, [
      `${compactTitle(clean, 15)} 이 한 장면이 갈립니다`,
      `${compactTitle(clean, 15)} 여기서 결과가 나뉩니다`,
      `${compactTitle(clean, 15)} 지금 안 보면 손해입니다`,
    ], `${compactTitle(clean, 15)} 이 한 장면이 갈립니다`);
  }
  if (directives.creativePolicy.hookStyle === 'problem_first') {
    return chooseVariant(clean, [
      `${compactTitle(clean, 15)} 여기서 먼저 막힙니다`,
      `${compactTitle(clean, 15)} 이 지점에서 흔들립니다`,
      `${compactTitle(clean, 15)} 보통 여기서 놓칩니다`,
    ], `${compactTitle(clean, 15)} 여기서 먼저 막힙니다`);
  }
  if (category === '홈페이지와App') {
    if (/결제/.test(clean) && /이탈/.test(clean)) {
      return chooseVariant(clean, [
        '결제 직전, 여기서 이탈합니다',
        '결제는 버튼 앞에서 멈춥니다',
        '결제 직전 이 한 장면이 갈립니다',
      ], '결제 직전, 여기서 이탈합니다');
    }
    if (/상태/.test(clean) || /설명|안내|UX/.test(clean)) {
      return chooseVariant(clean, [
        '신뢰는 화면 설명에서 갈립니다',
        '상태 안내가 신뢰를 만듭니다',
        '고장보다 설명 부족이 더 치명적입니다',
      ], '신뢰는 화면 설명에서 갈립니다');
    }
    return chooseVariant(clean, [
      '앱은 기능보다 흐름이 먼저입니다',
      '좋은 앱은 설명부터 다릅니다',
      '사용자는 속도보다 확신을 먼저 봅니다',
    ], '앱은 기능보다 흐름이 먼저입니다');
  }
  if (category === '개발기획과컨설팅') {
    if (/요구사항/.test(clean)) {
      return chooseVariant(clean, [
        '요구사항 전에 틀어집니다',
        '문서는 맞아도 전제가 틀릴 수 있습니다',
        '개발은 시작 전에 이미 어긋납니다',
      ], '요구사항 전에 틀어집니다');
    }
    if (/일정/.test(clean)) {
      return chooseVariant(clean, [
        '일정은 합의 전제에서 갈립니다',
        '일정표보다 기대치가 먼저입니다',
        '일정 흔들림은 시작 전에 보입니다',
      ], '일정은 합의 전제에서 갈립니다');
    }
    return chooseVariant(clean, [
      '기획은 기능보다 전제가 먼저입니다',
      '좋은 제안보다 빠진 조건이 더 큽니다',
      '기획은 아이디어보다 합의가 먼저입니다',
    ], '기획은 기능보다 전제가 먼저입니다');
  }
  if (category === '최신IT트렌드') {
    return chooseVariant(clean, [
      '기술보다 흐름을 먼저 보세요',
      '트렌드는 기능보다 방향이 중요합니다',
      '새 기술은 구조부터 봐야 덜 흔들립니다',
    ], '기술보다 흐름을 먼저 보세요');
  }
  if (category === '성장과성공') {
    return chooseVariant(clean, [
      '성장은 의지보다 구조가 만듭니다',
      '버티는 힘은 루틴에서 나옵니다',
      '결과는 열정보다 설계가 만듭니다',
    ], '성장은 의지보다 구조가 만듭니다');
  }
  return `${compactTitle(clean, 16)} 지금 놓치면 아쉽습니다`;
}

function buildValueLine(title = '', category = '', strategy = null) {
  const clean = normalizeTitleText(title);
  const directives = normalizeExecutionDirectives(strategy);
  if (directives.titlePolicy.tone === 'conversion') {
    return chooseVariant(clean, [
      '지금 적용하면 전환 손실을 줄일 수 있습니다',
      '이 포인트를 바꾸면 문의 흐름이 달라집니다',
      '망설임 구간을 줄이면 반응이 달라집니다',
    ], '지금 적용하면 전환 손실을 줄일 수 있습니다');
  }
  if (category === '홈페이지와App') {
    if (/결제/.test(clean)) {
      return chooseVariant(clean, [
        '버튼보다 망설이는 순간을 보세요',
        '기능보다 망설임 구간이 더 중요합니다',
        '이탈은 클릭보다 직전에 쌓입니다',
      ], '버튼보다 망설이는 순간을 보세요');
    }
    if (/상태/.test(clean) || /설명|안내|UX/.test(clean)) {
      return chooseVariant(clean, [
        '고장보다 불안한 순간을 줄여야 합니다',
        '사용자는 오류보다 모호함에 더 흔들립니다',
        '지금 무슨 일인지 알게 해줘야 남습니다',
      ], '고장보다 불안한 순간을 줄여야 합니다');
    }
  }
  if (category === '개발기획과컨설팅') {
    if (/요구사항/.test(clean)) {
      return chooseVariant(clean, [
        '문서보다 빠진 전제를 먼저 잡으세요',
        '요구사항보다 해석 차이를 먼저 줄여야 합니다',
        '정의보다 전제 정리가 먼저입니다',
      ], '문서보다 빠진 전제를 먼저 잡으세요');
    }
    if (/일정/.test(clean)) {
      return chooseVariant(clean, [
        '일정표보다 기대치 정렬이 먼저입니다',
        '계획보다 합의 기준을 먼저 맞춰야 합니다',
        '일정은 숫자보다 기대치에서 흔들립니다',
      ], '일정표보다 기대치 정렬이 먼저입니다');
    }
  }
  if (category === '최신IT트렌드') {
    return chooseVariant(clean, [
      '기능보다 덜 흔들리는 구조가 핵심입니다',
      '새로움보다 오래 버티는 설계가 중요합니다',
      '트렌드는 화려함보다 지속성이 갈립니다',
    ], '기능보다 덜 흔들리는 구조가 핵심입니다');
  }
  if (category === '성장과성공') {
    return chooseVariant(clean, [
      '성과는 몰입보다 반복 구조에서 나옵니다',
      '압박이 클수록 우선순위 설계가 중요합니다',
      '속도보다 계속 가는 리듬을 먼저 만드세요',
    ], compactTitle(clean, 22));
  }
  return compactTitle(clean, 22);
}

function buildCtaLine(title = '', category = '', strategy = null) {
  const clean = normalizeTitleText(title);
  const directives = normalizeExecutionDirectives(strategy);
  if (directives.creativePolicy.ctaStyle === 'conversion') {
    return chooseVariant(clean, [
      '블로그에서 체크하고 바로 예약 흐름까지 보세요',
      '본문에서 적용 포인트와 문의 흐름을 확인하세요',
      '블로그에서 전환 포인트를 바로 확인하세요',
    ], '블로그에서 체크하고 바로 예약 흐름까지 보세요');
  }
  if (directives.creativePolicy.ctaStyle === 'engagement') {
    return chooseVariant(clean, [
      '저장해두고 블로그에서 전체 맥락을 보세요',
      '공유해두고 블로그에서 실전 포인트를 보세요',
      '블로그에서 전체 전략을 이어서 확인하세요',
    ], '저장해두고 블로그에서 전체 맥락을 보세요');
  }
  if (/체크리스트|\d+가지|포인트/.test(clean)) {
    return chooseVariant(clean, [
      '블로그에서 3가지를 바로 확인하세요',
      '본문에서 체크포인트를 바로 확인하세요',
      '블로그에서 바로 적용할 포인트를 보세요',
    ], '블로그에서 3가지를 바로 확인하세요');
  }
  if (category === '홈페이지와App') {
    return chooseVariant(clean, [
      '블로그에서 실제 화면 기준으로 확인',
      '본문에서 실제 UX 포인트를 확인하세요',
      '블로그에서 바로 적용할 화면 기준을 보세요',
    ], '블로그에서 실제 화면 기준으로 확인');
  }
  if (category === '개발기획과컨설팅') {
    return chooseVariant(clean, [
      '블로그에서 실무 예시까지 확인',
      '본문에서 실무 기준으로 바로 확인',
      '블로그에서 합의 포인트를 더 확인하세요',
    ], '블로그에서 실무 예시까지 확인');
  }
  return chooseVariant(clean, [
    '전체 내용은 블로그에서 확인',
    '본문에서 더 자세히 확인하세요',
    '블로그에서 핵심 내용을 이어서 보세요',
  ], '전체 내용은 블로그에서 확인');
}

function normalizeDurationSec(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return SHORTFORM_DEFAULT_DURATION_SEC;
  return Math.min(SHORTFORM_MAX_DURATION_SEC, Math.max(SHORTFORM_MIN_DURATION_SEC, Math.round(num)));
}

function buildOverlayLines(title = '', category = '', strategy = null) {
  return [
    buildHookLine(title, category, strategy),
    buildValueLine(title, category, strategy),
    buildCtaLine(title, category, strategy),
  ];
}

function buildStoryboard(title = '', category = '', durationSec = SHORTFORM_DEFAULT_DURATION_SEC, strategy = null) {
  const overlayLines = buildOverlayLines(title, category, strategy);
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

function buildShortformCta(blogUrl = '', strategy = null) {
  const directives = normalizeExecutionDirectives(strategy);
  if (directives.creativePolicy.ctaStyle === 'conversion') {
    return blogUrl
      ? `자세한 적용 포인트와 예약 전환 흐름은 블로그에서 확인하세요 👉 ${blogUrl}`
      : '자세한 적용 포인트와 예약 전환 흐름은 블로그에서 확인하세요 👉 프로필 링크';
  }
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
  content = '',
  strategy = null,
}) {
  const plan = strategy || loadStrategyBundle().plan;
  const safeTitle = String(title || '').trim();
  const safeCategory = String(category || '일반');
  const safeDurationSec = normalizeDurationSec(durationSec);
  const hook = pickHook(safeTitle, safeCategory, plan);
  const storyboard = buildStoryboard(safeTitle, safeCategory, safeDurationSec, plan);
  const outputPath = buildShortformOutputPath(safeTitle);
  const cta = buildShortformCta(blogUrl, plan);

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
    strategyExecution: normalizeExecutionDirectives(plan),
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
