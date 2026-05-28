// @ts-nocheck
'use strict';

const REASONING_TAG_RE = /<\s*\/?\s*(?:think|thinking|analysis|reasoning)\b[^>]*>/i;
const COMPLETE_REASONING_BLOCK_RE = /<\s*(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const LEAK_PATTERNS = [
  { key: 'reasoning_tag', re: REASONING_TAG_RE },
  { key: 'model_internal_planning', re: /\b(?:The user wants|Need to|Let's tackle this|I need to|We need to)\b/i },
  { key: 'prompt_instruction_echo', re: /\b(?:system prompt|user prompt|data provided|the example uses)\b/i },
];
const PUBLIC_MARKET_BRIEF_DISCLAIMER = '이 브리핑은 교육 목적의 시장 해석 자료이며, 특정 자산의 매수·매도 또는 수익을 보장하는 내용이 아닙니다. 루나팀 자동매매는 현재 개발·테스트 중인 내부 자동화로, 공개 데이터 해석을 보조하는 참고 메모 수준에서만 다룹니다.';
const LEGACY_DISCLAIMER_LINE_RE = /^\s*-\s*(?:루나팀 자동(?:화|매매)는 .*개발.*테스트.*|본 글은 Edu-X 커뮤니티용 자동 작성 교육 콘텐츠.*|이 브리핑은 교육 목적의 시장 해석 자료이며,.*)$/;

function normalizeNewlines(value = '') {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function firstPublicSectionIndex(text = '') {
  const match = String(text || '').match(
    /(?:^|\n)\s*(?:⚡|📌|📈|🌐|🤖|⚠️?|👀|💎|📰|🧭|₿|💸|🗓️?)\s+/u,
  );
  return match ? (match.index || 0) + (match[0].startsWith('\n') ? 1 : 0) : -1;
}

function stripUnclosedReasoningBlock(text = '') {
  const tag = String(text || '').match(/<\s*(think|thinking|analysis|reasoning)\b[^>]*>/i);
  if (!tag) return text;
  const tagStart = tag.index || 0;
  const afterTag = tagStart + tag[0].length;
  const publicStart = firstPublicSectionIndex(text.slice(afterTag));
  if (publicStart >= 0) {
    return `${text.slice(0, tagStart)}${text.slice(afterTag + publicStart)}`;
  }
  return text.slice(0, tagStart);
}

function sanitizePublicPostContent(content = '') {
  let text = normalizeNewlines(content);
  for (let i = 0; i < 3; i += 1) {
    const before = text;
    text = text.replace(COMPLETE_REASONING_BLOCK_RE, '\n');
    text = stripUnclosedReasoningBlock(text);
    if (text === before) break;
  }
  return text
    .replace(/^\s*(?:Okay,?\s*)?let['’]s tackle this\.?[\s\S]*?(?=\n\s*(?:⚡|📌|📈|🌐|🤖|⚠️?|👀|💎)\s+)/iu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasPublicMarketBriefDisclaimer(content = '') {
  const text = normalizeNewlines(content).replace(/\s+/g, ' ').trim();
  return text.includes(PUBLIC_MARKET_BRIEF_DISCLAIMER);
}

function splitTrailingHashtags(content = '') {
  const lines = normalizeNewlines(content).trim().split('\n');
  const hashtags = [];
  while (lines.length > 0 && /^#\S+/.test(String(lines[lines.length - 1] || '').trim())) {
    hashtags.unshift(lines.pop());
  }
  return {
    body: lines.join('\n').trim(),
    hashtags: hashtags.join('\n').trim(),
  };
}

function removeLegacyDisclaimerLines(content = '') {
  return normalizeNewlines(content)
    .split('\n')
    .filter((line) => !LEGACY_DISCLAIMER_LINE_RE.test(String(line || '').trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ensurePublicMarketBriefDisclaimer(content = '') {
  const sanitized = sanitizePublicPostContent(content);
  if (hasPublicMarketBriefDisclaimer(sanitized)) return sanitized;
  const { body, hashtags } = splitTrailingHashtags(removeLegacyDisclaimerLines(sanitized));
  const bodyWithSection = /(?:^|\n)\s*⚠️?\s+.*(?:체크포인트|면책)/u.test(body)
    ? body
    : `${body}\n\n⚠️ 오늘 체크포인트 + 면책`;
  const withDisclaimer = `${bodyWithSection}\n- ${PUBLIC_MARKET_BRIEF_DISCLAIMER}`.trim();
  return [withDisclaimer, hashtags].filter(Boolean).join('\n');
}

function detectPublicPostContentLeaks(content = '') {
  const text = normalizeNewlines(content);
  return LEAK_PATTERNS
    .filter((item) => item.re.test(text))
    .map((item) => item.key);
}

function assertNoPublicPostContentLeaks(content = '') {
  const leaks = detectPublicPostContentLeaks(content);
  if (leaks.length > 0) {
    const error = /** @type {any} */ (new Error(`Edu-X public content leak detected: ${leaks.join(',')}`));
    error.code = 'edux_public_content_leak';
    error.leaks = leaks;
    throw error;
  }
}

module.exports = {
  PUBLIC_MARKET_BRIEF_DISCLAIMER,
  sanitizePublicPostContent,
  ensurePublicMarketBriefDisclaimer,
  hasPublicMarketBriefDisclaimer,
  detectPublicPostContentLeaks,
  assertNoPublicPostContentLeaks,
};
