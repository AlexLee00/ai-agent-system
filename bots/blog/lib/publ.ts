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
const { publishToRag } = require('../../../packages/core/lib/reporting-hub');
const env = require('../../../packages/core/lib/env');
const { isExcludedReferencePost } = require('./reference-exclusions.ts');

const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output');
const GDRIVE_DIR = process.env.GDRIVE_BLOG_DIR || '/tmp/blog-output';
const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;
let _performanceColumnsState = null;

async function publishBlogRagEvent({
  collection,
  sourceBot = 'blog-publ',
  eventType,
  message,
  payload,
  metadata = {},
  content,
  dedupeKey,
  cooldownMs = 30 * 60 * 1000,
}) {
  await rag.initSchema();
  const result = await publishToRag({
    ragStore: {
      async store(targetCollection, ragContent, targetMetadata = {}, targetSourceBot = sourceBot) {
        return rag.store(targetCollection, ragContent, targetMetadata, targetSourceBot);
      },
    },
    collection,
    sourceBot,
    event: {
      from_bot: sourceBot,
      team: 'blog',
      event_type: eventType,
      alert_level: 1,
      message,
      payload,
    },
    metadata,
    contentBuilder: () => String(content || ''),
    policy: {
      dedupe: true,
      key: dedupeKey,
      cooldownMs,
    },
  });
  return result?.id ?? null;
}

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

function countQuestionStyleFaq(content) {
  return (String(content || '').match(/(?:^|\n)\s*(?:\*\*)?Q[0-9]*[.):]|(?:^|\n)\s*Q\.\s|(?:^|\n)\s*질문\s*[0-9]*[.):]/gm) || []).length;
}

function buildLectureLearningPointsSection(title) {
  return [
    '[이 글에서 배울 수 있는 것]',
    `- ${title || '이번 강의 주제'}의 핵심 구조를 실무 관점에서 이해합니다.`,
    '- 구현 전에 먼저 확인해야 할 설계 기준과 운영 포인트를 정리합니다.',
    '- 예제 코드를 실제 프로젝트에 옮길 때 놓치기 쉬운 체크포인트를 짚습니다.',
  ].join('\n');
}

function buildLectureFaqSection(title) {
  return [
    '[AEO FAQ]',
    `Q. ${title || '이번 강의 주제'}를 왜 먼저 이해해야 하나요?`,
    'A. 기능 구현보다 먼저 시스템 경계와 운영 책임을 이해해야 실제 장애를 줄일 수 있기 때문입니다.',
    `Q. ${title || '이 기술'}를 적용할 때 가장 자주 놓치는 부분은 무엇인가요?`,
    'A. 예외 처리, 관측 포인트, 재시도 정책처럼 운영 단계에서 필요한 기준을 뒤늦게 붙이는 경우가 많습니다.',
    'Q. 예제 코드를 그대로 복사해도 바로 실무에 쓸 수 있나요?',
    'A. 출발점으로는 좋지만 인증, 로깅, 롤백, 모니터링까지 붙어야 운영 가능한 코드가 됩니다.',
  ].join('\n');
}

function buildGeneralLearningPointsSection(title) {
  return [
    '[이 글에서 배울 수 있는 것]',
    `- ${title || '이번 주제'}를 볼 때 먼저 점검해야 할 기준`,
    '- 실무 의사결정에서 흔들리지 않도록 잡아야 할 핵심 포인트',
    '- 오늘 내용이 실제 업무나 일상 판단에 어떻게 연결되는지',
  ].join('\n');
}

function buildGeneralQuestionSection(title) {
  return [
    '[질문형 Q&A]',
    `Q. ${title || '이번 주제'}를 실제 상황에 적용할 때 가장 먼저 봐야 할 것은 무엇인가요?`,
    'A. 지금 당장 해결하려는 문제보다, 그 판단이 이후 일정과 기대치에 어떤 영향을 주는지 먼저 보는 편이 안전합니다.',
    'Q. 겉으로는 비슷해 보이는 선택지인데 왜 결과가 크게 달라지나요?',
    'A. 기준 없이 빠르게 결정하면 중간 수정 비용이 커지기 때문입니다. 처음에 확인할 질문 몇 개가 전체 흐름을 바꿉니다.',
    'Q. 실무에서는 완벽한 답보다 무엇이 더 중요할까요?',
    'A. 지금 단계에서 무엇을 확정하고 무엇을 열어둘지 분리하는 판단이 더 중요합니다.',
  ].join('\n');
}

function hasPersonalVoice(content) {
  return /제가|저는|느꼈|경험|실제로.*해보니|직접.*해본|제 생각|솔직히/.test(String(content || ''));
}

function hasEmotionLine(content) {
  return /놀랐|감동|기뻤|아쉬웠|뿌듯|설레|두근|가슴이|반가웠|인상적/.test(String(content || ''));
}

function buildPersonalVoiceParagraph(title, postType) {
  const topic = title || '이번 주제';
  if (postType === 'lecture') {
    return [
      '제가 실제 운영 흐름에 이 구조를 대입해보면, 처음에는 단순한 개념처럼 보여도 장애와 복구 관점에서 생각보다 훨씬 중요하게 다가올 때가 많았습니다.',
      `특히 ${topic}처럼 책임을 나누는 주제는 실무에서 한 번 체감하고 나면, 왜 이 기준을 먼저 잡아야 하는지 더 선명하게 느껴졌습니다.`,
      '개인적으로도 이런 지점을 정리하고 나면 막연했던 구조가 꽤 단단하게 잡히는 느낌이라 인상적이었습니다.',
    ].join(' ');
  }

  return [
    `저도 ${topic}와 비슷한 고민을 할 때면, 더 많이 하는 방법보다 무엇을 기준으로 버릴지부터 다시 적어보곤 합니다.`,
    '이 과정을 거치면 막연하게 조급했던 마음이 조금 정리되고, 생각보다 훨씬 차분하게 다음 선택을 보게 되는 점이 늘 인상적이었습니다.',
  ].join(' ');
}

function ensurePersonalVoiceFloor(content, postType, title) {
  let next = String(content || '').trim();
  if (!next) return next;
  if (hasPersonalVoice(next) && hasEmotionLine(next)) return next;

  const paragraph = buildPersonalVoiceParagraph(title, postType);
  const anchor = postType === 'lecture' ? '[마무리 인사]' : '[마무리 제언]';

  if (next.includes(anchor)) {
    return next.replace(anchor, `${paragraph}\n\n${anchor}`);
  }

  return `${next}\n\n${paragraph}`;
}

function ensurePublishBriefingFloor(content, postType, title) {
  let next = String(content || '').trim();
  if (!next) return next;

  if (postType === 'lecture') {
    if (!next.includes('이 글에서 배울 수 있는 것')) {
      const markerIndex = next.indexOf('[승호아빠 인사말]');
      const section = buildLectureLearningPointsSection(title);
      if (markerIndex >= 0) {
        next = `${next.slice(0, markerIndex).trimEnd()}\n\n${section}\n\n${next.slice(markerIndex).trimStart()}`;
      } else {
        next = `${section}\n\n${next}`;
      }
    }

    const faqCount = countQuestionStyleFaq(next);
    if (!next.includes('[AEO FAQ]') || faqCount < 3) {
      next = next.replace(/\[AEO FAQ\][\s\S]*?(?=\n\[|$)/, '').trim();
      next = `${next}\n\n${buildLectureFaqSection(title)}`;
    }
  } else {
    if (!next.includes('이 글에서 배울 수 있는 것')) {
      const markerIndex = next.indexOf('[승호아빠 인사말]');
      const section = buildGeneralLearningPointsSection(title);
      if (markerIndex >= 0) {
        next = `${next.slice(0, markerIndex).trimEnd()}\n\n${section}\n\n${next.slice(markerIndex).trimStart()}`;
      } else {
        next = `${section}\n\n${next}`;
      }
    }

    const faqCount = countQuestionStyleFaq(next);
    if (!next.includes('[질문형 Q&A]') || faqCount < 3) {
      next = next.replace(/\[질문형 Q&A\][\s\S]*?(?=\n\[|$)/, '').trim();
      next = `${next}\n\n${buildGeneralQuestionSection(title)}`;
    }
  }

  return next.trim();
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
    metadata,
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
  const normalizedContent = ensurePersonalVoiceFloor(
    ensurePublishBriefingFloor(content, postType, title),
    postType,
    title,
  );
  const linkedContent = replaceInternalLinkPlaceholders(normalizedContent, titleUrlMap);

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
          ...(metadata || {}),
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
      await publishBlogRagEvent({
        collection: 'blog',
        eventType: 'blog_publish_rag',
        message: `[${postType}] ${title} | ${category}${lectureNumber ? ` | ${lectureNumber}강` : ''} | ${charCount}자`,
        payload: {
          title,
          summary: `${category}${lectureNumber ? ` | ${lectureNumber}강` : ''} | ${charCount}자`,
          details: [
            `type: ${postType}`,
            `publish_date: ${publishDate}`,
            `filename: ${filename}`,
          ],
        },
        metadata: {
          type: postType,
          category,
          lecture_number: lectureNumber || null,
          char_count: charCount,
          publish_date: publishDate,
          filename,
        },
        content: `[${postType}] ${title} | ${category}${lectureNumber ? ` | ${lectureNumber}강` : ''} | ${charCount}자`,
        dedupeKey: `blog-rag:${filename}:${publishDate}`,
      });
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
        await publishBlogRagEvent({
          collection: 'experience',
          eventType: 'blog_success_rag',
          message: `[blog_success] ${row.title} | views=${views} | comments=${comments} | likes=${likes}`,
          payload: {
            title: row.title,
            summary: `views=${views} | comments=${comments} | likes=${likes}`,
            details: [
              `category: ${row.category || 'unknown'}`,
              `why: 조회수 ${views}회, 카테고리 ${row.category || 'unknown'}`,
            ],
          },
          metadata: {
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
          content: `[blog_success] ${row.title} | views=${views} | comments=${comments} | likes=${likes}\n[이유: 조회수 ${views}회, 카테고리 ${row.category || 'unknown'}]`,
          dedupeKey: `blog-success:${postId}:${views}:${comments}:${likes}`,
          cooldownMs: 24 * 60 * 60 * 1000,
        });
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
        await publishBlogRagEvent({
          collection: 'experience',
          eventType: 'blog_success_rag',
          message: `[blog_success] ${row.title} | views=${views}${hasComments ? ` | comments=${comments}` : ''}${hasLikes ? ` | likes=${likes}` : ''}`,
          payload: {
            title: row.title,
            summary: `views=${views}${hasComments ? ` | comments=${comments}` : ''}${hasLikes ? ` | likes=${likes}` : ''}`,
            details: [
              `category: ${row.category || 'unknown'}`,
              `why: 조회수 ${views}회, 카테고리 ${row.category || 'unknown'}`,
            ],
          },
          metadata: {
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
          content: `[blog_success] ${row.title} | views=${views}${hasComments ? ` | comments=${comments}` : ''}${hasLikes ? ` | likes=${likes}` : ''}\n[이유: 조회수 ${views}회, 카테고리 ${row.category || 'unknown'}]`,
          dedupeKey: `blog-success:${postId}:${views}:${hasComments ? comments : 'na'}:${hasLikes ? likes : 'na'}`,
          cooldownMs: 24 * 60 * 60 * 1000,
        });
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
