#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { callHubLlm } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/hub-client'));
const { blog: blogSkills } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/index.js'));
const { writeGeneralPost, GEMS_SYSTEM_PROMPT } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/gems-writer.ts'));

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    topic: '일과 삶을 함께 돌아보게 만드는 책',
    save: !argv.includes('--no-save'),
    limit: 6,
    fast: !argv.includes('--full'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--topic') args.topic = argv[i + 1] || args.topic;
    if (token === '--limit') {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) args.limit = Math.min(parsed, 12);
    }
  }

  return args;
}

function slugify(value = '') {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 80);
}

function withTimeout(promise, timeoutMs, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), timeoutMs);
    }),
  ]);
}

function buildFallbackDraft(selected, topic) {
  const title = `${selected.title}, 지금 다시 읽어야 하는 이유`;
  const shortDesc = selected.description
    ? String(selected.description).replace(/\s+/g, ' ').trim().slice(0, 180)
    : '';
  const content = `
# ${title}

안녕하세요. 오늘은 ${selected.title} 이야기를 해보려고 합니다. 요즘은 실무 책이나 생산성 책만 계속 읽게 될 때가 많은데, 가끔은 전혀 다른 결의 책 한 권이 오히려 지금의 일과 삶을 더 선명하게 비춰줄 때가 있습니다. 이 책이 딱 그런 쪽에 가깝다고 느꼈습니다.

${selected.author ? `${selected.author}의 문장은` : '이 책의 문장은'} 독자를 몰아붙이기보다 한 걸음 멈추게 만듭니다. 그래서 이 책은 빠르게 읽고 덮는 책이라기보다, 읽는 동안 계속 자기 삶을 대입하게 만드는 책으로 남습니다. ${shortDesc || '특히 책이 던지는 질문은 일과 관계, 선택의 무게를 함께 생각하게 만듭니다.'}

제가 이 책을 블로그 도서리뷰 후보로 다시 올린 이유도 여기에 있습니다. 개발과 운영을 오래 하다 보면 효율, 속도, 문제 해결만을 앞세우게 될 때가 많습니다. 그런데 결국 일은 사람과 감정, 관계, 판단 위에서 움직입니다. 그런 점에서 ${selected.title}은(는) 실무 밖의 책처럼 보여도 오히려 실무를 더 오래 잘 해내기 위해 필요한 감각을 복원해주는 책이라고 느껴집니다.

이 책이 좋은 이유는 정답을 강하게 밀어붙이기보다, 독자 스스로 자기 삶의 질문을 꺼내게 만든다는 점입니다. 그래서 요즘처럼 일의 밀도는 높고 마음의 여유는 부족한 시기에 더 잘 읽히는 책이기도 합니다. 특히 "${topic}"라는 관점으로 다시 읽으면, 단순한 감상이 아니라 지금 내 삶의 방향을 점검하는 독서로 이어질 수 있습니다.

정식 리뷰에서는 이 책의 핵심 장면, 오래 남는 문장, 그리고 실제 일과 사람을 대하는 태도에 어떤 변화가 생기는지를 더 깊게 다뤄보면 좋겠습니다. 빠른 preview 초안이지만, 방향 자체는 충분히 괜찮다고 느껴집니다.
_THE_END_
`.trim();

  return {
    title,
    content,
    charCount: content.length,
    model: 'local/fallback-skeleton',
  };
}

async function selectBook(topic, limit = 6) {
  const [catalogBooks, reviewedHistory] = await Promise.all([
    blogSkills.bookReviewBook.loadCatalogBooks(),
    blogSkills.bookReviewBook.loadReviewedBookHistory(),
  ]);

  const preferredBooks = blogSkills.bookReviewBook.buildDiversePreferredBooks(
    catalogBooks,
    limit,
    reviewedHistory,
  );

  const selected = await blogSkills.bookReviewBook.resolveBookForReview({
    topic,
    keywords: [
      '인문학',
      '베스트셀러 소설',
      '삶을 돌아보는 책',
      '일과 사람에 대한 통찰',
      ...preferredBooks.map((book) => [book.title, book.author].filter(Boolean).join(' ')),
    ],
    preferredBooks,
  });

  return {
    preferredBooks,
    reviewedHistoryCount: Array.isArray(reviewedHistory) ? reviewedHistory.length : 0,
    selected,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selection = await selectBook(args.topic, args.limit);

  if (!selection.selected?.isbn) {
    throw new Error('검증된 도서 정보가 없어 draft 생성 불가');
  }

  const researchData = {
    weather: {},
    it_news: [],
    realExperiences: [],
    relatedPosts: [],
    popularPatterns: [],
    topic_hint: `${selection.selected.title}를 통해 일과 삶, 관계, 성장에 대해 돌아보는 리뷰`,
    topic_question: '이 책이 지금 우리 일과 삶에 어떤 질문을 던지는가?',
    topic_diff: '단순 줄거리 요약보다, 실제 삶과 일의 태도 변화에 초점을 맞춘다.',
    topic_title_candidate: `${selection.selected.title}, 지금 다시 읽어야 하는 이유`,
    strategy_focus: ['도서리뷰 다양화', '인문학/소설 확장'],
    strategy_recommendations: ['책의 핵심 질문을 삶과 연결', '리뷰보다 성찰형 에세이 톤 강화'],
    book_info: selection.selected,
  };
  let draft;
  if (args.fast) {
    const prompt = `
다음 도서로 블로그용 도서리뷰 preview 초안을 작성하라.

[도서]
- 제목: ${selection.selected.title}
- 저자: ${selection.selected.author || ''}
- 출판사: ${selection.selected.publisher || ''}
- 출판일: ${selection.selected.pubDate || ''}
- ISBN: ${selection.selected.isbn || ''}
- 소개: ${String(selection.selected.description || '').slice(0, 400)}

[글 방향]
- 단순 줄거리 요약보다, 이 책이 일과 삶과 관계를 어떻게 돌아보게 하는지 중심으로 쓸 것
- IT/개발 블로그 독자도 흥미를 느끼게 실무적 연결 한 문단 포함
- 소설/인문학/자기계발 어느 장르든 "왜 지금 읽을 만한가"를 분명히 할 것
- 존댓말
- 제목 1줄 + 본문
- 1800~2400자 분량
- 마지막 줄에 _THE_END_
`.trim();

    try {
      const result = await withTimeout(callHubLlm({
        callerTeam: 'blog',
        agent: 'book-review-draft',
        selectorKey: 'blog.book_review.preview',
        taskType: 'book_review_preview',
        systemPrompt: GEMS_SYSTEM_PROMPT,
        prompt,
        maxTokens: 2600,
        timeoutMs: 25000,
      }), 30000, 'fast_draft_timeout');

      const content = String(result.text || '').trim();
      const title = content.split('\n')[0]?.replace(/^#+\s*/, '').trim() || `${selection.selected.title}, 지금 다시 읽어야 하는 이유`;
      draft = {
        title,
        content,
        charCount: content.length,
        model: result.selected_route || result.model || result.provider || 'hub',
      };
    } catch (error) {
      console.warn(`[book-review draft] fast draft fallback 사용: ${error.message}`);
      draft = buildFallbackDraft(selection.selected, args.topic);
    }
  } else {
    draft = await writeGeneralPost('도서리뷰', researchData, {});
  }
  const payload = {
    topic: args.topic,
    fast: args.fast,
    reviewedHistoryCount: selection.reviewedHistoryCount,
    selected: selection.selected,
    title: draft.title,
    charCount: draft.charCount,
    model: draft.model,
  };
  /** @type {any} */
  const typedPayload = payload;

  if (args.save) {
    const draftDir = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output', 'drafts');
    fs.mkdirSync(draftDir, { recursive: true });
    const filePath = path.join(draftDir, `${slugify(draft.title || selection.selected.title)}.md`);
    fs.writeFileSync(filePath, String(draft.content || ''), 'utf8');
    // @ts-ignore payload is intentionally extended with filePath at runtime
    typedPayload.filePath = filePath;
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[book-review draft] title=${payload.title}`);
  console.log(`[book-review draft] chars=${payload.charCount} model=${payload.model}`);
  // @ts-ignore payload is intentionally extended with filePath at runtime
  if (typedPayload.filePath) console.log(`[book-review draft] file=${typedPayload.filePath}`);
}

main().catch((error) => {
  console.error('[book-review draft] 실패:', error?.message || error);
  process.exit(1);
});
