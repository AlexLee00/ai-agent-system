// @ts-nocheck
'use strict';

const kst = require('../../../packages/core/lib/kst');

/**
 * publ.js (퍼블리셔) — 포스팅 파일 생성 + DB 기록
 *
 * Level 1: HTML 파일 생성 → 마스터가 네이버 블로그에 복붙
 */

const fs = require('fs');
const path = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');
const rag = require('../../../packages/core/lib/rag-safe');
const env = require('../../../packages/core/lib/env');
const { isExcludedReferencePost } = require('./reference-exclusions.ts');

const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output');
const GDRIVE_DIR = process.env.GDRIVE_BLOG_DIR || '/tmp/blog-output';
const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;
let _performanceColumnsState = null;

function formatKstDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return kst.today();
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function normalizeTitleKey(value) {
  return String(value || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function loadPublishedLinkMap() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT id, title, naver_url, metadata
      FROM blog.posts
      WHERE status = 'published'
        AND COALESCE(NULLIF(metadata->>'exclude_from_reference', '')::boolean, false) = false
        AND naver_url IS NOT NULL
        AND naver_url <> ''
      ORDER BY created_at DESC
      LIMIT 500
    `);
    const map = new Map();
    for (const row of rows) {
      if (isExcludedReferencePost(row)) continue;
      const key = normalizeTitleKey(row.title);
      if (!key || map.has(key)) continue;
      map.set(key, row.naver_url);
    }
    return map;
  } catch (e) {
    console.warn('[퍼블] 내부 링크 맵 조회 실패:', e.message);
    return new Map();
  }
}

async function hasPerformanceColumns() {
  if (_performanceColumnsState !== null) return _performanceColumnsState;
  try {
    const rows = await pgPool.query('public', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'blog'
        AND table_name = 'posts'
        AND column_name IN ('views', 'comments', 'likes')
    `);
    const names = new Set(rows.map((row) => row.column_name));
    _performanceColumnsState = names.has('views') && names.has('comments') && names.has('likes');
  } catch (e) {
    console.warn('[퍼블] 성과 컬럼 확인 실패:', e.message);
    _performanceColumnsState = false;
  }
  return _performanceColumnsState;
}

function replaceInternalLinkPlaceholders(content, titleUrlMap) {
  return String(content || '').replace(/→\s*\[([^\]]+)\]\s*←\s*여기에 링크 삽입/g, (_, title) => {
    const url = titleUrlMap.get(normalizeTitleKey(title));
    if (!url) return `→ ${title}`;
    return `→ [${title}](${url})`;
  });
}

function normalizePublishDate(value) {
  if (!value) return kst.today();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return formatKstDate(parsed);
    return kst.today();
  }
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return formatKstDate(value);
    return kst.today();
  }
  const parsed = new Date(String(value));
  if (!Number.isNaN(parsed.getTime())) return formatKstDate(parsed);
  return kst.today();
}

function _contentToHtml(content, title, images = null) {
  let text = content.replace(/_THE_END_\s*$/, '').trim();

  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code class="language-${lang || 'text'}">${escaped.trim()}</code></pre>`;
  });

  const lines = text.split('\n');
  const htmlLines = [];
  let inPre = false;

  for (const line of lines) {
    if (line.startsWith('<pre>')) {
      htmlLines.push(line);
      if (!line.includes('</pre>')) inPre = true;
      continue;
    }
    if (inPre) {
      htmlLines.push(line);
      if (line.includes('</pre>')) inPre = false;
      continue;
    }

    const secMatch = line.match(/^\[(.+)\]\s*$/);
    if (secMatch) {
      htmlLines.push(`<h2 class="section-title">${secMatch[1]}</h2>`);
      continue;
    }

    if (/^━{3,}/.test(line) || /^-{3,}$/.test(line.trim())) {
      htmlLines.push('<hr class="section-divider">');
      continue;
    }

    if (line.trim().startsWith('#') && line.includes(' #')) {
      const tags = line.trim().split(/\s+/).filter((t) => t.startsWith('#'));
      const tagHtml = tags.map((t) => `<span class="hashtag">${t}</span>`).join(' ');
      htmlLines.push(`<p class="hashtags">${tagHtml}</p>`);
      continue;
    }

    if (!line.trim()) {
      htmlLines.push('<br>');
      continue;
    }

    const l = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    const cleanTitle = (title || '').replace(/[^가-힣a-zA-Z0-9\s]/g, '').trim();
    const cleanLine = line.replace(/[^가-힣a-zA-Z0-9\s]/g, '').trim();
    if (cleanLine && cleanLine === cleanTitle && htmlLines.length < 5) continue;

    htmlLines.push(`<p>${l}</p>`);
  }

  const body = htmlLines.join('\n');

  const thumbImg = images?.thumb?.filename
    ? `<div class="post-thumb"><img src="images/${images.thumb.filename}" alt="${title || ''}" loading="lazy"></div>`
    : '';
  const imageStyles = thumbImg
    ? `
  .post-thumb { margin: 0 0 24px; text-align: center; }
  .post-thumb img { max-width: 100%; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); }`
    : '';
  const finalBody = body;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title || '블로그 포스팅'}</title>
<style>
  body { font-family: 'Noto Sans KR', sans-serif; max-width: 860px; margin: 0 auto; padding: 24px 16px; line-height: 1.85; color: #222; background: #fff; }
  h1.post-title { font-size: 1.6rem; font-weight: 700; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
  h2.section-title { font-size: 1.15rem; font-weight: 700; margin: 28px 0 10px; color: #1a4e8a; border-left: 4px solid #1a4e8a; padding-left: 10px; }
  hr.section-divider { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
  pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.88rem; line-height: 1.6; margin: 12px 0; }
  code { background: #f0f0f0; color: #c7254e; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; color: inherit; padding: 0; }
  p { margin: 6px 0; }
  .hashtags { margin-top: 24px; padding-top: 12px; border-top: 1px solid #eee; }
  .hashtag { display: inline-block; background: #e8f0fe; color: #1a73e8; border-radius: 12px; padding: 2px 9px; margin: 2px 3px; font-size: 0.82rem; }
  .post-meta { color: #888; font-size: 0.82rem; margin-bottom: 20px; }
${imageStyles}
</style>
</head>
<body>
<h1 class="post-title">${title || ''}</h1>
${thumbImg}
${finalBody}
</body>
</html>`;
}

async function publishToFile(postData) {
  const {
    title,
    content,
    category,
    postType,
    lectureNumber,
    charCount,
    hashtags,
    images,
    scheduleId,
    writerName,
  } = postData;

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const today = kst.today();
  let publishDate = normalizePublishDate(today);

  if (scheduleId && !DEV_HUB_READONLY) {
    try {
      const scheduleRow = await pgPool.get('blog', `
        SELECT publish_date
          FROM blog.publish_schedule
         WHERE id = $1
      `, [scheduleId]);
      if (scheduleRow?.publish_date) {
        publishDate = normalizePublishDate(scheduleRow.publish_date);
      }

      const existing = await pgPool.get('blog', `
        SELECT id, metadata
          FROM blog.posts
         WHERE metadata->>'schedule_id' = $1
           AND status IN ('ready', 'published')
         ORDER BY created_at DESC
         LIMIT 1
      `, [String(scheduleId)]);
      if (existing?.id) {
        const existingFilename = existing.metadata?.filename || filename;
        console.log(`[퍼블] 중복 발행 방지 — 기존 포스트 재사용 (scheduleId=${scheduleId}, postId=${existing.id})`);
        return {
          filepath: path.join(OUTPUT_DIR, existingFilename),
          postId: existing.id,
          filename: existingFilename,
          reused: true,
        };
      }
    } catch (e) {
      console.warn('[퍼블] 기존 포스트 조회 실패 (계속 진행):', e.message);
    }
  }

  const safeTitle = (title || '').replace(/[^가-힣a-zA-Z0-9\s-]/g, '').slice(0, 50).trim();
  const filename = `${publishDate}_${postType}_${safeTitle}.html`;
  const filepath = path.join(OUTPUT_DIR, filename);

  const titleUrlMap = await loadPublishedLinkMap();
  const linkedContent = replaceInternalLinkPlaceholders(content, titleUrlMap);

  const htmlContent = _contentToHtml(linkedContent, title, images);

  fs.writeFileSync(filepath, htmlContent, 'utf8');

  try {
    if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(GDRIVE_DIR, filename), htmlContent, 'utf8');
    console.log(`[퍼블] 구글드라이브 저장: ${filename}`);
  } catch (e) {
    console.warn('[퍼블] 구글드라이브 저장 실패:', e.message);
  }

  let postId = null;
  if (!DEV_HUB_READONLY) {
    try {
      const rows = await pgPool.query('blog', `
        INSERT INTO blog.posts
          (title, category, post_type, lecture_number, publish_date, status, char_count, content, hashtags, metadata)
        VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7, $8, $9)
        RETURNING id
      `, [
        title,
        category,
        postType,
        lectureNumber || null,
        publishDate,
        charCount,
        linkedContent,
        hashtags || [],
        {
          schedule_id: scheduleId || null,
          filename,
          generated_on: today,
          writer_name: writerName || null,
        },
      ]);
      postId = rows[0]?.id;
      console.log(`[퍼블] 저장 완료: ${filename} (DB ID: ${postId})`);
    } catch (e) {
      console.warn('[퍼블] DB 저장 실패:', e.message);
    }
  } else {
    console.log(`[퍼블] DEV/HUB 읽기 전용 — DB 저장 생략 (${filename})`);
  }

  if (!DEV_HUB_READONLY) {
    try {
      await rag.initSchema();
      await rag.store(
        'blog',
        `[${postType}] ${title} | ${category}${lectureNumber ? ` | ${lectureNumber}강` : ''} | ${charCount}자`,
        {
          type: postType,
          category,
          lecture_number: lectureNumber || null,
          char_count: charCount,
          publish_date: publishDate,
          filename,
        },
        'blog-publ'
      );
    } catch (e) {
      console.warn('[퍼블] RAG 저장 실패:', e.message);
    }
  }

  return { filepath, postId, filename, content: linkedContent };
}

async function markPublished(postId, naverUrl) {
  if (!postId) return;
  if (DEV_HUB_READONLY) return;
  try {
    const row = await pgPool.get('blog', `
      SELECT metadata
      FROM blog.posts
      WHERE id = $1
    `, [postId]);

    await pgPool.run('blog', `
      UPDATE blog.posts
      SET status = 'published', naver_url = $2
      WHERE id = $1
    `, [postId, naverUrl || null]);

    const scheduleId = row?.metadata?.schedule_id ? Number(row.metadata.schedule_id) : null;
    if (scheduleId) {
      await pgPool.run('blog', `
        UPDATE blog.publish_schedule
        SET status = 'published', post_id = $2, updated_at = NOW()
        WHERE id = $1
      `, [scheduleId, postId]);
    }
  } catch (e) {
    console.warn('[퍼블] 상태 업데이트 실패:', e.message);
  }
}

async function recordPerformance(postId, metrics = {}) {
  if (!postId) return null;
  if (DEV_HUB_READONLY) return null;
  const views = Number(metrics.views || 0);
  const comments = Number(metrics.comments || 0);
  const likes = Number(metrics.likes || 0);
  const hasColumns = await hasPerformanceColumns();

  try {
    const payload = JSON.stringify({ views, comments, likes, performance_collected_at: new Date().toISOString() });
    const row = hasColumns
      ? await pgPool.get('blog', `
        UPDATE blog.posts
        SET views = $2,
            comments = $3,
            likes = $4,
            metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
        WHERE id = $1
        RETURNING title, category, char_count
      `, [
        postId,
        views,
        comments,
        likes,
        payload,
      ])
      : await pgPool.get('blog', `
        UPDATE blog.posts
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
        RETURNING title, category, char_count
      `, [
        postId,
        payload,
      ]);

    if (row && views > 0) {
      try {
        await rag.initSchema();
        await rag.store(
          'experience',
          `[blog_success] ${row.title} | views=${views} | comments=${comments} | likes=${likes}\n[이유: 조회수 ${views}회, 카테고리 ${row.category || 'unknown'}]`,
          {
            intent: 'blog_success',
            team: 'blog',
            category: row.category,
            views,
            comments,
            likes,
            charCount: Number(row.char_count || 0),
            postId,
            why: `조회수 ${views}회, 카테고리 ${row.category || 'unknown'}`,
          },
          'blog-publ'
        );
      } catch (ragError) {
        console.warn('[퍼블] 성과 RAG 저장 실패(무시):', ragError.message);
      }
    }

    return row;
  } catch (e) {
    console.warn('[퍼블] 성과 기록 실패:', e.message);
    return null;
  }
}

async function recordPerformancePartial(postId, metrics = {}) {
  if (!postId) return null;
  if (DEV_HUB_READONLY) return null;

  const hasViews = metrics.views !== undefined && metrics.views !== null;
  const hasComments = metrics.comments !== undefined && metrics.comments !== null;
  const hasLikes = metrics.likes !== undefined && metrics.likes !== null;
  if (!hasViews && !hasComments && !hasLikes) return null;

  const views = hasViews ? Number(metrics.views || 0) : null;
  const comments = hasComments ? Number(metrics.comments || 0) : null;
  const likes = hasLikes ? Number(metrics.likes || 0) : null;
  const hasColumns = await hasPerformanceColumns();

  try {
    const fragments = [];
    const params = [postId];
    let paramIndex = 2;

    if (hasColumns) {
      if (hasViews) {
        fragments.push(`views = $${paramIndex++}`);
        params.push(views);
      }
      if (hasComments) {
        fragments.push(`comments = $${paramIndex++}`);
        params.push(comments);
      }
      if (hasLikes) {
        fragments.push(`likes = $${paramIndex++}`);
        params.push(likes);
      }
    }

    const payload = {
      performance_collected_at: new Date().toISOString(),
    };
    if (hasViews) payload.views = views;
    if (hasComments) payload.comments = comments;
    if (hasLikes) payload.likes = likes;

    fragments.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${paramIndex++}::jsonb`);
    params.push(JSON.stringify(payload));

    const row = await pgPool.get('blog', `
      UPDATE blog.posts
      SET ${fragments.join(', ')}
      WHERE id = $1
      RETURNING title, category, char_count
    `, params);

    if (row && hasViews && views > 0) {
      try {
        await rag.initSchema();
        await rag.store(
          'experience',
          `[blog_success] ${row.title} | views=${views}${hasComments ? ` | comments=${comments}` : ''}${hasLikes ? ` | likes=${likes}` : ''}\n[이유: 조회수 ${views}회, 카테고리 ${row.category || 'unknown'}]`,
          {
            intent: 'blog_success',
            team: 'blog',
            category: row.category,
            views,
            comments: hasComments ? comments : null,
            likes: hasLikes ? likes : null,
            charCount: Number(row.char_count || 0),
            postId,
            why: `조회수 ${views}회, 카테고리 ${row.category || 'unknown'}`,
          },
          'blog-publ'
        );
      } catch (ragError) {
        console.warn('[퍼블] 성과 부분 RAG 저장 실패(무시):', ragError.message);
      }
    }

    return row;
  } catch (e) {
    console.warn('[퍼블] 성과 부분 기록 실패:', e.message);
    return null;
  }
}

async function getPerformanceCollectionCandidates(days = 7) {
  try {
    return await pgPool.query('blog', `
      SELECT id, title, category, publish_date, naver_url, metadata
      FROM blog.posts
      WHERE status = 'published'
        AND publish_date <= CURRENT_DATE - $1::int
        AND (
          metadata->>'performance_collected_at' IS NULL
          OR metadata->>'performance_collected_at' = ''
        )
      ORDER BY publish_date ASC
      LIMIT 20
    `, [days]);
  } catch (e) {
    console.warn('[퍼블] 성과 수집 대상 조회 실패:', e.message);
    return [];
  }
}

async function getViewCollectionCandidates(days = 14, limit = 10) {
  try {
    return await pgPool.query('blog', `
      SELECT id, title, category, publish_date, naver_url, metadata
      FROM blog.posts
      WHERE status = 'published'
        AND publish_date >= CURRENT_DATE - $1::int
        AND COALESCE(NULLIF(metadata->>'views', ''), '0')::int = 0
      ORDER BY publish_date DESC, id DESC
      LIMIT $2
    `, [days, limit]);
  } catch (e) {
    console.warn('[퍼블] 조회수 수집 대상 조회 실패:', e.message);
    return [];
  }
}

module.exports = {
  publishToFile,
  markPublished,
  recordPerformance,
  recordPerformancePartial,
  getPerformanceCollectionCandidates,
  getViewCollectionCandidates,
  OUTPUT_DIR,
  normalizeTitleKey,
  replaceInternalLinkPlaceholders,
};
