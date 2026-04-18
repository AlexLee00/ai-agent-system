/**
 * bots/blog/api/roi-dashboard.ts
 * ROI 대시보드 API 엔드포인트 (node-server에 마운트)
 *
 * Phase 2: 블로팀 마케팅 → 스카팀 매출 ROI 조회
 * Kill Switch: BLOG_REVENUE_CORRELATION_ENABLED=true
 *
 * 엔드포인트:
 *   GET /roi/summary?days=30
 *   GET /roi/top-posts?days=30&limit=10
 *   GET /roi/category-weights
 */

const skaRevenueBridge = require('../lib/ska-revenue-bridge');
const pgPool = require('../../../packages/core/lib/pg-pool');

function createRoiRouter(express: any) {
  const router = express.Router();

  // ROI 전체 요약
  router.get('/summary', async (req: any, res: any) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 90);
      const summary = await skaRevenueBridge.getRoiSummary(days);
      res.json({ ok: true, data: summary });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 매출 기여도 상위 포스팅
  router.get('/top-posts', async (req: any, res: any) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 90);
      const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

      const rows = await pgPool.query('blog', `
        SELECT
          a.post_id, a.post_title, a.post_url, a.post_platform,
          a.post_published_at, a.uplift_krw, a.attribution_confidence,
          a.utm_visits, a.direct_conversion_count
        FROM blog.post_revenue_attribution a
        WHERE a.post_published_at > NOW() - ($1::text || ' days')::interval
        ORDER BY a.uplift_krw DESC
        LIMIT $2
      `, [days, limit]);

      res.json({
        ok: true,
        data: (rows || []).map((r: any) => ({
          post_id: r.post_id,
          title: r.post_title,
          url: r.post_url,
          platform: r.post_platform,
          published_at: r.post_published_at,
          uplift_krw: Math.round(Number(r.uplift_krw || 0)),
          confidence: Number((r.attribution_confidence || 0).toFixed(2)),
          utm_visits: Number(r.utm_visits || 0),
          conversions: Number(r.direct_conversion_count || 0),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // topic-selector에 전달할 카테고리별 가중치
  router.get('/category-weights', async (req: any, res: any) => {
    try {
      const categories = await skaRevenueBridge.getTopRevenueCategories(30);
      res.json({ ok: true, data: categories });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createRoiRouter };
