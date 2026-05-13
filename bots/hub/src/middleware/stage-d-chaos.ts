import type { NextFunction, Request, Response } from 'express';

const fs = require('node:fs');
const crypto = require('node:crypto');

const STATE_FILE = '/tmp/hub-stage-d-chaos-state.json';
const MAX_SAFE_PERCENT = 10;
const MAX_SAFE_LATENCY_MS = 1_000;
const DEFAULT_ALLOWED_PATHS = new Set([
  '/hub/health',
  '/hub/health/live',
  '/hub/health/ready',
  '/hub/health/startup',
  '/hub/llm/health',
]);

type ChaosState = {
  enabled?: boolean;
  mode?: string;
  percent?: number;
  latencyMs?: number;
  allowedPaths?: string[];
  expiresAt?: string;
};

function readChaosState(): ChaosState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { enabled: false, mode: 'disabled', percent: 0, latencyMs: 0 };
  }
}

function isExpired(state: ChaosState): boolean {
  if (!state.expiresAt) return false;
  const expiresAt = new Date(state.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function clampNumber(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function shouldInject(req: Request, state: ChaosState): boolean {
  if (!state.enabled || isExpired(state)) return false;
  if (req.method !== 'GET') return false;

  const allowed = new Set(state.allowedPaths || Array.from(DEFAULT_ALLOWED_PATHS));
  if (!allowed.has(req.path)) return false;

  const percent = clampNumber(state.percent, 0, MAX_SAFE_PERCENT);
  if (percent <= 0) return false;

  const traceSeed = String(req.headers['x-hub-trace-id'] || req.headers['x-trace-id'] || `${req.method}:${req.path}:${Date.now()}`);
  const digest = crypto.createHash('sha256').update(traceSeed).digest();
  const bucket = digest.readUInt32BE(0) % 10_000;
  return bucket < Math.round(percent * 100);
}

function stageDChaosMiddleware(req: Request, _res: Response, next: NextFunction) {
  const state = readChaosState();
  if (!shouldInject(req, state)) {
    return next();
  }

  const latencyMs = clampNumber(state.latencyMs, 0, MAX_SAFE_LATENCY_MS);
  if (latencyMs <= 0) {
    return next();
  }

  return setTimeout(next, latencyMs);
}

module.exports = {
  DEFAULT_ALLOWED_PATHS,
  MAX_SAFE_LATENCY_MS,
  MAX_SAFE_PERCENT,
  STATE_FILE,
  readChaosState,
  stageDChaosMiddleware,
};
