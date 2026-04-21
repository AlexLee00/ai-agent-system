'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { createRuntimeConfigLoader } = require('../../../packages/core/lib/runtime-config-loader');

const CONFIG_PATH = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'config.json');

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
    useN8nPipeline: false,
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
  competition: {
    enabled: false,
    days: [1, 3, 5],
    minWriters: 2,
  },
  sectionVariation: {
    common: {
      greetingStyles: ['formal', 'question', 'story'],
      cafePositions: ['after_theory', 'after_code', 'before_faq', 'last'],
      listStyles: ['number', 'bullet', 'mixed'],
      bridgeIntervals: [800, 1000, 1200, 1500],
      imageCount: { min: 0, max: 5 },
      includeInstaProbability: 0.4,
    },
    lecture: {
      greetingStyles: ['formal', 'question'],
      cafePositions: ['after_code', 'before_faq', 'last'],
      listStyles: ['number', 'mixed'],
      bridgeIntervals: [1000, 1200, 1500],
      imageCount: { min: 0, max: 3 },
      includeInstaProbability: 0.2,
      faqCount: { min: 3, max: 6 },
      insightCount: { min: 2, max: 5 },
      codeBlockCount: { min: 2, max: 5 },
    },
    general: {
      greetingStyles: ['question', 'story'],
      cafePositions: ['after_theory', 'after_code', 'last'],
      listStyles: ['bullet', 'mixed'],
      bridgeIntervals: [800, 1000, 1200],
      imageCount: { min: 1, max: 5 },
      includeInstaProbability: 0.55,
      faqCount: { min: 3, max: 6 },
      bodyCount: { min: 2, max: 4 },
    },
  },
  sectionRatio: {
    lecture: {
      jitter: 0.16,
      baseChars: {
        summary: 150,
        greeting: 320,
        tech_briefing: 1300,
        insight_1: 520,
        theory: 2500,
        insight_2: 520,
        code: 2500,
        insight_3: 520,
        cafe: 420,
        insight_4: 260,
        faq: 900,
        closing: 420,
      },
      bonusBase: 480,
    },
    general: {
      jitter: 0.22,
      baseChars: {
        summary: 150,
        greeting: 420,
        trend: 900,
        insight_1: 420,
        body_1: 1800,
        insight_2: 420,
        body_2: 1800,
        insight_3: 420,
        cafe: 520,
        insight_4: 240,
        faq: 760,
        closing: 380,
      },
      bonusBase: 420,
    },
    shortform: {
      jitter: 0.1,
      baseChars: {
        card_1: 200,
        card_2: 200,
        card_3: 200,
        insight_1: 150,
        caption: 200,
      },
      bonusBase: 250,
    },
  },
  commenter: {
    enabled: false,
    blogId: 'cafe_library',
    maxDaily: 20,
    allowCourtesyReflectionMinLength: 55,
    activeStartHour: 9,
    activeEndHour: 21,
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
    processTimeoutMs: 240000,
  },
  neighborCommenter: {
    enabled: false,
    blogId: 'cafe_library',
    maxDaily: 20,
    activeStartHour: 9,
    activeEndHour: 21,
    maxCollectPerCycle: 20,
    maxProcessPerCycle: 20,
    recentWindowDays: 14,
    minCommentLen: 45,
    maxCommentLen: 220,
    processTimeoutMs: 180000,
  },
  llmSelectorOverrides: {
    'blog.pos.writer': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.82 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 16000, temperature: 0.82 },
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'blog.gems.writer': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.85 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 16000, temperature: 0.85 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 12000, temperature: 0.75 },
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'blog.social.summarize': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.1 },
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
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 8000, temperature: 0.5 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 8000, temperature: 0.5 },
      ],
    },
    'blog.commenter.reply': {
      chain: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 600, temperature: 0.65, timeoutMs: 15000 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 600, temperature: 0.5, timeoutMs: 12000 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 600, temperature: 0.75, timeoutMs: 12000 },
      ],
    },
    'blog.commenter.neighbor': {
      chain: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 700, temperature: 0.7, timeoutMs: 15000 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 700, temperature: 0.55, timeoutMs: 12000 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 700, temperature: 0.8, timeoutMs: 15000 },
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

function getBlogCompetitionRuntimeConfig() {
  return loadRuntimeConfig().competition || {};
}

function getBlogSectionVariationRuntimeConfig() {
  return loadRuntimeConfig().sectionVariation || {};
}

function getBlogSectionRatioRuntimeConfig() {
  return loadRuntimeConfig().sectionRatio || {};
}

function getBlogLLMSelectorOverrides() {
  return loadRuntimeConfig().llmSelectorOverrides || {};
}

function getBlogCommenterConfig() {
  return loadRuntimeConfig().commenter || {};
}

function getBlogNeighborCommenterConfig() {
  return loadRuntimeConfig().neighborCommenter || {};
}

module.exports = {
  getBlogHealthRuntimeConfig,
  getBlogGenerationRuntimeConfig,
  getBlogCompetitionRuntimeConfig,
  getBlogSectionVariationRuntimeConfig,
  getBlogSectionRatioRuntimeConfig,
  getBlogCommenterConfig,
  getBlogNeighborCommenterConfig,
  getBlogLLMSelectorOverrides,
};
