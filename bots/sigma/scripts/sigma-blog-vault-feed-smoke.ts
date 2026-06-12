#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildBlogVaultCandidates,
  buildPopularPatternEntry,
  entryForCandidate,
  redactBlogPii,
} from './runtime-sigma-blog-vault-feed.ts';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { getVaultLectureContext } = require(path.join(PROJECT_ROOT, 'bots/blog/lib/vault-context.ts'));
const { _testOnly: posWriterTestOnly } = require(path.join(PROJECT_ROOT, 'bots/blog/lib/pos-writer.ts'));

const FIXTURE_EMAIL = ['alex', 'example.com'].join('@');
const FIXTURE_PHONE = ['010', '1234', '5678'].join('-');
const FIXTURE_TOKEN = ['sk-test', '1234567890abcdef'].join('_');

function fixtureRows() {
  return {
    posts: [
      {
        id: 101,
        title: '[에이전트 입문 1강] AI 코딩 에이전트 이해',
        category: '에이전트 입문강의',
        post_type: 'lecture',
        lecture_number: 1,
        series_name: '에이전트 입문',
        publish_date: '2026-06-10',
        status: 'published',
        content: 'Claude Code와 Codex를 처음 비교할 때는 요청을 작게 나누고 결과를 검증하는 습관이 중요합니다. '.repeat(35),
        html_content: '',
        created_at: '2026-06-10T00:00:00.000Z',
      },
      {
        id: 102,
        title: '집중력 루틴을 다시 세우는 법',
        category: '자기계발',
        post_type: 'general',
        lecture_number: null,
        series_name: null,
        publish_date: '2026-06-11',
        status: 'published',
        content: '',
        html_content: '<p>하루 루틴을 점검하고 집중 시간을 짧게 나누는 방식은 초보자에게도 도움이 됩니다.</p>',
        created_at: '2026-06-11T00:00:00.000Z',
      },
    ],
    comments: [
      {
        id: 201,
        post_title: '[에이전트 입문 1강] AI 코딩 에이전트 이해',
        commenter_id: 'neighbor123',
        commenter_name: '홍길동',
        comment_text: `홍길동 neighbor123 ${FIXTURE_EMAIL} ${FIXTURE_PHONE} Claude Code 설명이 좋아요.`,
        reply_text: 'neighbor123님 감사합니다.',
        detected_at: '2026-06-12T00:00:00.000Z',
        status: 'replied',
      },
    ],
    commentActions: [
      {
        id: 301,
        action_type: 'neighbor_comment',
        target_blog: 'targetBlog42',
        target_post_url: 'https://blog.naver.com/targetBlog42/123',
        comment_text: `targetBlog42 글에 남긴 ${FIXTURE_TOKEN} 토큰 포함 테스트 댓글`,
        success: true,
        executed_at: '2026-06-12T01:00:00.000Z',
      },
    ],
  };
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function runTsB4() {
  const rows = fixtureRows();
  const candidates = buildBlogVaultCandidates(rows);
  const secondRun = buildBlogVaultCandidates(rows);
  const bySource = countBy(candidates, (item) => item.sourceKind);
  const filePaths = candidates.map((item) => item.filePath);
  const secondFilePaths = secondRun.map((item) => item.filePath);
  const uniqueFilePaths = new Set(filePaths);
  const joinedCommentContent = candidates
    .filter((item) => item.type === 'blog_comment')
    .map((item) => item.content)
    .join('\n');
  const redacted = redactBlogPii('홍길동 neighbor123 https://blog.naver.com/neighbor123', {
    commenter_name: '홍길동',
    commenter_id: 'neighbor123',
  });
  const popularPattern = buildPopularPatternEntry({
    key: 'agent_intro_hook',
    title: '초보자 체크리스트 hook',
    content: '초보자에게는 작은 실습과 확인 체크리스트가 잘 작동했다.',
    category: 'lecture',
  });

  assert.equal(rows.posts.length, 2, 'fixture post row count mismatch');
  assert.equal(rows.comments.length + rows.commentActions.length, 2, 'fixture comment row count mismatch');
  assert.ok(bySource.blog_post >= rows.posts.length, 'post candidates should include every source post');
  assert.equal(bySource.blog_comment_inbound, rows.comments.length, 'inbound comment candidates mismatch');
  assert.equal(bySource.blog_comment_action, rows.commentActions.length, 'comment action candidates mismatch');
  assert.equal(uniqueFilePaths.size, filePaths.length, 'file paths must be unique');
  assert.deepEqual(filePaths, secondFilePaths, 'file paths must be deterministic across reruns');
  assert.ok(candidates.every((item) => entryForCandidate(item).source === 'blo'), 'entries must use source=blo');
  assert.equal(popularPattern.type, 'popular_pattern', 'popular pattern interface type mismatch');
  assert.ok(!joinedCommentContent.includes('neighbor123'), 'commenter id leaked into candidate content');
  assert.ok(!joinedCommentContent.includes('홍길동'), 'commenter name leaked into candidate content');
  assert.ok(!joinedCommentContent.includes('targetBlog42'), 'target blog id leaked into candidate content');
  assert.ok(!joinedCommentContent.includes(FIXTURE_EMAIL), 'email leaked into candidate content');
  assert.ok(!joinedCommentContent.includes(FIXTURE_PHONE), 'phone leaked into candidate content');
  assert.ok(!joinedCommentContent.includes(FIXTURE_TOKEN), 'token leaked into candidate content');
  assert.ok(redacted.text.includes('[REDACTED_BLOG_ID]'), 'blog id redaction missing');
  assert.ok(redacted.text.includes('[REDACTED_BLOG_NAME]'), 'blog name redaction missing');

  return {
    sourceRows: {
      posts: rows.posts.length,
      comments: rows.comments.length,
      commentActions: rows.commentActions.length,
    },
    candidates: candidates.length,
    candidatesBySource: bySource,
    piiMaskSample: joinedCommentContent.slice(0, 180),
    deterministicFilePaths: true,
    popularPatternInterface: popularPattern.filePath,
  };
}

async function runTsB5() {
  const previous = process.env.BLOG_VAULT_CONTEXT_ENABLED;
  const incremental = buildBlogVaultCandidates({
    posts: [fixtureRows().posts[0]],
    comments: [],
    commentActions: [],
  });

  process.env.BLOG_VAULT_CONTEXT_ENABLED = 'true';
  const linked = await getVaultLectureContext({
    lectureTitle: 'Claude Code 설치 따라하기',
    lectureNumber: 5,
    seriesName: '에이전트 입문',
    curriculumKeywords: ['Claude Code', '설치'],
    topK: 4,
  }, {
    searchVault: async () => ({
      ok: true,
      results: [
        {
          id: 'v1',
          title: '[blog_post] [에이전트 입문 1강] AI 코딩 에이전트 이해',
          source: 'blo',
          contentPreview: 'Claude Code와 Codex를 처음 비교할 때는 작은 요청과 검증 절차가 중요합니다.',
          similarity: 0.91,
          meta: { sourceKind: 'blog_post' },
        },
      ],
    }),
  });
  const promptBlock = posWriterTestOnly._buildVaultLectureContextBlock({ vaultLectureContext: linked });

  process.env.BLOG_VAULT_CONTEXT_ENABLED = 'false';
  const disabled = await getVaultLectureContext({
    lectureTitle: 'Claude Code 설치 따라하기',
    curriculumKeywords: ['Claude Code'],
  }, {
    searchVault: async () => {
      throw new Error('search should not run when disabled');
    },
  });

  process.env.BLOG_VAULT_CONTEXT_ENABLED = 'true';
  const failure = await getVaultLectureContext({
    lectureTitle: 'Claude Code 설치 따라하기',
    curriculumKeywords: ['Claude Code'],
  }, {
    searchVault: async () => {
      throw new Error('mock vault unavailable');
    },
  });

  if (previous == null) delete process.env.BLOG_VAULT_CONTEXT_ENABLED;
  else process.env.BLOG_VAULT_CONTEXT_ENABLED = previous;

  assert.ok(incremental.length >= 1, 'incremental post candidate not detected');
  assert.ok(linked.block.includes('[지난 강의 연계]'), 'vault lecture block missing');
  assert.ok(promptBlock.includes('[지난 강의 연계]'), 'writer prompt block missing');
  assert.equal(disabled.block, '', 'disabled vault context should be empty');
  assert.equal(failure.block, '', 'vault failure must not produce a block');
  assert.equal(failure.ok, false, 'vault failure should report ok=false without throwing');

  return {
    incrementalCandidates: incremental.length,
    promptHasVaultBlock: promptBlock.includes('[지난 강의 연계]'),
    killSwitchBlockLength: disabled.block.length,
    failureBlockLength: failure.block.length,
    failureWarning: failure.warning,
  };
}

async function main() {
  const tests = [
    ['TS-B4', runTsB4],
    ['TS-B5', runTsB5],
  ];
  const results = [];
  for (const [id, fn] of tests) {
    try {
      results.push({ id, ok: true, detail: await fn() });
    } catch (error) {
      results.push({ id, ok: false, error: error?.message || String(error) });
    }
  }
  const ok = results.every((row) => row.ok);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
