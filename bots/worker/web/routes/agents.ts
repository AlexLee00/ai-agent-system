// @ts-nocheck
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

async function proxyHubAgentsWithBody(hubPath, body, timeoutMs = 4000) {
  const baseUrl = String(env.HUB_BASE_URL || 'http://localhost:7788').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${hubPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN || ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
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

  app.get('/api/skills', authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams();
      if (req.query.team) params.set('team', String(req.query.team));
      if (req.query.category) params.set('category', String(req.query.category));
      const query = params.toString() ? `?${params.toString()}` : '';
      const data = await proxyHubAgents(`/hub/skills${query}`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '스킬 목록을 불러오지 못했습니다.' });
    }
  });

  app.get('/api/skills/select', authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams();
      if (req.query.team) params.set('team', String(req.query.team));
      if (req.query.category) params.set('category', String(req.query.category));
      const query = params.toString() ? `?${params.toString()}` : '';
      const data = await proxyHubAgents(`/hub/skills/select${query}`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '스킬 선택에 실패했습니다.' });
    }
  });

  app.post('/api/skills/evaluate', authMiddleware, async (req, res) => {
    try {
      const data = await proxyHubAgentsWithBody('/hub/skills/evaluate', req.body || {});
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '스킬 평가 반영에 실패했습니다.' });
    }
  });

  app.get('/api/tools', authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams();
      if (req.query.team) params.set('team', String(req.query.team));
      if (req.query.capability) params.set('capability', String(req.query.capability));
      const query = params.toString() ? `?${params.toString()}` : '';
      const data = await proxyHubAgents(`/hub/tools${query}`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '도구 목록을 불러오지 못했습니다.' });
    }
  });

  app.get('/api/tools/select', authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams();
      if (req.query.team) params.set('team', String(req.query.team));
      if (req.query.capability) params.set('capability', String(req.query.capability));
      const query = params.toString() ? `?${params.toString()}` : '';
      const data = await proxyHubAgents(`/hub/tools/select${query}`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '도구 선택에 실패했습니다.' });
    }
  });

  app.post('/api/tools/evaluate', authMiddleware, async (req, res) => {
    try {
      const data = await proxyHubAgentsWithBody('/hub/tools/evaluate', req.body || {});
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '도구 평가 반영에 실패했습니다.' });
    }
  });

  app.post('/api/agents/competition/start', authMiddleware, async (req, res) => {
    try {
      const data = await proxyHubAgentsWithBody('/hub/agents/competition/start', req.body || {});
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '경쟁 시작에 실패했습니다.' });
    }
  });

  app.post('/api/agents/competition/complete', authMiddleware, async (req, res) => {
    try {
      const data = await proxyHubAgentsWithBody('/hub/agents/competition/complete', req.body || {});
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '경쟁 완료 처리에 실패했습니다.' });
    }
  });

  app.get('/api/agents/competition/history', authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams();
      if (req.query.team) params.set('team', String(req.query.team));
      if (req.query.limit) params.set('limit', String(req.query.limit));
      const query = params.toString() ? `?${params.toString()}` : '';
      const data = await proxyHubAgents(`/hub/agents/competition/history${query}`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '경쟁 이력을 불러오지 못했습니다.' });
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
