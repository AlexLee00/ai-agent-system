import type { NextFunction, Request, Response } from 'express';

type RuntimeFlag = () => boolean;
type HubRequest = Request & {
  hubRequestContext?: { traceId?: string };
};
type HubResponse = Response & {
  statusCode: number;
  on: (event: 'finish', listener: () => void) => void;
};

const HIGH_VOLUME_SUCCESS_PATHS = new Set([
  '/events/publish',
  '/hub/events/publish',
]);

let highVolumeSuccessCount = 0;

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldLogRequest(req: HubRequest, res: HubResponse, ms: number): boolean {
  if (res.statusCode >= 400) return true;
  if (!HIGH_VOLUME_SUCCESS_PATHS.has(String(req.path || ''))) return true;
  if (ms >= positiveIntEnv('HUB_REQUEST_LOG_SLOW_MS', 100)) return true;
  if (String(process.env.HUB_LOG_EVENTS_PUBLISH_SUCCESS || '').trim().toLowerCase() === 'true') return true;

  const sampleEvery = positiveIntEnv('HUB_EVENTS_PUBLISH_LOG_SAMPLE_EVERY', 250);
  highVolumeSuccessCount = (highVolumeSuccessCount + 1) % sampleEvery;
  return highVolumeSuccessCount === 0;
}

function createShutdownGuard(isShuttingDown: RuntimeFlag) {
  return function shutdownGuard(_req: Request, res: Response, next: NextFunction) {
    if (isShuttingDown()) {
      res.set('Connection', 'close');
      return res.status(503).json({ error: 'server shutting down' });
    }
    return next();
  };
}

function pathGuardMiddleware(req: Request, res: Response, next: NextFunction) {
  const reqPath = String(req.path || '');
  if (reqPath.length > 500) {
    return res.status(414).json({ error: 'URI too long' });
  }
  if (/(.)\1{50,}/.test(reqPath)) {
    return res.status(400).json({ error: 'invalid path pattern' });
  }
  return next();
}

function requestLoggingMiddleware(req: HubRequest, res: HubResponse, next: NextFunction) {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (!shouldLogRequest(req, res, ms)) return;
    const tag = res.statusCode >= 500
      ? '⚠️'
      : res.statusCode === 401 || res.statusCode === 403
        ? '🔒'
        : res.statusCode >= 400
          ? '⚠️'
          : '✅';
    const traceId = req.hubRequestContext?.traceId || '-';
    console.log(`${tag} ${req.method} ${req.path} → ${res.statusCode} (${ms}ms) trace=${traceId}`);
  });
  next();
}

module.exports = {
  createShutdownGuard,
  pathGuardMiddleware,
  requestLoggingMiddleware,
};
