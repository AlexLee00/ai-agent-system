// @ts-nocheck
'use strict';

const { callHubLlm } = require('../../../packages/core/lib/hub-client');

const COMMENT_TYPES = ['질문', '감사', '공감', '스팸', '제안', '기타'];

const COMMENT_TYPE_STRATEGIES = Object.freeze({
  질문: '댓글 유형: 질문. 답변을 먼저 제시하고, 모르는 내용은 단정하지 말고 확인 가능한 범위만 짧게 설명한다.',
  감사: '댓글 유형: 감사. 짧고 따뜻하게 화답하되 과한 리액션이나 긴 인사는 피한다.',
  공감: '댓글 유형: 공감. 공감한 지점을 한 번 짚고, 글의 운영 맥락과 자연스럽게 연결한다.',
  스팸: '댓글 유형: 스팸. 답글을 생성하지 않고 링크나 홍보 문구를 따라가지 않는다.',
  제안: '댓글 유형: 제안. 제안의 핵심을 인정하고 검토 의사나 다음 글 반영 가능성을 구체적으로 답한다.',
  기타: '댓글 유형: 기타. 기존 일반 답글 전략을 유지하되 댓글의 핵심 표현을 한 번만 반영한다.',
});

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeType(value = '') {
  const text = normalizeText(value);
  return COMMENT_TYPES.includes(text) ? text : '기타';
}

function hasRepeatedPhrase(text = '') {
  const normalized = normalizeText(text);
  if (normalized.length < 12) return false;
  const compact = normalized.replace(/\s+/g, '');
  for (let len = 4; len <= 12; len += 1) {
    for (let start = 0; start + len * 3 <= compact.length; start += 1) {
      const phrase = compact.slice(start, start + len);
      if (phrase && compact.includes(phrase.repeat(3))) return true;
    }
  }
  return false;
}

function classifySpamByRule(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  const hasUrl = /https?:\/\/|www\.|m\.site\.naver\.com|bit\.ly|t\.me\//i.test(normalized);
  const promoPatterns = [
    /체험단|체험자|리뷰비|원고료|협찬|광고\s*문의|홍보|무료\s*상담/i,
    /제\s*블로그|제\s*사이트|들러주시면|방문하시면|서이추|맞방/i,
    /수익화|부업|재택\s*알바|카톡|오픈채팅|텔레그램/i,
  ];
  if (hasUrl && promoPatterns.some((pattern) => pattern.test(normalized))) {
    return { type: '스팸', confidence: 0.95, method: 'fallback' };
  }
  if (hasRepeatedPhrase(normalized)) {
    return { type: '스팸', confidence: 0.9, method: 'fallback' };
  }
  return null;
}

function classifyByFallback(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return { type: '기타', confidence: 0.35, method: 'fallback' };
  const spam = classifySpamByRule(normalized);
  if (spam) return spam;
  if (/[?？]|궁금|어떻게|무엇|뭐가|문의|질문|알려/i.test(normalized)) {
    return { type: '질문', confidence: 0.72, method: 'fallback' };
  }
  if (/감사|고맙|잘\s*보고|잘\s*읽|도움(?:이|됐)|유익/i.test(normalized)) {
    return { type: '감사', confidence: 0.68, method: 'fallback' };
  }
  if (/공감|맞아요|저도|좋(?:네|아|았)|멋(?:지|있)|인상적|와닿/i.test(normalized)) {
    return { type: '공감', confidence: 0.66, method: 'fallback' };
  }
  if (/제안|추천|다뤄\s*주|써\s*주|추가|보완|어떨까요|하면\s*좋/i.test(normalized)) {
    return { type: '제안', confidence: 0.64, method: 'fallback' };
  }
  return { type: '기타', confidence: 0.5, method: 'fallback' };
}

function parseLlmClassification(text = '') {
  const raw = normalizeText(text);
  if (!raw) return null;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : JSON.parse(raw);
    const type = normalizeType(parsed?.type);
    const confidence = clampConfidence(parsed?.confidence);
    return type ? { type, confidence, method: 'llm' } : null;
  } catch {
    return null;
  }
}

async function classifyComment(commentText, context = {}) {
  const normalized = normalizeText(commentText);
  const spam = classifySpamByRule(normalized);
  if (spam) return spam;

  const fallback = classifyByFallback(normalized);
  const llm = context.callHubLlm || callHubLlm;
  try {
    const result = await llm({
      callerTeam: 'blog',
      agent: 'commenter',
      selectorKey: 'blog.commenter.classify',
      taskType: 'comment_classification',
      runtimePurpose: 'blog_comment_classification',
      systemPrompt: [
        '너는 네이버 블로그 댓글 유형 분류기다.',
        '댓글을 반드시 다음 6개 중 하나로 분류한다: 질문, 감사, 공감, 스팸, 제안, 기타.',
        'JSON만 출력한다: {"type":"질문|감사|공감|스팸|제안|기타","confidence":0.0}',
        '홍보 링크, 반복 문구, 체험단/리뷰비/부업 유도는 스팸이다.',
      ].join(' '),
      prompt: [
        context.postTitle ? `[글 제목] ${normalizeText(context.postTitle)}` : '',
        `[댓글] ${normalized}`,
      ].filter(Boolean).join('\n'),
      maxTokens: 100,
    });
    const parsed = parseLlmClassification(result?.text || '');
    if (parsed && parsed.confidence >= 0.5) return parsed;
  } catch {
    // Classification is advisory; reply generation must continue with fallback.
  }
  return fallback;
}

module.exports = {
  COMMENT_TYPES,
  COMMENT_TYPE_STRATEGIES,
  classifyComment,
  classifyByFallback,
  _testOnly: {
    classifySpamByRule,
    hasRepeatedPhrase,
    normalizeType,
    parseLlmClassification,
  },
};
