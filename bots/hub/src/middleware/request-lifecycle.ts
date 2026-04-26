import type { NextFunction, Request, Response } from 'express';

type RuntimeFlag = () => boolean;

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

function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction) {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const tag = res.statusCode >= 400 ? '⚠️' : '✅';
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
