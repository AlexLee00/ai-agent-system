import crypto from 'node:crypto';
import * as env from '../../../packages/core/lib/env';

type RequestLike = {
  headers: { authorization?: string };
};

type ResponseLike = {
  status: (code: number) => { json: (body: Record<string, string>) => unknown };
};

type NextLike = () => unknown;

export function safeCompare(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function authMiddleware(req: RequestLike, res: ResponseLike, next: NextLike): unknown {
  const configured = String(env.HUB_AUTH_TOKEN || '').trim();
  if (!configured) {
    return res.status(503).json({ error: 'hub_auth_not_configured' });
  }

  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token || !safeCompare(token, configured)) {
    return res.status(401).json({ error: 'invalid_bearer_token' });
  }

  return next();
}
