'use strict';

const fs = require('fs');
const path = require('path');
const { createRuntimeConfigLoader } = require('../../../packages/core/lib/runtime-config-loader');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  health: {
    nodeServerHealthUrl: 'http://127.0.0.1:3100/health',
    n8nHealthUrl: 'http://127.0.0.1:5678/healthz',
    blogWebhookUrl: 'http://127.0.0.1:5678/webhook/blog-pipeline',
    nodeServerTimeoutMs: 3000,
    n8nHealthTimeoutMs: 2500,
    webhookTimeoutMs: 5000,
    dailyLogStaleMs: 36 * 60 * 60 * 1000,
  },
  generation: {
    gemsMinChars: 6000,
    posMinChars: 7000,
    continueMaxTokens: 8000,
    writerMaxRetries: 1,
    writerTimeoutMs: 90000,
    continueTimeoutMs: 90000,
    chunkTimeoutMs: 120000,
    maestroWebhookTimeoutMs: 180000,
    maestroHealthTimeoutMs: 2500,
    maestroCircuitCooldownMs: 30 * 60 * 1000,
  },
  commenter: {
    enabled: false,
    blogId: 'cafe_library',
    maxDaily: 20,
    activeStartHour: 8,
    activeEndHour: 22,
    browserHttpUrl: 'http://127.0.0.1:18791',
    browserWsEndpoint: '',
    browserToken: '',
    profileDir: '~/.openclaw/workspace/naver-profile',
    pageReadMinSec: 30,
    pageReadMaxSec: 90,
    typingMinSec: 20,
    typingMaxSec: 45,
    betweenCommentsMinSec: 60,
    betweenCommentsMaxSec: 180,
    minReplyLen: 50,
    maxReplyLen: 200,
    maxDetectPerCycle: 20,
    maxProcessPerCycle: 20,
  },
  llmSelectorOverrides: {
    'blog.pos.writer': {
      chain: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 16000, temperature: 0.82 },
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.82 },
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'blog.gems.writer': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.85 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 16000, temperature: 0.85 },
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 12000, temperature: 0.75 },
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'blog.social.summarize': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'blog.social.caption': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'blog.star.summarize': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'blog.star.caption': {
      chain: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'blog.curriculum.recommend': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2000, temperature: 0.7 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 2000, temperature: 0.7 },
      ],
    },
    'blog.curriculum.generate': {
      chain: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 8000, temperature: 0.5 },
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 8000, temperature: 0.5 },
      ],
    },
  },
};

const { loadRuntimeConfig } = createRuntimeConfigLoader({
  fs,
  defaults: DEFAULTS,
  configPath: CONFIG_PATH,
});

function getBlogHealthRuntimeConfig() {
  return loadRuntimeConfig().health;
}

function getBlogGenerationRuntimeConfig() {
  return loadRuntimeConfig().generation;
}

function getBlogLLMSelectorOverrides() {
  return loadRuntimeConfig().llmSelectorOverrides || {};
}

function getBlogCommenterConfig() {
  return loadRuntimeConfig().commenter || {};
}

module.exports = {
  getBlogHealthRuntimeConfig,
  getBlogGenerationRuntimeConfig,
  getBlogCommenterConfig,
  getBlogLLMSelectorOverrides,
};
