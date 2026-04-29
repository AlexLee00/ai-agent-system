// @ts-nocheck
'use strict';

const https = require('https');

const pgPool = require('../../../packages/core/lib/pg-pool');
const { parseNaverBlogUrl } = require('../../../packages/core/lib/naver-blog-url');
const { markPublished } = require('./publ.ts');
const { getBlogCommenterConfig } = require('./runtime-config.ts');

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 20;

function normalizeSpace(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(value) {
  return normalizeSpace(value)
    .replace(/[“”"']/g, '')
    .replace(/[?!.,:;()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractCategory(title = '') {
  const match = String(title).match(/^\[([^\]]+)\]/);
  return match ? normalizeSpace(match[1]) : '';
}

function extractLectureNumber(title = '') {
  const match = String(title).match(/\[Node\.js\s+(\d+)강\]/i);
  return match ? Number(match[1]) : null;
}

function toKstDateKey(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value || '';
  const month = parts.find((part) => part.type === 'month')?.value || '';
  const day = parts.find((part) => part.type === 'day')?.value || '';
  return `${year}-${month}-${day}`;
}

function tokenSet(text = '') {
  return new Set(
    normalizeTitle(text)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function dayDistance(a = '', b = '') {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const aDate = new Date(`${a}T00:00:00+09:00`);
  const bDate = new Date(`${b}T00:00:00+09:00`);
  if (Number.isNaN(aDate.getTime()) || Number.isNaN(bDate.getTime())) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((aDate.getTime() - bDate.getTime()) / 86400000));
}

function overlapRatio(a, b) {
  const aSet = tokenSet(a);
  const bSet = tokenSet(b);
  if (!aSet.size || !bSet.size) return 0;
  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) overlap += 1;
  }
  return overlap / Math.max(aSet.size, bSet.size);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 ai-agent-system blog naver-url-backfill',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`http_${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('rss_timeout'));
    });
  });
}

function decodeCdata(value = '') {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function parseRssItems(xml = '') {
  const pattern = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/g;
  const items = [];
  for (const match of xml.matchAll(pattern)) {
    const rawTitle = decodeCdata(match[1]);
    const rawLink = decodeCdata(match[2]);
    const pubDate = normalizeSpace(match[3]);
    const parsed = parseNaverBlogUrl(rawLink);
    if (!rawTitle || !parsed?.ok) continue;
    items.push({
      title: rawTitle,
      titleNormalized: normalizeTitle(rawTitle),
      category: extractCategory(rawTitle),
      lectureNumber: extractLectureNumber(rawTitle),
      link: parsed.canonicalUrl,
      blogId: parsed.blogId,
      logNo: parsed.logNo,
      pubDate,
      dateKey: toKstDateKey(pubDate),
      used: false,
    });
  }
  return items;
}

async function loadReadyBacklog({ days = DEFAULT_DAYS, limit = DEFAULT_LIMIT, postId = null } = {}) {
  if (postId) {
    const rows = await pgPool.query('blog', `
      SELECT id, title, status, post_type, category, publish_date, created_at, metadata
      FROM blog.posts
      WHERE id = $1
        AND (naver_url IS NULL OR naver_url = '')
      LIMIT 1
    `, [postId]);
    return rows.map((row) => ({
      ...row,
      dateKey: toKstDateKey(row.publish_date || row.created_at),
      lectureNumber: extractLectureNumber(row.title || '') || Number(row.metadata?.lecture_number || 0) || null,
      categoryLabel: row.category || extractCategory(row.title || ''),
      titleNormalized: normalizeTitle(row.title || ''),
    }));
  }

  const rows = await pgPool.query('blog', `
    SELECT id, title, status, post_type, category, publish_date, created_at, metadata
    FROM blog.posts
    WHERE status = 'ready'
      AND (naver_url IS NULL OR naver_url = '')
      AND COALESCE(publish_date, created_at) >= NOW() - ($1::text || ' days')::interval
    ORDER BY created_at DESC
    LIMIT $2
  `, [String(days), limit]);

  return rows.map((row) => ({
    ...row,
    dateKey: toKstDateKey(row.publish_date || row.created_at),
    lectureNumber: extractLectureNumber(row.title || '') || Number(row.metadata?.lecture_number || 0) || null,
    categoryLabel: row.category || extractCategory(row.title || ''),
    titleNormalized: normalizeTitle(row.title || ''),
  }));
}

function chooseMatch(post, items) {
  const available = items.filter((item) => !item.used);
  if (!available.length) return null;

  const exact = available.find((item) => item.titleNormalized === post.titleNormalized);
  if (exact) {
    return { item: exact, strategy: 'exact_title', confidence: 1 };
  }

  if (post.post_type === 'lecture' && post.lectureNumber != null) {
    const lectureMatches = available
      .filter((item) => item.lectureNumber === post.lectureNumber)
      .sort((a, b) => dayDistance(post.dateKey, a.dateKey) - dayDistance(post.dateKey, b.dateKey));
    if (lectureMatches.length) {
      return { item: lectureMatches[0], strategy: 'lecture_number', confidence: 0.97 };
    }
  }

  const sameDay = available.filter((item) => item.dateKey === post.dateKey);
  if (post.post_type === 'general' && post.categoryLabel) {
    const categoryMatches = sameDay.filter((item) => normalizeSpace(item.category) === normalizeSpace(post.categoryLabel));
    if (categoryMatches.length === 1) {
      return { item: categoryMatches[0], strategy: 'category_date', confidence: 0.9 };
    }
    if (categoryMatches.length > 1) {
      categoryMatches.sort((a, b) => overlapRatio(post.title, b.title) - overlapRatio(post.title, a.title));
      const top = categoryMatches[0];
      const score = overlapRatio(post.title, top.title);
      return { item: top, strategy: 'category_date_overlap', confidence: Math.max(0.75, score) };
    }

    const nearCategoryMatches = available
      .filter((item) => normalizeSpace(item.category) === normalizeSpace(post.categoryLabel))
      .map((item) => ({ item, distance: dayDistance(post.dateKey, item.dateKey), score: overlapRatio(post.title, item.title) }))
      .filter((entry) => entry.distance <= 2)
      .sort((a, b) => a.distance - b.distance || b.score - a.score);
    if (nearCategoryMatches.length === 1) {
      return { item: nearCategoryMatches[0].item, strategy: 'category_near_date', confidence: Math.max(0.78, nearCategoryMatches[0].score) };
    }
  }

  const overlapMatches = sameDay
    .map((item) => ({ item, score: overlapRatio(post.title, item.title) }))
    .filter((entry) => entry.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  if (overlapMatches.length === 1) {
    return { item: overlapMatches[0].item, strategy: 'title_overlap', confidence: overlapMatches[0].score };
  }

  return null;
}

async function fetchOwnBlogRss(blogId = '') {
  const targetBlogId = normalizeSpace(blogId || getBlogCommenterConfig().blogId || '');
  if (!targetBlogId) {
    throw new Error('blogId를 확인할 수 없습니다.');
  }
  const urls = [
    `https://rss.blog.naver.com/${encodeURIComponent(targetBlogId)}.xml`,
    `https://blog.rss.naver.com/${encodeURIComponent(targetBlogId)}.xml`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const xml = await fetchText(url);
      const items = parseRssItems(xml);
      if (items.length) {
        return { blogId: targetBlogId, sourceUrl: url, items };
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('rss_fetch_failed');
}

async function backfillNaverPublishedUrls({ days = DEFAULT_DAYS, limit = DEFAULT_LIMIT, postId = null, write = false, json = false, minConfidence = 0.9 } = {}) {
  const backlog = await loadReadyBacklog({ days, limit, postId });
  const rss = await fetchOwnBlogRss();
  const matches = [];
  const unmatched = [];
  const skippedLowConfidence = [];

  for (const post of backlog) {
    const picked = chooseMatch(post, rss.items);
    if (!picked) {
      unmatched.push({
        postId: post.id,
        title: post.title,
        postType: post.post_type,
        category: post.categoryLabel,
        dateKey: post.dateKey,
      });
      continue;
    }
    picked.item.used = true;
    const confidence = Number(picked.confidence.toFixed(2));
    if (write && confidence >= minConfidence) {
      await markPublished(post.id, picked.item.link);
    } else if (write && confidence < minConfidence) {
      skippedLowConfidence.push({
        postId: post.id,
        title: post.title,
        strategy: picked.strategy,
        confidence,
        matchedTitle: picked.item.title,
        matchedUrl: picked.item.link,
      });
    }
    matches.push({
      postId: post.id,
      title: post.title,
      postType: post.post_type,
      category: post.categoryLabel,
      dateKey: post.dateKey,
      matchedTitle: picked.item.title,
      matchedUrl: picked.item.link,
      strategy: picked.strategy,
      confidence,
    });
  }

  const result = {
    ok: true,
    dryRun: !write,
    blogId: rss.blogId,
    rssSourceUrl: rss.sourceUrl,
    scanned: backlog.length,
    matched: matches.length,
    unmatched: unmatched.length,
    skippedLowConfidence: skippedLowConfidence.length,
    minConfidence,
    matches,
    unmatchedRows: unmatched,
    skippedLowConfidenceRows: skippedLowConfidence,
  };

  if (json) return result;
  const lines = [
    '🔗 Naver URL Backfill',
    `dryRun: ${result.dryRun}`,
    `scanned: ${result.scanned}`,
    `matched: ${result.matched}`,
    `unmatched: ${result.unmatched}`,
    `skippedLowConfidence: ${result.skippedLowConfidence}`,
  ];
  if (matches.length) {
    lines.push('');
    lines.push('matches:');
    for (const row of matches) {
      lines.push(`- #${row.postId} ${row.strategy} ${row.confidence} :: ${row.title}`);
      lines.push(`  -> ${row.matchedUrl}`);
    }
  }
  if (unmatched.length) {
    lines.push('');
    lines.push('unmatched:');
    for (const row of unmatched) {
      lines.push(`- #${row.postId} ${row.dateKey} ${row.postType} ${row.title}`);
    }
  }
  if (skippedLowConfidence.length) {
    lines.push('');
    lines.push('skippedLowConfidence:');
    for (const row of skippedLowConfidence) {
      lines.push(`- #${row.postId} ${row.confidence} ${row.title}`);
      lines.push(`  -> ${row.matchedUrl}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  backfillNaverPublishedUrls,
  fetchOwnBlogRss,
  parseRssItems,
  normalizeTitle,
  extractCategory,
  extractLectureNumber,
  toKstDateKey,
};
