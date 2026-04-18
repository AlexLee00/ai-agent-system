/**
 * bots/blog/api/node-server.ts — 블로그 노드 API 서버
 *
 * n8n이 각 파이프라인 노드를 HTTP로 호출.
 * 포트: 3100 (BLOG_API_PORT 환경변수로 변경 가능)
 *
 * 실행: node bots/blog/api/node-server.ts
 *
 * [의존성] express 필요
 *   미설치 시: cd bots/blog && npm install express --save
 */

let express: any;
try {
  express = require('express');
} catch {
  console.error('[노드서버] express 모듈이 없습니다.');
  console.error('  설치 방법: cd bots/blog && npm install express --save');
  process.exit(1);
}

const pipelineStore = require('../lib/pipeline-store.ts');
const richer = require('../lib/richer.ts');
const posWriter = require('../lib/pos-writer.ts');
const gemsWriter = require('../lib/gems-writer.ts');
const { checkQualityEnhanced } = require('../lib/quality-checker.ts');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { initHubConfig } = require('../../../packages/core/lib/llm-keys');
const { parseNaverBlogUrl } = require('../../../packages/core/lib/naver-blog-url');
const { markPublished } = require('../lib/publ.ts');
const { createRoiRouter } = require('./roi-dashboard.ts');

const PORT = process.env.BLOG_API_PORT || 3100;
const HOST = process.env.BLOG_API_HOST || '127.0.0.1';
const app = express();
app.use(express.json());

function getRemoteIp(req: any) {
  return String(
    req.headers['x-forwarded-for']
    || req.socket?.remoteAddress
    || req.ip
    || '',
  ).split(',')[0].trim();
}

function isLocalRequest(req: any) {
  const ip = getRemoteIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireLocalNodeAccess(req: any, res: any, next: any) {
  if (isLocalRequest(req)) return next();
  return res.status(403).json({ ok: false, error: '로컬 노드 접근만 허용됩니다.' });
}

async function bootstrap() {
  await initHubConfig();
  pipelineStore.ensureSchema().catch((e: any) =>
    console.warn('[노드서버] RAG 스토어 스키마 초기화 실패 (무시):', e.message),
  );

  app.listen(PORT, HOST, () => {
    console.log(`[노드서버] 블로그 노드 API 서버 기동 — ${HOST}:${PORT}`);
    console.log(`  헬스체크: http://${HOST}:${PORT}/health`);
  });
}

app.get('/health', (_req: any, res: any) => {
  res.json({ ok: true, port: PORT });
});

// Phase 2: ROI 대시보드 (로컬 접근 전용)
app.use('/roi', requireLocalNodeAccess, createRoiRouter(express));

async function findTargetPost({ postId, scheduleId }: { postId?: number | null; scheduleId?: string | number | null }) {
  if (postId) {
    return pgPool.get('blog', `
      SELECT id, title, status, naver_url, metadata, created_at
      FROM blog.posts
      WHERE id = $1
    `, [postId]);
  }

  if (scheduleId) {
    return pgPool.get('blog', `
      SELECT id, title, status, naver_url, metadata, created_at
      FROM blog.posts
      WHERE metadata->>'schedule_id' = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [String(scheduleId)]);
  }

  return null;
}

app.post('/api/blog/node/weather', async (req: any, res: any) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const result = await richer.fetchWeather();
    await pipelineStore.storeNodeResult(sessionId, 'weather', 'research', result);
    res.json({ ok: true, result });
  } catch (e: any) {
    console.error('[노드서버] /weather 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/node/it-news', async (req: any, res: any) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const result = await richer.fetchITNews(5);
    await pipelineStore.storeNodeResult(sessionId, 'it-news', 'research', result);
    res.json({ ok: true, result });
  } catch (e: any) {
    console.error('[노드서버] /it-news 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/node/nodejs-updates', async (req: any, res: any) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const result = await richer.fetchNodejsUpdates();
    await pipelineStore.storeNodeResult(sessionId, 'nodejs-updates', 'research', result);
    res.json({ ok: true, result });
  } catch (e: any) {
    console.error('[노드서버] /nodejs-updates 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/node/rag-experiences', async (req: any, res: any) => {
  const { sessionId, topic, postType } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const result = await richer.searchRealExperiences(topic || '', postType || 'general');
    await pipelineStore.storeNodeResult(sessionId, 'rag-experiences', 'research', result);
    res.json({ ok: true, result });
  } catch (e: any) {
    console.error('[노드서버] /rag-experiences 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/node/related-posts', async (req: any, res: any) => {
  const { sessionId, topic, lectureNumber } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const result = await richer.searchRelatedPosts(topic || '', lectureNumber || null);
    await pipelineStore.storeNodeResult(sessionId, 'related-posts', 'research', result);
    res.json({ ok: true, result });
  } catch (e: any) {
    console.error('[노드서버] /related-posts 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/node/write-lecture', async (req: any, res: any) => {
  const { sessionId, lectureNumber, lectureTitle, sectionVariation } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const existing = await pipelineStore.getNodeResult(sessionId, 'write-lecture');
    if (existing && existing.content) {
      return res.json({
        ok: true,
        charCount: existing.charCount || existing.content.length || 0,
        model: existing.model || null,
        cached: true,
      });
    }

    const sessionData = await pipelineStore.getSessionResults(sessionId);
    const researchData = {
      weather: sessionData.weather || {},
      it_news: sessionData['it-news'] || [],
      nodejs_updates: sessionData['nodejs-updates'] || [],
      realExperiences: sessionData['rag-experiences'] || [],
      relatedPosts: sessionData['related-posts'] || [],
    };

    const useChunked = process.env.BLOG_LLM_MODEL === 'gemini';
    const post = useChunked
      ? await posWriter.writeLecturePostChunked(lectureNumber, lectureTitle, researchData, sectionVariation || {})
      : await posWriter.writeLecturePost(lectureNumber, lectureTitle, researchData, sectionVariation || {});

    await pipelineStore.storeNodeResult(sessionId, 'write-lecture', 'generate', post);

    res.json({ ok: true, charCount: post.charCount, model: post.model, mode: useChunked ? 'chunked' : 'single' });
  } catch (e: any) {
    console.error('[노드서버] /write-lecture 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/node/write-general', async (req: any, res: any) => {
  const { sessionId, category, sectionVariation } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const existing = await pipelineStore.getNodeResult(sessionId, 'write-general');
    if (existing && existing.content) {
      return res.json({
        ok: true,
        charCount: existing.charCount || existing.content.length || 0,
        model: existing.model || null,
        cached: true,
      });
    }

    const sessionData = await pipelineStore.getSessionResults(sessionId);
    const researchData = {
      weather: sessionData.weather || {},
      it_news: sessionData['it-news'] || [],
      realExperiences: sessionData['rag-experiences'] || [],
      relatedPosts: sessionData['related-posts'] || [],
    };

    const useChunked = process.env.BLOG_LLM_MODEL === 'gemini';
    const post = useChunked
      ? await gemsWriter.writeGeneralPostChunked(category, researchData, sectionVariation || {})
      : await gemsWriter.writeGeneralPost(category, researchData, sectionVariation || {});

    await pipelineStore.storeNodeResult(sessionId, 'write-general', 'generate', post);

    res.json({ ok: true, charCount: post.charCount, model: post.model, mode: useChunked ? 'chunked' : 'single' });
  } catch (e: any) {
    console.error('[노드서버] /write-general 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/node/quality-check', async (req: any, res: any) => {
  const {
    sessionId,
    postType,
    category = null,
    lectureNumber = null,
    lectureTitle = null,
    bookInfo = null,
  } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const existing = await pipelineStore.getNodeResult(sessionId, 'quality-check');
    if (existing && typeof existing === 'object' && existing.passed != null) {
      return res.json({
        ok: true,
        passed: existing.passed,
        charCount: existing.charCount || 0,
        aiRisk: existing.aiRisk || null,
        issues: existing.issues || [],
        autoRewriteRecommended: !!existing.autoRewriteRecommended,
        cached: true,
      });
    }

    const nodeId = postType === 'lecture' ? 'write-lecture' : 'write-general';
    const postData = await pipelineStore.getNodeResult(sessionId, nodeId);
    if (!postData) {
      return res.status(404).json({ ok: false, error: '생성된 포스팅이 없습니다' });
    }

    const content = typeof postData === 'object' ? (postData.content || '') : postData;
    const quality = await checkQualityEnhanced(content, postType || 'general', {
      lectureNumber,
      expectedLectureTitle: lectureTitle,
      category,
      bookInfo,
    });

    await pipelineStore.storeNodeResult(sessionId, 'quality-check', 'validate', quality);

    res.json({
      ok: true,
      passed: quality.passed,
      charCount: content.length,
      aiRisk: quality.aiRisk,
      issues: quality.issues || [],
      autoRewriteRecommended: !!quality.autoRewriteRecommended,
    });
  } catch (e: any) {
    console.error('[노드서버] /quality-check 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/rag/store', requireLocalNodeAccess, async (req: any, res: any) => {
  const { sessionId, nodeId, nodeGroup, data } = req.body;
  if (!sessionId || !nodeId) {
    return res.status(400).json({ ok: false, error: 'sessionId, nodeId 필수' });
  }
  try {
    await pipelineStore.storeNodeResult(sessionId, nodeId, nodeGroup, data);
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[노드서버] /rag/store 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/blog/mark-published', requireLocalNodeAccess, async (req: any, res: any) => {
  const { postId = null, scheduleId = null, url } = req.body || {};
  if (!url) {
    return res.status(400).json({ ok: false, error: 'url 필수' });
  }
  if (!postId && !scheduleId) {
    return res.status(400).json({ ok: false, error: 'postId 또는 scheduleId 필수' });
  }

  const parsed = parseNaverBlogUrl(url);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: `유효한 네이버 블로그 URL이 아닙니다: ${parsed.reason}` });
  }

  try {
    const row = await findTargetPost({ postId, scheduleId });
    if (!row) {
      return res.status(404).json({ ok: false, error: '대상 blog.posts 행을 찾을 수 없습니다.' });
    }

    await markPublished(row.id, parsed.canonicalUrl);

    return res.json({
      ok: true,
      postId: row.id,
      title: row.title,
      status: 'published',
      savedUrl: parsed.canonicalUrl,
      blogId: parsed.blogId,
      logNo: parsed.logNo,
    });
  } catch (e: any) {
    console.error('[노드서버] /mark-published 오류:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/blog/rag/get', requireLocalNodeAccess, async (req: any, res: any) => {
  const { sessionId, nodeId } = req.query;
  if (!sessionId || !nodeId) {
    return res.status(400).json({ ok: false, error: 'sessionId, nodeId 필수' });
  }
  try {
    const data = await pipelineStore.getNodeResult(sessionId, nodeId);
    res.json({ ok: true, data });
  } catch (e: any) {
    console.error('[노드서버] /rag/get 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/blog/rag/session', requireLocalNodeAccess, async (req: any, res: any) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId 필수' });
  try {
    const data = await pipelineStore.getSessionResults(sessionId);
    res.json({ ok: true, data });
  } catch (e: any) {
    console.error('[노드서버] /rag/session 오류:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

bootstrap().catch((error: any) => {
  console.error('[노드서버] 기동 실패:', error.message);
  process.exit(1);
});

module.exports = app;
