import type { Request, RequestHandler } from 'express';

const rateLimitModule = require('express-rate-limit');
const { parsePositiveIntEnv } = require('./env-utils');

const rateLimit = rateLimitModule.default || rateLimitModule;

type HubRateLimiters = {
  generalLimiter: RequestHandler;
  alarmLimiter: RequestHandler;
  eventsLimiter: RequestHandler;
  pgLimiter: RequestHandler;
  secretsLimiter: RequestHandler;
  llmLimiter: RequestHandler;
};

function createHubRateLimiters(): HubRateLimiters {
  const generalRateLimitPerMinute = parsePositiveIntEnv('HUB_GENERAL_RATE_LIMIT_PER_MIN', 200);
  const alarmRateLimitPerMinute = parsePositiveIntEnv('HUB_ALARM_RATE_LIMIT_PER_MIN', 900);
  const eventsRateLimitPerMinute = parsePositiveIntEnv('HUB_EVENTS_RATE_LIMIT_PER_MIN', 2400);
  const secretsRateLimitPerMinute = parsePositiveIntEnv('HUB_SECRETS_RATE_LIMIT_PER_MIN', 240);
  const llmRateLimitPerMinute = parsePositiveIntEnv('HUB_LLM_RATE_LIMIT_PER_MIN', 120);

  return {
    generalLimiter: rateLimit({
      windowMs: 60 * 1000,
      max: generalRateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: `rate limit exceeded (${generalRateLimitPerMinute}/min)` },
    }),
    alarmLimiter: rateLimit({
      windowMs: 60 * 1000,
      max: alarmRateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: `alarm rate limit exceeded (${alarmRateLimitPerMinute}/min)` },
    }),
    eventsLimiter: rateLimit({
      windowMs: 60 * 1000,
      max: eventsRateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: `events rate limit exceeded (${eventsRateLimitPerMinute}/min)` },
    }),
    pgLimiter: rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'DB query rate limit exceeded (120/min)' },
    }),
    secretsLimiter: rateLimit({
      windowMs: 60 * 1000,
      max: secretsRateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: `secrets rate limit exceeded (${secretsRateLimitPerMinute}/min)` },
    }),
    llmLimiter: rateLimit({
      windowMs: 60 * 1000,
      max: llmRateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: `LLM rate limit exceeded (${llmRateLimitPerMinute}/min)` },
      skip: (req: Request) => String(req.headers['x-hub-load-test'] || '').trim() === '1',
    }),
  };
}

module.exports = {
  createHubRateLimiters,
};
