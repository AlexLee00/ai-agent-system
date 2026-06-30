#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const classifierPath = path.join(__dirname, '../lib/comment-classifier.ts');
const commenterPath = path.join(__dirname, '../lib/commenter.ts');

async function main() {
  const originalLoad = Module._load;
  const hubCalls = [];
  const dbWrites = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../packages/core/lib/hub-client' || String(request).endsWith('packages/core/lib/hub-client')) {
      return {
        callHubLlm: async (payload) => {
          hubCalls.push(payload);
          if (payload.selectorKey === 'blog.commenter.classify') {
            const prompt = String(payload.prompt || '');
            if (prompt.includes('어떻게')) return { text: '{"type":"질문","confidence":0.93}' };
            if (prompt.includes('제안')) return { text: '{"type":"제안","confidence":0.91}' };
            return { text: '{"type":"기타","confidence":0.51}' };
          }
          if (payload.selectorKey === 'blog.commenter.reply') {
            return { text: '{"reply":"질문 주신 부분은 작은 기준부터 확인해보면 좋습니다. 다음 글에서도 실제 적용 흐름으로 더 풀어보겠습니다.","tone":"질문형"}' };
          }
          return { text: '{}' };
        },
      };
    }
    if (request === '../../../packages/core/lib/pg-pool' || String(request).endsWith('packages/core/lib/pg-pool')) {
      return {
        query: async () => [],
        get: async () => null,
        run: async (schema, sql, params) => {
          dbWrites.push({ schema, sql: String(sql || ''), params });
          return { rowCount: 1 };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[classifierPath];
    delete require.cache[commenterPath];
    const classifier = require(classifierPath);
    const commenter = require(commenterPath);

    const cases = [
      ['질문', '이 설정은 실제 운영에서 어떻게 적용하면 좋을까요?', '질문'],
      ['감사', '좋은 글 잘 보고 갑니다. 정리가 도움이 됐습니다.', '감사'],
      ['공감', '저도 자동화 기준을 나눠야 한다는 부분이 정말 공감됐습니다.', '공감'],
      ['스팸', '체험단 모집합니다 리뷰비 지급 https://m.site.naver.com/abc', '스팸'],
      ['제안', '다음에는 운영 로그 예시도 제안 주제로 다뤄주시면 좋겠습니다.', '제안'],
      ['기타', '오늘 내용 메모해두고 천천히 다시 보겠습니다.', '기타'],
    ];

    for (const [label, text, expected] of cases) {
      const result = await classifier.classifyComment(text, {
        postTitle: 'AI 에이전트 운영',
        callHubLlm: async () => { throw new Error(`force fallback ${label}`); },
      });
      assert.equal(result.type, expected, `${label} fallback classification mismatch`);
      assert.equal(result.method, 'fallback', `${label} should use fallback in forced-failure fixture`);
      assert.ok(result.confidence >= 0 && result.confidence <= 1, `${label} confidence out of range`);
    }

    const llmQuestion = await classifier.classifyComment('이건 어떻게 적용하면 좋을까요?', {
      postTitle: 'AI 에이전트 운영',
    });
    assert.equal(llmQuestion.type, '질문');
    assert.equal(llmQuestion.method, 'llm');

    const spamReply = await commenter.generateReply(
      'AI 에이전트 운영',
      '운영 기준을 설명한 글',
      '체험단 모집합니다 리뷰비 지급 https://m.site.naver.com/abc',
    );
    assert.equal(spamReply.skipped, true);
    assert.equal(spamReply.reason, 'comment_classified_spam');
    assert.equal(spamReply.classification.type, '스팸');

    const simpleReplySpam = await commenter.processComment({
      id: 9001,
      post_title: 'AI 에이전트 운영',
      post_url: 'https://blog.naver.com/cafe_library/123',
      comment_text: '광고 문의는 https://example.com 에서 확인해주세요.',
      commenter_name: 'promo',
    }, { testMode: true });
    assert.equal(simpleReplySpam.skipped, true);
    assert.equal(simpleReplySpam.reason, 'comment_classified_spam');
    assert.equal(simpleReplySpam.classification.type, '스팸');
    assert.ok(
      dbWrites.some((write) => /UPDATE\s+blog\.comments/i.test(String(write.sql || '')) && String(write.params?.[3] || '').includes('comment_classified_spam')),
      'spam processComment path should update comment status as classified skip',
    );

    const generated = await commenter.generateReply(
      'AI 에이전트 운영',
      '운영 기준을 설명한 글',
      '이건 실제 운영에서 어떻게 적용하면 좋을까요?',
    );
    assert.equal(generated.skipped, undefined);
    assert.equal(generated.classification.type, '질문');
    assert.match(generated.reply, /질문|기준|적용/);
    assert.ok(
      hubCalls.some((call) => call.selectorKey === 'blog.commenter.reply' && String(call.prompt || '').includes('[댓글 유형] 질문')),
      'reply prompt should include comment classification',
    );

    const telemetry = require('../lib/commenter-run-telemetry.ts');
    const normalized = telemetry.normalizeCommentClassifications({ 질문: 2, 스팸: 1, 기타: 0, '': 3 });
    assert.deepEqual(normalized, { 질문: 2, 스팸: 1 });

    console.log(JSON.stringify({
      ok: true,
      cases: cases.length,
      spamSkipped: spamReply.skipped === true,
      processSpamSkipped: simpleReplySpam.skipped === true,
      replyClassification: generated.classification.type,
      hubCalls: hubCalls.length,
    }, null, 2));
  } finally {
    Module._load = originalLoad;
    delete require.cache[classifierPath];
    delete require.cache[commenterPath];
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
