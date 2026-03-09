'use strict';

/**
 * publ.js (퍼블리셔) — 포스팅 파일 생성 + DB 기록
 *
 * Level 1: 마크다운 파일 생성 → 마스터가 수동 복붙
 */

const fs     = require('fs');
const path   = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');
const rag    = require('../../../packages/core/lib/rag');

const OUTPUT_DIR    = path.join(__dirname, '..', 'output');
const GDRIVE_DIR    = '/Users/alexlee/Library/CloudStorage/GoogleDrive-***REMOVED***/내 드라이브/010_BlogPost';

/**
 * 포스팅을 마크다운 파일로 저장 + DB 기록
 * @param {{ title, content, category, postType, lectureNumber, charCount, hashtags }} postData
 * @returns {{ filepath, postId, filename }}
 */
async function publishToFile(postData) {
  const { title, content, category, postType, lectureNumber, charCount, hashtags } = postData;

  // output 디렉토리 보장
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const today     = new Date().toISOString().slice(0, 10);
  const safeTitle = (title || '').replace(/[^가-힣a-zA-Z0-9\s-]/g, '').slice(0, 50).trim();
  const filename  = `${today}_${postType}_${safeTitle}.md`;
  const filepath  = path.join(OUTPUT_DIR, filename);

  // 파일 헤더 + 본문
  const header = [
    `---`,
    `title: "${title}"`,
    `category: ${category}`,
    `type: ${postType}`,
    lectureNumber ? `lecture_number: ${lectureNumber}` : null,
    `char_count: ${charCount}`,
    `date: ${today}`,
    `status: ready`,
    `---`,
    '',
  ].filter(Boolean).join('\n');

  fs.writeFileSync(filepath, header + content, 'utf8');

  // 구글드라이브 추가 저장
  try {
    if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(GDRIVE_DIR, filename), header + content, 'utf8');
    console.log(`[퍼블] 구글드라이브 저장: ${filename}`);
  } catch (e) {
    console.warn('[퍼블] 구글드라이브 저장 실패:', e.message);
  }

  // DB 기록
  let postId = null;
  try {
    const rows = await pgPool.query('blog', `
      INSERT INTO blog.posts
        (title, category, post_type, lecture_number, publish_date, status, char_count, content, hashtags)
      VALUES ($1, $2, $3, $4, CURRENT_DATE + 1, 'ready', $5, $6, $7)
      RETURNING id
    `, [
      title,
      category,
      postType,
      lectureNumber || null,
      charCount,
      content,
      hashtags || [],
    ]);
    postId = rows[0]?.id;
    console.log(`[퍼블] 저장 완료: ${filename} (DB ID: ${postId})`);
  } catch (e) {
    console.warn('[퍼블] DB 저장 실패:', e.message);
  }

  // RAG 저장 — 과거 포스팅 참조 + 중복 방지용
  try {
    await rag.initSchema();
    await rag.store('blog',
      `[${postType}] ${title} | ${category}${lectureNumber ? ` | ${lectureNumber}강` : ''} | ${charCount}자`,
      {
        type:           postType,
        category,
        lecture_number: lectureNumber || null,
        char_count:     charCount,
        publish_date:   today,
        filename,
      },
      'blog-publ'
    );
  } catch (e) {
    console.warn('[퍼블] RAG 저장 실패:', e.message);
  }

  return { filepath, postId, filename };
}

/**
 * 포스팅 상태 업데이트 (발행 완료 시)
 */
async function markPublished(postId, naverUrl) {
  if (!postId) return;
  try {
    await pgPool.run('blog', `
      UPDATE blog.posts
      SET status = 'published', naver_url = $2
      WHERE id = $1
    `, [postId, naverUrl || null]);
  } catch (e) {
    console.warn('[퍼블] 상태 업데이트 실패:', e.message);
  }
}

module.exports = { publishToFile, markPublished, OUTPUT_DIR };
