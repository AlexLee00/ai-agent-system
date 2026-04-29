'use strict';

const BLOG_ENGAGEMENT_OWNERS = Object.freeze({
  replies: Object.freeze({
    key: 'replies',
    agent: 'blog.reply-agent',
    label: '답댓글',
    service: 'ai.blog.commenter',
    script: 'scripts/run-commenter.ts',
    scope: '인바운드 댓글 답글 처리',
  }),
  neighborComments: Object.freeze({
    key: 'neighborComments',
    agent: 'blog.neighbor-comment-agent',
    label: '이웃댓글',
    service: 'ai.blog.neighbor-commenter',
    script: 'scripts/run-neighbor-commenter.ts',
    scope: '이웃/외부 댓글 수집 및 등록',
  }),
  sympathies: Object.freeze({
    key: 'sympathies',
    agent: 'blog.sympathy-agent',
    label: '공감',
    service: 'ai.blog.neighbor-sympathy',
    script: 'scripts/run-neighbor-sympathy.ts',
    scope: '이웃/외부 공감 처리',
  }),
  views: Object.freeze({
    key: 'views',
    agent: 'blog.views-agent',
    label: '조회수',
    service: 'ai.blog.collect-views',
    script: 'scripts/collect-views.ts',
    scope: '네이버 조회수/반응 수집',
  }),
});

function getEngagementOwners() {
  return {
    replies: { ...BLOG_ENGAGEMENT_OWNERS.replies },
    neighborComments: { ...BLOG_ENGAGEMENT_OWNERS.neighborComments },
    sympathies: { ...BLOG_ENGAGEMENT_OWNERS.sympathies },
    views: { ...BLOG_ENGAGEMENT_OWNERS.views },
  };
}

function getEngagementOwnerByArea(area = '') {
  const normalized = String(area || '');
  if (normalized.includes('replies')) return { ...BLOG_ENGAGEMENT_OWNERS.replies };
  if (normalized.includes('neighbor')) return { ...BLOG_ENGAGEMENT_OWNERS.neighborComments };
  if (normalized.includes('sympathy')) return { ...BLOG_ENGAGEMENT_OWNERS.sympathies };
  if (normalized.includes('visibility')) return { ...BLOG_ENGAGEMENT_OWNERS.neighborComments };
  return null;
}

module.exports = {
  BLOG_ENGAGEMENT_OWNERS,
  getEngagementOwners,
  getEngagementOwnerByArea,
};
