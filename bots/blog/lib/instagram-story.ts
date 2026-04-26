'use strict';

/**
 * bots/blog/lib/instagram-story.ts
 * 인스타그램 스토리 자동화 (24시간 휘발성 콘텐츠)
 *
 * Phase 4 누락 구현: 일일 스토리 자동 생성 + 발행
 * Kill Switch: BLOG_MULTI_PLATFORM_ENABLED=true
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');

function isEnabled() {
  return process.env.BLOG_MULTI_PLATFORM_ENABLED === 'true';
}

const STORY_TYPE_ROTATION = ['quote', 'tip', 'behind_the_scenes', 'poll'];

const STORY_TEMPLATES = {
  quote: {
    headlines: ['오늘의 공부 명언 💬', '집중력을 높이는 한마디 ✨', '지금 이 순간에 집중 🎯'],
    bodies: [
      '"공부는 재능이 아니라 습관이다."',
      '"집중된 1시간이 산만한 하루보다 낫다."',
      '"작은 진보가 쌓여 큰 성공이 된다."',
      '"오늘 공부한 것이 내일의 나를 만든다."',
    ],
  },
  tip: {
    headlines: ['공부 꿀팁 🍯', '집중력 UP 비법 📈', '스터디카페 200% 활용법 💡'],
    bodies: [
      '포모도로 기법: 25분 집중 + 5분 휴식\n⏱️ 딱 4사이클 = 완전 집중 모드',
      '공부 시작 전 3분 스트레칭\n🙆 몸 풀기 = 뇌 활성화',
      '배경음악은 가사 없는 클래식\n🎵 집중력 30% 향상 연구 결과',
      '물 한 잔 마시고 시작\n💧 뇌는 수분에 민감해요',
    ],
  },
  behind_the_scenes: {
    headlines: ['오늘의 스터디카페 🏛️', '지금 이 시각 스터디카페 ☕', '조용하고 쾌적한 공간 🌿'],
    bodies: [
      '오늘도 공부하는 분들로 가득한 우리 카페\n📚 함께 집중하는 에너지가 느껴지나요?',
      '창가 자리에서 바라보는 오늘 날씨\n☀️ 따뜻한 날 공부 효율 최고예요',
      '향기로운 커피 한 잔과 함께하는 집중 시간\n☕ 오늘 공부 어떠셨나요?',
    ],
  },
  poll: {
    headlines: ['오늘 공부 어떠셨나요? 🗳️', '투표해주세요! 📊', '여러분의 의견은? 🤔'],
    bodies: ['공부할 때 어떤 환경이 더 좋으신가요?', '오늘 집중력 점수는?', '스터디카페 추천 시간대는?'],
  },
};

const POLL_QUESTIONS = [
  { question: '공부할 때 선호하는 환경은?', options: ['조용한 스터디카페 🏛️', '카페 분위기 ☕'] },
  { question: '오늘 집중력 점수는?', options: ['완벽 집중 100점 💯', '조금 힘들었어 😅'] },
  { question: '공부 시작 시간은?', options: ['아침형 🌅', '저녁형 🌙'] },
  { question: '공부 중 음료는?', options: ['커피가 필수 ☕', '물이면 충분 💧'] },
];

function selectStoryType() {
  const dayOfWeek = new Date().getDay();
  return STORY_TYPE_ROTATION[dayOfWeek % STORY_TYPE_ROTATION.length];
}

function generateStoryContent(type, blogUrl) {
  const template = STORY_TEMPLATES[type];
  const headline = template.headlines[Math.floor(Math.random() * template.headlines.length)];
  const body = template.bodies[Math.floor(Math.random() * template.bodies.length)];

  const baseHashtags = ['#스터디카페', '#공부스타그램', '#집중'];

  if (type === 'poll') {
    const poll = POLL_QUESTIONS[Math.floor(Math.random() * POLL_QUESTIONS.length)];
    return {
      type,
      headline,
      body: poll.question,
      cta: '투표하고 결과 확인해요!',
      poll_question: poll.question,
      poll_options: poll.options,
      hashtags: [...baseHashtags, '#공부', '#투표'],
    };
  }

  return {
    type,
    headline,
    body,
    cta: type === 'tip' ? '블로그에서 더 보기 →' : '함께 집중해요 💪',
    link: blogUrl,
    hashtags: [...baseHashtags, '#공부카페', '#스터디'],
  };
}

async function callInstagramStoryApi(content) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  const igUserId = process.env.INSTAGRAM_USER_ID || '';
  const storyImageUrl = process.env.STORY_DEFAULT_IMAGE_URL || '';

  if (!accessToken || !igUserId || !storyImageUrl) {
    console.warn('[인스타스토리] 필수 환경변수 미설정 — 발행 스킵');
    return null;
  }

  const https = require('https');
  const caption = [content.headline, '', content.body, '', content.cta, '', content.hashtags.join(' ')].join('\n');
  const mediaParams = new URLSearchParams({ image_url: storyImageUrl, caption, media_type: 'IMAGE', is_carousel_item: 'false', access_token: accessToken });

  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'graph.facebook.com', path: `/v18.0/${igUserId}/media`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.id) {
              publishMediaContainer(igUserId, data.id, accessToken).then(resolve).catch(() => resolve(null));
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.write(mediaParams.toString());
    req.end();
  });
}

async function publishMediaContainer(igUserId, containerId, accessToken) {
  const https = require('https');
  const params = new URLSearchParams({ creation_id: containerId, access_token: accessToken });

  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'graph.facebook.com', path: `/v18.0/${igUserId}/media_publish`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try { resolve(JSON.parse(body).id || null); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.write(params.toString());
    req.end();
  });
}

async function publishDailyStory(blogUrl) {
  if (!isEnabled()) {
    return { success: false, error: 'BLOG_MULTI_PLATFORM_ENABLED=false', story_type: 'tip', published_at: new Date().toISOString() };
  }

  const storyType = selectStoryType();
  const content = generateStoryContent(storyType, blogUrl);

  console.log(`[인스타스토리] 스토리 타입: ${storyType} — 발행 시작`);

  const storyId = await runIfOps(() => callInstagramStoryApi(content));

  const result = {
    success: !!storyId,
    story_id: storyId || undefined,
    error: storyId ? undefined : '발행 실패 (API 오류 또는 미설정)',
    story_type: storyType,
    published_at: new Date().toISOString(),
  };

  if (result.success) {
    await runIfOps(() => postAlarm(`📱 인스타 스토리 발행 성공\n타입: ${storyType}\n헤드라인: ${content.headline}`));
  }

  try {
    await pgPool.query(
      'blog',
      `INSERT INTO blog.publish_log (platform, status, title, error, duration_ms, post_id, created_at) VALUES ('instagram_story', $1, $2, $3, 0, $4, NOW())`,
      [result.success ? 'success' : 'failed', content.headline, result.error || null, result.story_id || null]
    );
  } catch (e) {
    console.warn('[인스타스토리] DB 기록 실패:', e.message);
  }

  return result;
}

module.exports = { publishDailyStory, generateStoryContent, selectStoryType };
