const rateLimitModule = require('express-rate-limit');
const { parsePositiveIntEnv } = require('./env-utils');

const rateLimit = rateLimitModule.default || rateLimitModule;

function createHubRateLimiters() {
  const secretsRateLimitPerMinute = parsePositiveIntEnv('HUB_SECRETS_RATE_LIMIT_PER_MIN', 240);
  const llmRateLimitPerMinute = parsePositiveIntEnv('HUB_LLM_RATE_LIMIT_PER_MIN', 120);

  return {
    generalLimiter: rateLimit({
      windowMs: 60 * 1000,
      max: 200,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate limit exceeded (200/min)' },
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
      skip: (req) => String(req.headers['x-hub-load-test'] || '').trim() === '1',
    }),
  };
}

module.exports = {
  createHubRateLimiters,
};
