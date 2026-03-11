'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * publ.js (퍼블리셔) — 포스팅 파일 생성 + DB 기록
 *
 * Level 1: HTML 파일 생성 → 마스터가 네이버 블로그에 복붙
 */

const fs     = require('fs');
const path   = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');
const rag    = require('../../../packages/core/lib/rag');

const OUTPUT_DIR    = path.join(__dirname, '..', 'output');
const GDRIVE_DIR    = '/Users/alexlee/Library/CloudStorage/GoogleDrive-***REMOVED***/내 드라이브/010_BlogPost';

// ─── 텍스트 → HTML 변환 ──────────────────────────────────────────────

function _contentToHtml(content, title, images = null) {
  // _THE_END_ 제거
  let text = content.replace(/_THE_END_\s*$/, '').trim();

  // 코드 블록 처리 (```언어 ... ```)
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code class="language-${lang || 'text'}">${escaped.trim()}</code></pre>`;
  });

  const lines   = text.split('\n');
  const htmlLines = [];
  let inPre = false;

  for (const line of lines) {
    // pre 블록 — 같은 줄에 </pre>가 있으면 단일행 블록 (inPre 유지 X)
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

    // 섹션 헤더: [섹션명] (뒤 공백/탭 허용)
    const secMatch = line.match(/^\[(.+)\]\s*$/);
    if (secMatch) {
      htmlLines.push(`<h2 class="section-title">${secMatch[1]}</h2>`);
      continue;
    }

    // 구분선 (━ 3개 이상 또는 --- 3개 이상)
    if (/^━{3,}/.test(line) || /^-{3,}$/.test(line.trim())) {
      htmlLines.push('<hr class="section-divider">');
      continue;
    }

    // 해시태그 라인
    if (line.trim().startsWith('#') && line.includes(' #')) {
      const tags = line.trim().split(/\s+/).filter(t => t.startsWith('#'));
      const tagHtml = tags.map(t => `<span class="hashtag">${t}</span>`).join(' ');
      htmlLines.push(`<p class="hashtags">${tagHtml}</p>`);
      continue;
    }

    // 빈 줄
    if (!line.trim()) { htmlLines.push('<br>'); continue; }

    // 일반 줄 — 인라인 강조 변환
    let l = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')  // 굵게
      .replace(/`([^`]+)`/g, '<code>$1</code>');          // 인라인 코드

    // 제목과 동일한 첫 줄 중복 스킵
    const cleanTitle = (title || '').replace(/[^가-힣a-zA-Z0-9\s]/g, '').trim();
    const cleanLine  = line.replace(/[^가-힣a-zA-Z0-9\s]/g, '').trim();
    if (cleanLine && cleanLine === cleanTitle && htmlLines.length < 5) continue;

    htmlLines.push(`<p>${l}</p>`);
  }

  const body = htmlLines.join('\n');

  // 이미지 HTML 생성
  const thumbImg = images?.thumb?.filename
    ? `<div class="post-thumb"><img src="images/${images.thumb.filename}" alt="${title || ''}" loading="lazy"></div>`
    : '';
  const midImg = images?.mid?.filename
    ? `<div class="post-mid-img"><img src="images/${images.mid.filename}" alt="${title || ''} 본문 이미지" loading="lazy"></div>`
    : '';

  // 본문 중간에 midImg 삽입 (전체 본문의 40% 위치 부근 <h2> 앞)
  let finalBody = body;
  if (midImg) {
    const bodyParts = finalBody.split('<h2 class="section-title">');
    // 두 번째 섹션 헤더 앞에 삽입 (없으면 본문 중간)
    if (bodyParts.length >= 3) {
      bodyParts[2] = midImg + '\n<h2 class="section-title">' + bodyParts[2];
      finalBody = bodyParts[0] + '<h2 class="section-title">' + bodyParts.slice(1).join('<h2 class="section-title">');
    } else if (bodyParts.length === 2) {
      bodyParts[1] = midImg + '\n<h2 class="section-title">' + bodyParts[1];
      finalBody = bodyParts[0] + bodyParts[1];
    } else {
      // 섹션 없으면 본문 끝에 추가
      finalBody = body + '\n' + midImg;
    }
  }

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
  .post-thumb { margin: 0 0 24px; text-align: center; }
  .post-thumb img { max-width: 100%; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); }
  .post-mid-img { margin: 24px 0; text-align: center; }
  .post-mid-img img { max-width: 100%; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.10); }
</style>
</head>
<body>
<h1 class="post-title">${title || ''}</h1>
${thumbImg}
${finalBody}
</body>
</html>`;
}

/**
 * 포스팅을 HTML 파일로 저장 + DB 기록
 * @param {{ title, content, category, postType, lectureNumber, charCount, hashtags, images }} postData
 * @returns {{ filepath, postId, filename }}
 */
async function publishToFile(postData) {
  const { title, content, category, postType, lectureNumber, charCount, hashtags, images } = postData;

  // output 디렉토리 보장
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const today     = kst.today();
  const safeTitle = (title || '').replace(/[^가-힣a-zA-Z0-9\s-]/g, '').slice(0, 50).trim();
  const filename  = `${today}_${postType}_${safeTitle}.html`;
  const filepath  = path.join(OUTPUT_DIR, filename);

  // HTML 변환 (이미지 포함)
  const htmlContent = _contentToHtml(content, title, images);

  fs.writeFileSync(filepath, htmlContent, 'utf8');

  // 구글드라이브 추가 저장
  try {
    if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(GDRIVE_DIR, filename), htmlContent, 'utf8');
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
