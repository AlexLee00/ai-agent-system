'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const rag = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/rag.js'));
const eventLake = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/event-lake.js'));
const { publishToRag } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/reporting-hub'));

function _compact(text = '', max = 500) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function _qualityScore(quality = {}) {
  if (typeof quality?.score === 'number') return quality.score;
  return quality?.passed ? 8 : 4;
}

async function accumulatePostExperience(post = {}, quality = {}, options = {}) {
  const {
    traceId = '',
    dryRun = false,
    reused = false,
  } = options;

  if (dryRun || reused) {
    return { skipped: true, reason: dryRun ? 'dry_run' : 'reused' };
  }

  try {
    await rag.initSchema();
  } catch (error) {
    console.warn('[블로] RAG 초기화 실패 (축적 생략):', error.message);
    return { skipped: true, reason: 'rag_init_failed' };
  }

  const summary = `[${post.category}] ${post.title}\n${_compact(post.content, 500)}`;
  const qualityPayload = {
    action: 'blog_post_published',
    postType: post.postType,
    title: post.title,
    category: post.category,
    writer: post.writerName || 'unknown',
    charCount: Number(post.charCount || 0),
    qualityScore: _qualityScore(quality),
    qualityPassed: !!quality?.passed,
    aiRiskLevel: quality?.aiRisk?.riskLevel || null,
    aiRiskScore: quality?.aiRisk?.riskScore || null,
    issues: (quality?.issues || []).map((issue) => ({
      severity: issue?.severity || 'info',
      msg: issue?.msg || '',
    })),
    postId: post.postId || null,
    scheduleId: post.scheduleId || null,
    traceId: traceId || null,
    publishedAt: new Date().toISOString(),
  };

  try {
    await publishToRag({
      ragStore: {
        async store(targetCollection, ragContent, metadata = {}, sourceBot = 'blog-blo') {
          return rag.store(targetCollection, ragContent, metadata, sourceBot);
        },
      },
      collection: 'blog',
      sourceBot: 'blog-blo',
      event: {
        from_bot: 'blog-blo',
        team: 'blog',
        event_type: 'blog_post_rag',
        alert_level: 1,
        message: summary,
        payload: {
          title: post.title || 'blog post',
          summary: `${post.category || 'general'} | ${post.postType || 'general'}`,
          details: [
            `writer: ${post.writerName || 'unknown'}`,
            `qualityScore: ${_qualityScore(quality)}`,
          ],
        },
      },
      metadata: {
        category: post.category,
        writerName: post.writerName || null,
        postType: post.postType,
        qualityScore: _qualityScore(quality),
        postId: post.postId || null,
        traceId: traceId || null,
      },
      contentBuilder: () => summary,
      policy: {
        dedupe: true,
        key: `blog-accumulator:blog:${post.postId || post.title || 'unknown'}`,
        cooldownMs: 30 * 60 * 1000,
      },
    });

    await publishToRag({
      ragStore: {
        async store(targetCollection, ragContent, metadata = {}, sourceBot = 'blog-blo') {
          return rag.store(targetCollection, ragContent, metadata, sourceBot);
        },
      },
      collection: 'experience',
      sourceBot: 'blog-blo',
      event: {
        from_bot: 'blog-blo',
        team: 'blog',
        event_type: 'blog_quality_rag',
        alert_level: 1,
        message: `${post.title || 'blog post'} 품질 경험 저장`,
        payload: {
          title: post.title || 'blog quality',
          summary: `${post.category || 'general'} | qualityScore ${_qualityScore(quality)}`,
          details: [
            `writer: ${post.writerName || 'unknown'}`,
            `aiRisk: ${quality?.aiRisk?.riskLevel || 'unknown'}`,
          ],
        },
      },
      metadata: {
        type: 'blog_quality',
        category: post.category,
        writerName: post.writerName || null,
        qualityScore: _qualityScore(quality),
        postId: post.postId || null,
        traceId: traceId || null,
      },
      contentBuilder: () => JSON.stringify(qualityPayload),
      policy: {
        dedupe: true,
        key: `blog-accumulator:experience:${post.postId || post.title || 'unknown'}`,
        cooldownMs: 30 * 60 * 1000,
      },
    });
  } catch (error) {
    console.warn('[블로] 발행 후 RAG 축적 실패:', error.message);
  }

  try {
    await eventLake.record({
      eventType: 'blog_post_published',
      team: 'blog',
      botName: post.writerName || 'blog-blo',
      severity: 'info',
      traceId: traceId || '',
      title: post.title || 'blog post published',
      message: `${post.category || 'general'} 글 발행 및 축적 완료`,
      tags: ['blog', 'publish', post.postType || 'general'],
      metadata: {
        category: post.category,
        writerName: post.writerName || null,
        postType: post.postType,
        charCount: Number(post.charCount || 0),
        qualityScore: _qualityScore(quality),
        postId: post.postId || null,
        aiRiskLevel: quality?.aiRisk?.riskLevel || null,
      },
    });
  } catch (error) {
    console.warn('[블로] event_lake 기록 실패 (무시):', error.message);
  }

  return { skipped: false, stored: true };
}

module.exports = {
  accumulatePostExperience,
};
