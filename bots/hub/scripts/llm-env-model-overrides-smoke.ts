#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.LLM_TEAM_SELECTOR_VERSION = 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';
process.env.LLM_OPENAI_PERF_MODEL = 'openai-oauth/gpt-env-perf';
process.env.LLM_OPENAI_MINI_MODEL = 'openai-oauth/gpt-env-mini';
process.env.LLM_GROQ_FAST_MODEL = 'groq/groq-env-fast';
process.env.LLM_GROQ_DEEP_MODEL = 'groq/groq-env-deep';
process.env.LLM_GEMINI_FLASH_MODEL = 'gemini-cli-oauth/gemini-env-flash';
process.env.LLM_GEMINI_FLASH_LITE_MODEL = 'gemini-cli-oauth/gemini-env-lite';

const require = createRequire(import.meta.url);
const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function labels(key: string): string[] {
  return selector.selectLLMChain(key).map((entry: any) => `${entry.provider}/${entry.model}`);
}

const claudeLead = labels('claude.lead.system_issue_triage');
assert.equal(claudeLead[0], 'openai-oauth/gpt-env-perf');
assert(claudeLead.includes('groq/groq-env-deep'));
assert(claudeLead.includes('gemini-cli-oauth/gemini-env-flash'));

const claudeArcher = labels('claude.archer.tech_analysis');
assert.equal(claudeArcher[0], 'openai-oauth/gpt-env-mini');
assert(claudeArcher.includes('gemini-cli-oauth/gemini-env-lite'));

const hubClassifier = labels('hub.alarm.classifier');
assert.equal(hubClassifier[0], 'gemini-cli-oauth/gemini-env-lite');
assert(hubClassifier.includes('groq/groq-env-fast'));
assert(hubClassifier.includes('openai-oauth/gpt-env-mini'));

console.log(JSON.stringify({
  ok: true,
  checked: {
    openai_perf_model: process.env.LLM_OPENAI_PERF_MODEL,
    openai_mini_model: process.env.LLM_OPENAI_MINI_MODEL,
    groq_fast_model: process.env.LLM_GROQ_FAST_MODEL,
    groq_deep_model: process.env.LLM_GROQ_DEEP_MODEL,
    gemini_flash_model: process.env.LLM_GEMINI_FLASH_MODEL,
    gemini_flash_lite_model: process.env.LLM_GEMINI_FLASH_LITE_MODEL,
  },
}, null, 2));
