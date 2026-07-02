import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as env from '../../../packages/core/lib/env';

type RequestLike = {
  headers: { authorization?: string };
};

type ResponseLike = {
  status: (code: number) => { json: (body: Record<string, string>) => unknown };
};

type NextLike = () => unknown;

function readLaunchctlEnv(name: string): string {
  try {
    return String(execFileSync('/bin/launchctl', ['getenv', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
  } catch {
    return '';
  }
}

function configuredHubAuthToken(): string {
  return String(process.env.HUB_AUTH_TOKEN || env.HUB_AUTH_TOKEN || readLaunchctlEnv('HUB_AUTH_TOKEN') || '').trim();
}

export function safeCompare(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function authMiddleware(req: RequestLike, res: ResponseLike, next: NextLike): unknown {
  const configured = configuredHubAuthToken();
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
