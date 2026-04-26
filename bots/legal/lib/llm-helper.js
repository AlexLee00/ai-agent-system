'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { callHubLlm } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/hub-client'));

function stripThinkTags(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function selectJustinProfile(agent, requestType) {
  const key = `${agent || ''}:${requestType || ''}`.toLowerCase();
  if (/citation|precedent|case_search|domestic_case|foreign_case|search/.test(key)) return 'citation';
  if (/report|draft|review|opinion|query_letter|inspection_plan|inception_plan/.test(key)) return 'opinion';
  if (/analysis|classification|contract|source_code|function_mapping|plaintiff|defendant|interview/.test(key)) return 'analysis';
  return 'default';
}

async function callLegal({ systemPrompt, userPrompt, agent, requestType, maxTokens = 8192 }) {
  const profile = selectJustinProfile(agent, requestType);
  const result = await callHubLlm({
    callerTeam: 'justin',
    agent: profile,
    taskType: requestType || 'legal_analysis',
    abstractModel: 'anthropic_sonnet',
    systemPrompt,
    prompt: userPrompt,
    maxTokens: Math.min(maxTokens, 8192),
    timeoutMs: maxTokens > 4096 ? 60000 : 30000,
    maxBudgetUsd: 0.08,
  });
  if (result && result.text) result.text = stripThinkTags(result.text);
  return result;
}

module.exports = { callLegal, selectJustinProfile };
