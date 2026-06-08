const pgPool = require('../../../../packages/core/lib/pg-pool');
const eventLake = require('../../../../packages/core/lib/event-lake');

type TopicCandidate = {
  category?: unknown;
  title?: unknown;
  question?: unknown;
  diff?: unknown;
  keywords?: unknown;
  score?: unknown;
};

function text(value: unknown, fallback = '', max = 1000): string {
  const normalized = String(value == null ? fallback : value).trim();
  return (normalized || fallback).slice(0, max);
}

function score(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
}

function keywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, '', 80))
    .filter(Boolean)
    .slice(0, 20);
}

function validDate(value: unknown): string {
  const date = text(value, '', 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  return date;
}

function normalizeCandidate(candidate: TopicCandidate) {
  const title = text(candidate?.title, '', 240);
  return {
    category: text(candidate?.category, '자기계발', 80),
    title,
    question: text(candidate?.question, '', 1000),
    diff: text(candidate?.diff, '', 1000),
    keywords: keywords(candidate?.keywords),
    score: score(candidate?.score),
  };
}

export async function blogTopicCandidatesRoute(req: any, res: any) {
  try {
    const targetDate = validDate(req.body?.target_date || req.body?.targetDate);
    const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    if (!targetDate) return res.status(400).json({ ok: false, error: 'valid target_date required' });
    if (candidates.length === 0) return res.status(400).json({ ok: false, error: 'candidates required' });
    if (candidates.length > 50) return res.status(400).json({ ok: false, error: 'too many candidates' });

    const rejected: Array<Record<string, unknown>> = [];
    const normalizedCandidates = candidates
      .map((rawCandidate: TopicCandidate) => normalizeCandidate(rawCandidate || {}))
      .filter((candidate: ReturnType<typeof normalizeCandidate>) => {
        if (candidate.title) return true;
        rejected.push({ reason: 'missing_title', category: candidate.category });
        return false;
      });

    const saved = await pgPool.transaction('blog', async (client: any) => {
      let savedCount = 0;
      for (const candidate of normalizedCandidates) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [`${targetDate}|${candidate.category}|${candidate.title}`],
        );
        const result = await client.query(`
          WITH input AS (
            SELECT
              $1::text AS category,
              $2::text AS title,
              $3::text AS question,
              $4::text AS diff,
              $5::text[] AS keywords,
              $6::numeric AS score,
              $7::date AS target_date
          )
          INSERT INTO blog.topic_candidates
            (category, title, question, diff, keywords, score, status, target_date)
          SELECT category, title, question, diff, keywords, score, 'pending', target_date
          FROM input
          WHERE NOT EXISTS (
            SELECT 1
            FROM blog.topic_candidates existing
            WHERE existing.target_date = input.target_date
              AND existing.category = input.category
              AND existing.title = input.title
          )
        `, [
          candidate.category,
          candidate.title,
          candidate.question,
          candidate.diff,
          candidate.keywords,
          candidate.score,
          targetDate,
        ]);
        savedCount += Number(result?.rowCount || 0);
      }
      return savedCount;
    });

    await eventLake.record({
      eventType: 'hub_blog_topic_candidates_saved',
      team: 'blog',
      botName: 'hub-blog-topic-candidates',
      severity: saved > 0 ? 'info' : 'warn',
      traceId: req.hubRequestContext?.traceId || '',
      title: 'Blog topic candidates saved through typed mutation route',
      message: `target_date=${targetDate} saved=${saved} rejected=${rejected.length}`,
      tags: ['hub', 'blog', 'topic_candidates', 'typed_mutation'],
      metadata: {
        target_date: targetDate,
        saved,
        rejected_count: rejected.length,
        rejected: rejected.slice(0, 10),
        source: 'hub_typed_mutation_api',
      },
    }).catch(() => null);

    return res.json({
      ok: true,
      target_date: targetDate,
      saved_count: saved,
      rejected_count: rejected.length,
      rejected,
    });
  } catch (error: any) {
    console.warn('[hub/blog/topic-candidates] save failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'topic_candidates_save_failed' });
  }
}

module.exports = {
  blogTopicCandidatesRoute,
  normalizeCandidate,
};
