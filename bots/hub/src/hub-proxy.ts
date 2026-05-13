/**
 * hub-proxy.ts — Blue-Green 트래픽 라우터 (port 7780)
 *
 * /tmp/hub-bg-state.json 을 읽어 blue(7788) 또는 green(7789) 으로 요청을 프록시.
 * 상태 파일 없으면 blue 기본 사용.
 *
 * launchd: ai.hub.bg-proxy (port 7780)
 */

import http from 'http';
import fs from 'fs';

const PROXY_PORT = parseInt(process.env.HUB_BG_PROXY_PORT || '7780', 10);
const BIND_HOST = process.env.HUB_BG_BIND_HOST || '127.0.0.1';
const BLUE_PORT = 7788;
const GREEN_PORT = 7789;
const STATE_FILE = '/tmp/hub-bg-state.json';
const REQUEST_TIMEOUT_MS = 30_000;

interface BgState {
  active: 'blue' | 'green';
  switchedAt?: string;
  switchedBy?: string;
}

function readBgState(): BgState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as BgState;
    if (parsed.active !== 'blue' && parsed.active !== 'green') return { active: 'blue' };
    return parsed;
  } catch {
    return { active: 'blue' };
  }
}

function getTargetPort(state: BgState): number {
  return state.active === 'green' ? GREEN_PORT : BLUE_PORT;
}

const server = http.createServer((req, res) => {
  const state = readBgState();
  const targetPort = getTargetPort(state);

  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
    timeout: REQUEST_TIMEOUT_MS,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, {
      ...proxyRes.headers,
      'x-hub-bg-active': state.active,
      'x-hub-bg-target-port': String(targetPort),
    });
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error('upstream_timeout'));
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({
      error: 'bad_gateway',
      upstream: `${state.active}:${targetPort}`,
      message: err.message,
    }));
    console.error(`[hub-proxy] upstream error (${state.active}:${targetPort}):`, err.message);
  });

  req.pipe(proxyReq, { end: true });
});

server.on('error', (err) => {
  console.error('[hub-proxy] server error:', err);
  process.exit(1);
});

server.listen(PROXY_PORT, BIND_HOST, () => {
  const state = readBgState();
  console.log(`[hub-proxy] 시작 — 127.0.0.1:${PROXY_PORT} → ${state.active}:${getTargetPort(state)}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
