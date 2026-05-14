// @ts-nocheck
'use strict';

/**
 * Blog standard LLM gateway.
 *
 * All Blog production LLM calls should enter through Hub. Local LLM fallback is
 * opt-in only for offline development via BLOG_ALLOW_LOCAL_LLM_FALLBACK=true.
 */

const { callHubLlm } = require('../../../packages/core/lib/hub-client');

async function callBlogLlm(options = {}) {
  const {
    prompt,
    systemPrompt,
    agent = 'blo',
    selectorKey = 'blog._default',
    taskType = 'blog_v3_generic',
    maxTokens = 1000,
    temperature = 0.3,
    timeoutMs = 90_000,
    maxBudgetUsd = 0.05,
    priority = 'normal',
  } = options;

  if (!prompt) return { content: '', text: '', result: '' };

  try {
    const response = await callHubLlm({
      callerTeam: 'blog',
      agent,
      selectorKey,
      taskType,
      systemPrompt,
      prompt,
      maxTokens,
      temperature,
      timeoutMs,
      maxBudgetUsd,
      priority,
    });
    const text = String(response?.text || response?.result || response?.content || '').trim();
    return { ...response, content: text, text, result: text, hubGateway: true };
  } catch (error) {
    if (process.env.BLOG_ALLOW_LOCAL_LLM_FALLBACK !== 'true') {
      throw error;
    }
    const { callLocalLlm } = require('../../../packages/core/lib/local-llm-client');
    const local = await callLocalLlm({
      prompt,
      model: options.model || 'qwen2.5:7b',
      maxTokens,
      temperature,
    });
    const text = String(local?.content || local?.text || '').trim();
    return { ...local, content: text, text, result: text, hubGateway: false, localFallback: true };
  }
}

async function callBlogFast(prompt, options = {}) {
  return callBlogLlm({
    ...options,
    prompt,
    maxTokens: options.maxTokens || 300,
    temperature: options.temperature ?? 0.2,
    timeoutMs: options.timeoutMs || 45_000,
    maxBudgetUsd: options.maxBudgetUsd || 0.03,
    taskType: options.taskType || 'blog_v3_fast',
  });
}

module.exports = {
  callBlogFast,
  callBlogLlm,
};
