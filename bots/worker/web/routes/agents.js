'use strict';

const env = require('../../../../packages/core/lib/env');

async function proxyHubAgents(hubPath, timeoutMs = 4000) {
  const baseUrl = String(env.HUB_BASE_URL || 'http://localhost:7788').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${hubPath}`, {
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN || ''}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = data.error || `Hub HTTP ${response.status}`;
      throw new Error(error);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = function mountAgentRoutes(app, authMiddleware) {
  app.get('/api/agents', authMiddleware, async (req, res) => {
    try {
      const data = await proxyHubAgents('/hub/agents');
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '에이전트 목록을 불러오지 못했습니다.' });
    }
  });

  app.get('/api/agents/dashboard', authMiddleware, async (req, res) => {
    try {
      const data = await proxyHubAgents('/hub/agents/dashboard');
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '에이전트 대시보드를 불러오지 못했습니다.' });
    }
  });

  app.get('/api/agents/always-on', authMiddleware, async (req, res) => {
    try {
      const data = await proxyHubAgents('/hub/agents/always-on');
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '상시 에이전트 상태를 불러오지 못했습니다.' });
    }
  });

  app.get('/api/agents/stats/traces', authMiddleware, async (req, res) => {
    try {
      const query = req.query.days ? `?days=${encodeURIComponent(req.query.days)}` : '';
      const data = await proxyHubAgents(`/hub/agents/stats/traces${query}`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '에이전트 trace 통계를 불러오지 못했습니다.' });
    }
  });

  app.get('/api/agents/:name/stats/traces', authMiddleware, async (req, res) => {
    try {
      const query = req.query.days ? `?days=${encodeURIComponent(req.query.days)}` : '';
      const data = await proxyHubAgents(`/hub/agents/${encodeURIComponent(req.params.name)}/stats/traces${query}`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '에이전트 상세 trace 통계를 불러오지 못했습니다.' });
    }
  });

  app.get('/api/agents/:name', authMiddleware, async (req, res) => {
    try {
      const data = await proxyHubAgents(`/hub/agents/${encodeURIComponent(req.params.name)}`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '에이전트 상세를 불러오지 못했습니다.' });
    }
  });
};
