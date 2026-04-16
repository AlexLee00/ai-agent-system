// @ts-nocheck
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const {
  AUTH_PROFILES_FILE,
  classifySpeedTestError,
} = require('./tester-support');

const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET = 'REMOVED_GOOGLE_OAUTH_SECRET';
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_VERSION = 'v1internal';
const PROVIDER_ENDPOINTS = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
};
const PROVIDER_ICONS = {
  'google-gemini-cli': '✨',
  openai: '🤖',
  groq: '⚡',
  cerebras: '🧠',
  sambanova: '🔥',
  openrouter: '🔀',
  ollama: '🦙',
  xai: '𝕏 ',
  mistral: '🌀',
  together: '🤝',
  fireworks: '🎆',
  deepinfra: '🏗️',
};
const OPENAI_COMPAT_PROVIDERS = new Set([
  'openai', 'groq', 'cerebras', 'sambanova', 'openrouter',
  'xai', 'mistral', 'together', 'fireworks', 'deepinfra',
]);

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyBuf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Length': bodyBuf.length, ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function httpStream(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const start = Date.now();
    let ttft = null;

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Length': bodyBuf.length, ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        if (ttft === null) ttft = Date.now() - start;
        raw += chunk.toString();
      });
      res.on('end', () => resolve({
        ttft: ttft ?? Date.now() - start,
        total: Date.now() - start,
        raw,
        status: res.statusCode,
      }));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function buildGeminiThinkingConfig(model) {
  if (model === 'gemini-2.5-pro') return { thinkingBudget: -1 };
  if (model === 'gemini-2.5-flash' || model === 'gemini-2.5-flash-lite') return { thinkingBudget: 0 };
  return undefined;
}

async function refreshGeminiToken() {
  const profiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8'));
  const profile = Object.values(profiles.profiles ?? {})
    .find((item) => item.provider === 'google-gemini-cli' && item.type === 'oauth');
  if (!profile) throw new Error('Google OAuth 프로파일 없음');

  if (profile.access && profile.expires && Date.now() < profile.expires - 5 * 60 * 1000) {
    return profile.access;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: profile.refresh,
    client_id: GEMINI_CLIENT_ID,
    client_secret: GEMINI_CLIENT_SECRET,
  }).toString();

  const data = await httpPost('https://oauth2.googleapis.com/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  if (data.error) throw new Error(`토큰 갱신 실패: ${data.error_description ?? data.error}`);

  const profileKey = Object.keys(profiles.profiles)
    .find((key) => profiles.profiles[key].provider === 'google-gemini-cli');
  profiles.profiles[profileKey].access = data.access_token;
  profiles.profiles[profileKey].expires = Date.now() + (data.expires_in ?? 3600) * 1000;
  if (data.refresh_token) profiles.profiles[profileKey].refresh = data.refresh_token;
  fs.writeFileSync(AUTH_PROFILES_FILE, JSON.stringify(profiles, null, 2) + '\n');

  return data.access_token;
}

async function testGemini(modelId, accessToken, prompt) {
  const model = modelId.split('/')[1];
  const profiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8'));
  const profile = Object.values(profiles.profiles ?? {}).find((item) => item.provider === 'google-gemini-cli');
  const projectId = profile?.projectId ?? 'inspiring-shell-k4g6t';
  const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_VERSION}:streamGenerateContent?alt=sse`;
  const thinkingConfig = buildGeminiThinkingConfig(model);
  const body = {
    model,
    project: projectId,
    request: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 200,
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    },
  };

  const { ttft, total, raw, status } = await httpStream(url, body, {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  });

  if (status >= 400) {
    let msg = '';
    try { msg = JSON.parse(raw)?.error?.message || raw.slice(0, 60); } catch {}
    throw new Error(`HTTP ${status}: ${msg}`);
  }

  let text = '';
  for (const line of raw.split('\n').filter((item) => item.startsWith('data: '))) {
    try {
      const parsed = JSON.parse(line.slice(6));
      text += parsed?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } catch {}
  }

  return { ttft, total, ok: text.length > 0 || raw.includes('"text"'), text: text.trim().slice(0, 30) };
}

async function testOllama(modelId, prompt) {
  const model = modelId.split('/')[1];
  const start = Date.now();
  let ttft = null;

  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ model, prompt, stream: true }));
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        if (ttft === null) ttft = Date.now() - start;
        try {
          for (const line of chunk.toString().trim().split('\n')) {
            const parsed = JSON.parse(line);
            if (parsed.response) text += parsed.response;
          }
        } catch {}
      });
      res.on('end', () => resolve({
        ttft: ttft ?? Date.now() - start,
        total: Date.now() - start,
        ok: text.length > 0,
        text: text.trim().slice(0, 30),
      }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function testOpenAICompat(provider, modelId, apiKey, prompt) {
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) throw new Error(`알 수 없는 프로바이더: ${provider}`);

  const model = modelId.split('/').slice(1).join('/');
  const url = `${endpoint}/chat/completions`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/ai-agent-system';
    headers['X-Title'] = 'openclaw-speed-test';
  }

  const isReasoningModel = /^o\d/.test(model);
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  };
  if (isReasoningModel) body.max_completion_tokens = 50;
  else body.max_tokens = 10;

  const { ttft, total, raw, status } = await httpStream(url, body, headers);

  if (status >= 400) {
    let msg = '';
    try { msg = JSON.parse(raw)?.error?.message || JSON.parse(raw)?.message || raw.slice(0, 80); }
    catch { msg = raw.slice(0, 80); }
    throw new Error(`HTTP ${status}: ${msg}`);
  }

  let text = '';
  for (const line of raw.split('\n').filter((item) => item.startsWith('data: ') && !item.includes('[DONE]'))) {
    try { text += JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content ?? ''; } catch {}
  }

  return { ttft, total, ok: text.length > 0 || raw.includes('content'), text: text.trim().slice(0, 30) };
}

async function benchmarkModel(modelId, ctx, options = {}) {
  const provider = modelId.split('/')[0];
  const icon = PROVIDER_ICONS[provider] || '❓';
  const shortId = modelId.split('/').slice(1).join('/');
  const label = `${icon} ${shortId}`;
  const runs = Number(options.runs || 1);
  const prompt = options.prompt || 'Reply with exactly one word: ok';
  const progress = typeof options.onProgress === 'function' ? options.onProgress : null;

  if (progress) progress({ type: 'start', label, modelId, provider });

  const results = [];
  for (let index = 0; index < runs; index += 1) {
    try {
      let result;
      if (provider === 'google-gemini-cli') result = await testGemini(modelId, ctx.geminiToken, prompt);
      else if (provider === 'ollama') result = await testOllama(modelId, prompt);
      else if (OPENAI_COMPAT_PROVIDERS.has(provider)) result = await testOpenAICompat(provider, modelId, ctx.keys[provider], prompt);
      else throw new Error('미지원 프로바이더');
      results.push(result);
      if (progress) progress({ type: 'success', label, modelId, provider, result, run: index + 1 });
    } catch (error) {
      const failed = {
        ttft: null,
        total: null,
        ok: false,
        error: error.message,
        errorClass: classifySpeedTestError(provider, modelId, error.message),
      };
      results.push(failed);
      if (progress) progress({ type: 'error', label, modelId, provider, error: failed, run: index + 1 });
    }
  }

  const valid = results.filter((item) => item.ttft !== null && item.ok);
  if (valid.length === 0) {
    return {
      modelId,
      label,
      provider,
      ttft: null,
      total: null,
      ok: false,
      error: results[0]?.error,
      errorClass: results[0]?.errorClass || classifySpeedTestError(provider, modelId, results[0]?.error),
    };
  }

  const avgTTFT = Math.round(valid.reduce((sum, item) => sum + item.ttft, 0) / valid.length);
  const avgTotal = Math.round(valid.reduce((sum, item) => sum + item.total, 0) / valid.length);
  return { modelId, label, provider, ttft: avgTTFT, total: avgTotal, ok: true, sample: valid[0]?.text };
}

module.exports = {
  PROVIDER_ENDPOINTS,
  OPENAI_COMPAT_PROVIDERS,
  refreshGeminiToken,
  benchmarkModel,
};
