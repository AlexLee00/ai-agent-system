'use strict';

const LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';

const PROFILES = {
  blog: {
    default: {
      openclaw_agent: 'blog-writer',
      claude_code_name: 'blog-writer',
      claude_code_settings: '/Users/alexlee/.openclaw/.claude/blog-writer.settings.json',
      local_llm_base_url: LOCAL_LLM_BASE_URL,
      primary_routes: ['claude-code/sonnet', 'openai-oauth/gpt-5.4'],
      fallback_routes: ['local/qwen2.5-7b', 'google-gemini-cli/gemini-2.5-flash'],
    },
    writer: {
      openclaw_agent: 'blog-writer',
      claude_code_name: 'blog-writer',
      claude_code_settings: '/Users/alexlee/.openclaw/.claude/blog-writer.settings.json',
      local_llm_base_url: LOCAL_LLM_BASE_URL,
      primary_routes: ['claude-code/sonnet', 'openai-oauth/gpt-5.4'],
      fallback_routes: ['local/qwen2.5-7b', 'google-gemini-cli/gemini-2.5-flash'],
    },
    social: {
      openclaw_agent: 'blog-writer',
      claude_code_name: 'blog-writer',
      claude_code_settings: '/Users/alexlee/.openclaw/.claude/blog-writer.settings.json',
      local_llm_base_url: LOCAL_LLM_BASE_URL,
      primary_routes: ['openai-oauth/gpt-5.4-mini', 'groq/meta-llama/llama-4-scout-17b-16e-instruct'],
      fallback_routes: ['claude-code/sonnet'],
    },
    curriculum: {
      openclaw_agent: 'blog-writer',
      claude_code_name: 'blog-writer',
      claude_code_settings: '/Users/alexlee/.openclaw/.claude/blog-writer.settings.json',
      local_llm_base_url: LOCAL_LLM_BASE_URL,
      primary_routes: ['claude-code/sonnet', 'openai-oauth/gpt-5.4'],
      fallback_routes: ['groq/qwen/qwen3-32b'],
    },
  },
  luna: {
    default: {
      openclaw_agent: 'luna-ops',
      claude_code_name: 'luna-ops',
      claude_code_settings: '/Users/alexlee/.openclaw/.claude/luna-ops.settings.json',
      local_llm_base_url: LOCAL_LLM_BASE_URL,
      primary_routes: ['openai-oauth/gpt-5.4', 'claude-code/sonnet'],
      fallback_routes: ['local/qwen2.5-7b', 'groq/meta-llama/llama-4-scout-17b-16e-instruct'],
    },
    analyst: {
      openclaw_agent: 'luna-ops',
      claude_code_name: 'luna-ops',
      claude_code_settings: '/Users/alexlee/.openclaw/.claude/luna-ops.settings.json',
      local_llm_base_url: LOCAL_LLM_BASE_URL,
      primary_routes: ['openai-oauth/gpt-5.4', 'claude-code/sonnet'],
      fallback_routes: ['local/qwen2.5-7b', 'groq/meta-llama/llama-4-scout-17b-16e-instruct'],
    },
    validator: {
      openclaw_agent: 'luna-ops',
      claude_code_name: 'luna-ops',
      claude_code_settings: '/Users/alexlee/.openclaw/.claude/luna-ops.settings.json',
      local_llm_base_url: LOCAL_LLM_BASE_URL,
      primary_routes: ['claude-code/sonnet', 'openai-oauth/gpt-5.4'],
      fallback_routes: ['local/qwen2.5-7b', 'groq/meta-llama/llama-4-scout-17b-16e-instruct'],
    },
    commander: {
      openclaw_agent: 'luna-ops',
      claude_code_name: 'luna-ops',
      claude_code_settings: '/Users/alexlee/.openclaw/.claude/luna-ops.settings.json',
      local_llm_base_url: LOCAL_LLM_BASE_URL,
      primary_routes: ['openai-oauth/gpt-5.4', 'claude-code/sonnet'],
      fallback_routes: ['groq/meta-llama/llama-4-scout-17b-16e-instruct'],
    },
  },
};

function selectRuntimeProfile(team, purpose = 'default') {
  const normalizedTeam = String(team || '').trim().toLowerCase();
  const normalizedPurpose = String(purpose || 'default').trim().toLowerCase() || 'default';
  if (!normalizedTeam) return null;
  const teamProfiles = PROFILES[normalizedTeam];
  if (!teamProfiles) return null;
  return teamProfiles[normalizedPurpose] || teamProfiles.default || null;
}

module.exports = {
  PROFILES,
  selectRuntimeProfile,
};
