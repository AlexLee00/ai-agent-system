#!/usr/bin/env node
/**
 * speed-test.js - LLM API 속도 테스트 툴 (무료 모델)
 *
 * 지원 프로바이더:
 *   - Google Gemini (OAuth, 무료)  → cloudcode-pa.googleapis.com
 *       gemini-2.5-flash-lite / gemini-2.5-flash / gemini-2.5-pro
 *   - Ollama (로컬, 무료)
 *   - OpenAI  (데이터공유 무료)     → api.openai.com
 *   - Groq    (영구 무료 티어)      → GROQ_API_KEY
 *       llama-3.1-8b-instant / llama-3.3-70b-versatile
 *       meta-llama/llama-4-scout-17b-16e-instruct (750 T/s)
 *       moonshotai/kimi-k2-instruct (1T MoE, 256K ctx)
 *       qwen/qwen3-32b
 *       openai/gpt-oss-20b (OpenAI 오픈소스, Groq 경유)
 *   - Cerebras(영구 무료 티어)      → CEREBRAS_API_KEY
 *       llama3.1-8b / llama-3.3-70b
 *       llama-4-scout-17b-16e-instruct (~2600 T/s, 세계 최고속)
 *   - SambaNova($5 크레딧 무료)     → SAMBANOVA_API_KEY
 *       Meta-Llama-3.3-70B-Instruct / DeepSeek-V3-0324
 *   - OpenRouter(무료 :free 모델)   → OPENROUTER_API_KEY
 *       meta-llama/llama-4-scout:free / meta-llama/llama-3.3-70b-instruct:free
 *
 * 미등록 프로바이더 (키 등록 후 활성화):
 *   - xAI     (Grok 시리즈)        → XAI_API_KEY
 *   - Mistral (영구 무료 티어)      → MISTRAL_API_KEY
 *       mistral-small-latest / open-mistral-nemo (1B 토큰/월)
 *   - Together AI (무료 모델)       → TOGETHER_API_KEY
 *   - Fireworks AI (무료 크레딧)    → FIREWORKS_API_KEY
 *   - DeepInfra (무료 티어)         → DEEPINFRA_API_KEY
 *
 * 키 설정: ~/.openclaw/speed-test-keys.json
 *
 * 사용법:
 *   node scripts/speed-test.js              # 전체 테스트
 *   node scripts/speed-test.js --runs=3     # 반복 횟수 지정
 *   node scripts/speed-test.js --apply      # 결과를 openclaw.json에 자동 반영
 *   node scripts/speed-test.js --model=gemini-2.5-flash,llama-4-scout
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const https  = require('https');
const sender = require('../packages/core/lib/telegram-sender');

// ─── 설정 ──────────────────────────────────────────────────────────────────
const OPENCLAW_CONFIG        = path.join(process.env.HOME, '.openclaw/openclaw.json');
const AUTH_PROFILES_FILE     = path.join(process.env.HOME, '.openclaw/agents/main/agent/auth-profiles.json');
const SPEED_TEST_KEYS_FILE   = path.join(process.env.HOME, '.openclaw/speed-test-keys.json');
const SPEED_TEST_LATEST_FILE = path.join(process.env.HOME, '.openclaw/workspace/llm-speed-test-latest.json');
const SPEED_TEST_HISTORY_FILE = path.join(process.env.HOME, '.openclaw/workspace/llm-speed-test-history.jsonl');
const INVEST_SECRETS_FILE    = path.join(__dirname, '../bots/investment/secrets.json');
const GEMINI_CLIENT_ID     = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET = 'REMOVED_GOOGLE_OAUTH_SECRET';
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_VERSION  = 'v1internal';
const OLLAMA_BASE          = 'http://127.0.0.1:11434';
const TEST_PROMPT          = 'Reply with exactly one word: ok';

// OpenAI-호환 프로바이더 엔드포인트 (미등록: xai/mistral/together/fireworks/deepinfra)
const PROVIDER_ENDPOINTS = {
  'openai':     'https://api.openai.com/v1',
  'groq':       'https://api.groq.com/openai/v1',
  'cerebras':   'https://api.cerebras.ai/v1',
  'sambanova':  'https://api.sambanova.ai/v1',
  'openrouter': 'https://openrouter.ai/api/v1',
  // 미등록 — API 키 발급 후 speed-test-keys.json에 추가하면 자동 활성화
  'xai':        'https://api.x.ai/v1',
  'mistral':    'https://api.mistral.ai/v1',
  'together':   'https://api.together.xyz/v1',
  'fireworks':  'https://api.fireworks.ai/inference/v1',
  'deepinfra':  'https://api.deepinfra.com/v1/openai',
};

// 프로바이더별 환경변수명
const PROVIDER_ENV_KEYS = {
  'groq':       'GROQ_API_KEY',
  'cerebras':   'CEREBRAS_API_KEY',
  'sambanova':  'SAMBANOVA_API_KEY',
  'openrouter': 'OPENROUTER_API_KEY',
  'xai':        'XAI_API_KEY',
  'mistral':    'MISTRAL_API_KEY',
  'together':   'TOGETHER_API_KEY',
  'fireworks':  'FIREWORKS_API_KEY',
  'deepinfra':  'DEEPINFRA_API_KEY',
};

const PROVIDER_ICONS = {
  'google-gemini-cli': '✨',
  'openai':            '🤖',
  'groq':              '⚡',
  'cerebras':          '🧠',
  'sambanova':         '🔥',
  'openrouter':        '🔀',
  'ollama':            '🦙',
  'xai':               '𝕏 ',
  'mistral':           '🌀',
  'together':          '🤝',
  'fireworks':         '🎆',
  'deepinfra':         '🏗️',
};

// ─── 유틸 ──────────────────────────────────────────────────────────────────
const args              = process.argv.slice(2);
const runsArg           = parseInt(args.find(a => a.startsWith('--runs='))?.split('=')[1] ?? '2');
const doApply           = args.includes('--apply');
const doTelegram        = args.includes('--telegram');
const doUpdateTimeouts  = args.includes('--update-timeouts') || args.includes('--apply');
const modelArg          = args.find(a => a.startsWith('--model='))?.split('=')[1];

// 타임아웃 자동 업데이트 모듈 (없으면 무음)
let _calcTimeout = null, _updateTimeouts = null;
try {
  const lt = require('../packages/core/lib/llm-timeouts');
  _calcTimeout    = lt.calcTimeout;
  _updateTimeouts = lt.updateTimeouts;
} catch { /* packages/core 없는 환경 무시 */ }

function log(msg) { process.stdout.write(msg + '\n'); }
function dim(s)   { return `\x1b[2m${s}\x1b[0m`; }
function bold(s)  { return `\x1b[1m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s){ return `\x1b[33m${s}\x1b[0m`; }
function red(s)   { return `\x1b[31m${s}\x1b[0m`; }
function cyan(s)  { return `\x1b[36m${s}\x1b[0m`; }

// ─── 모델 목록 로드 ────────────────────────────────────────────────────────
function loadModels() {
  const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
  const allModels = cfg?.agents?.defaults?.models ?? {};

  const supported = Object.keys(allModels).filter(id =>
    id.startsWith('google-gemini-cli/') ||
    id.startsWith('ollama/')            ||
    id.startsWith('openai/')            ||
    id.startsWith('groq/')              ||
    id.startsWith('cerebras/')          ||
    id.startsWith('sambanova/')         ||
    id.startsWith('openrouter/')        ||
    id.startsWith('xai/')               ||
    id.startsWith('mistral/')           ||
    id.startsWith('together/')          ||
    id.startsWith('fireworks/')         ||
    id.startsWith('deepinfra/')
  );

  if (modelArg) {
    const filter = modelArg.split(',');
    return supported.filter(id => filter.some(f => id.includes(f)));
  }
  return supported;
}

// ─── API 키 로드 ───────────────────────────────────────────────────────────
function loadSpeedTestKeys() {
  try { return JSON.parse(fs.readFileSync(SPEED_TEST_KEYS_FILE, 'utf-8')); }
  catch { return {}; }
}

function loadOpenAIKey() {
  const profiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8'));
  const profile  = Object.values(profiles.profiles ?? {}).find(p => p.provider === 'openai');
  return profile?.key ?? process.env.OPENAI_API_KEY ?? null;
}

// invest/secrets.json에서 무료 LLM 키 조회 (groq/cerebras/sambanova)
function loadInvestSecretKeys() {
  const INVEST_KEY_MAP = {
    groq:      'groq_api_key',
    cerebras:  'cerebras_api_key',
    sambanova: 'sambanova_api_key',
  };
  try {
    const s = JSON.parse(fs.readFileSync(INVEST_SECRETS_FILE, 'utf-8'));
    const result = {};
    for (const [provider, field] of Object.entries(INVEST_KEY_MAP)) {
      if (s[field]) result[provider] = s[field];
    }
    return result;
  } catch { return {}; }
}

function loadProviderKey(provider) {
  if (provider === 'openai') return loadOpenAIKey();
  const keys = loadSpeedTestKeys();
  if (keys[provider]) return keys[provider];
  const envVar = PROVIDER_ENV_KEYS[provider];
  if (envVar && process.env[envVar]) return process.env[envVar];
  // invest/secrets.json fallback (groq/cerebras/sambanova)
  const investKeys = loadInvestSecretKeys();
  if (investKeys[provider]) return investKeys[provider];
  return null;
}

// ─── Google OAuth 토큰 갱신 ───────────────────────────────────────────────
async function refreshGeminiToken() {
  const profiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8'));
  const profile  = Object.values(profiles.profiles ?? {})
    .find(p => p.provider === 'google-gemini-cli' && p.type === 'oauth');
  if (!profile) throw new Error('Google OAuth 프로파일 없음');

  if (profile.access && profile.expires && Date.now() < profile.expires - 5 * 60 * 1000) {
    return profile.access;
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: profile.refresh,
    client_id:     GEMINI_CLIENT_ID,
    client_secret: GEMINI_CLIENT_SECRET,
  }).toString();

  const data = await httpPost('https://oauth2.googleapis.com/token', body,
    { 'Content-Type': 'application/x-www-form-urlencoded' });

  if (data.error) throw new Error(`토큰 갱신 실패: ${data.error_description ?? data.error}`);

  const profileKey = Object.keys(profiles.profiles)
    .find(k => profiles.profiles[k].provider === 'google-gemini-cli');
  profiles.profiles[profileKey].access  = data.access_token;
  profiles.profiles[profileKey].expires = Date.now() + (data.expires_in ?? 3600) * 1000;
  if (data.refresh_token) profiles.profiles[profileKey].refresh = data.refresh_token;
  fs.writeFileSync(AUTH_PROFILES_FILE, JSON.stringify(profiles, null, 2) + '\n');

  return data.access_token;
}

// ─── HTTP 유틸 ─────────────────────────────────────────────────────────────
function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyBuf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
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
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Length': bodyBuf.length, ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => {
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

// ─── Gemini 테스트 (Cloud Code API, SSE) ───────────────────────────────────
async function testGemini(modelId, accessToken) {
  const model     = modelId.split('/')[1];  // google-gemini-cli/gemini-2.5-flash → gemini-2.5-flash
  const profiles  = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8'));
  const profile   = Object.values(profiles.profiles ?? {}).find(p => p.provider === 'google-gemini-cli');
  const projectId = profile?.projectId ?? 'inspiring-shell-k4g6t';

  // 올바른 URL: v1internal:streamGenerateContent?alt=sse (SSE 스트리밍)
  const url  = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_VERSION}:streamGenerateContent?alt=sse`;
  const body = {
    model:   model,   // "gemini-2.5-flash" (models/ 접두사 없음)
    project: projectId,
    request: {
      contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
      generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
    },
  };

  const { ttft, total, raw, status } = await httpStream(url, body, {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type':  'application/json',
  });

  if (status >= 400) {
    let msg = '';
    try { msg = JSON.parse(raw)?.error?.message || raw.slice(0, 60); } catch {}
    throw new Error(`HTTP ${status}: ${msg}`);
  }

  // SSE 파싱: data: {"response": {"candidates": [...]}}
  let text = '';
  for (const line of raw.split('\n').filter(l => l.startsWith('data: '))) {
    try {
      const d = JSON.parse(line.slice(6));
      text += d?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } catch {}
  }

  return { ttft, total, ok: text.length > 0 || raw.includes('"text"'), text: text.trim().slice(0, 30) };
}

// ─── Ollama 테스트 ─────────────────────────────────────────────────────────
async function testOllama(modelId) {
  const model = modelId.split('/')[1];
  const start = Date.now();
  let ttft    = null;

  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ model, prompt: TEST_PROMPT, stream: true }));
    const req  = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      let text = '';
      res.on('data', chunk => {
        if (ttft === null) ttft = Date.now() - start;
        try {
          for (const line of chunk.toString().trim().split('\n')) {
            const d = JSON.parse(line);
            if (d.response) text += d.response;
          }
        } catch {}
      });
      res.on('end', () => resolve({
        ttft: ttft ?? Date.now() - start, total: Date.now() - start,
        ok: text.length > 0, text: text.trim().slice(0, 30),
      }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── OpenAI 호환 테스트 (OpenAI / Groq / Cerebras / SambaNova / OpenRouter) ─
async function testOpenAICompat(provider, modelId, apiKey) {
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) throw new Error(`알 수 없는 프로바이더: ${provider}`);

  const model   = modelId.split('/').slice(1).join('/');
  const url     = `${endpoint}/chat/completions`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/ai-agent-system';
    headers['X-Title']      = 'openclaw-speed-test';
  }

  // o-시리즈 추론 모델은 max_completion_tokens 사용 (max_tokens 미지원)
  const isReasoningModel = /^o\d/.test(model);
  const body = {
    model,
    messages: [{ role: 'user', content: TEST_PROMPT }],
    stream:   true,
  };
  if (isReasoningModel) body.max_completion_tokens = 50;
  else                   body.max_tokens = 10;

  const { ttft, total, raw, status } = await httpStream(url, body, headers);

  if (status >= 400) {
    let msg = '';
    try { msg = JSON.parse(raw)?.error?.message || JSON.parse(raw)?.message || raw.slice(0, 80); }
    catch { msg = raw.slice(0, 80); }
    throw new Error(`HTTP ${status}: ${msg}`);
  }

  // SSE 파싱
  let text = '';
  for (const line of raw.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))) {
    try { text += JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content ?? ''; } catch {}
  }

  return { ttft, total, ok: text.length > 0 || raw.includes('content'), text: text.trim().slice(0, 30) };
}

// ─── 단일 모델 벤치마크 ────────────────────────────────────────────────────
const OPENAI_COMPAT_PROVIDERS = new Set([
  'openai', 'groq', 'cerebras', 'sambanova', 'openrouter',
  'xai', 'mistral', 'together', 'fireworks', 'deepinfra',
]);

async function benchmarkModel(modelId, ctx) {
  const provider = modelId.split('/')[0];
  const icon     = PROVIDER_ICONS[provider] || '❓';
  const shortId  = modelId.split('/').slice(1).join('/');
  const label    = `${icon} ${shortId}`;

  process.stdout.write(`  ${label.padEnd(34)} `);

  const results = [];
  for (let i = 0; i < runsArg; i++) {
    try {
      let r;
      if (provider === 'google-gemini-cli')        r = await testGemini(modelId, ctx.geminiToken);
      else if (provider === 'ollama')               r = await testOllama(modelId);
      else if (OPENAI_COMPAT_PROVIDERS.has(provider)) r = await testOpenAICompat(provider, modelId, ctx.keys[provider]);
      else throw new Error('미지원 프로바이더');
      results.push(r);
      process.stdout.write(dim('.'));
    } catch (e) {
      process.stdout.write(red('✗'));
      results.push({ ttft: null, total: null, ok: false, error: e.message });
    }
  }
  process.stdout.write('\n');

  const valid = results.filter(r => r.ttft !== null && r.ok);
  if (valid.length === 0) {
    return { modelId, label, provider, ttft: null, total: null, ok: false, error: results[0]?.error };
  }

  const avgTTFT  = Math.round(valid.reduce((s, r) => s + r.ttft,  0) / valid.length);
  const avgTotal = Math.round(valid.reduce((s, r) => s + r.total, 0) / valid.length);
  return { modelId, label, provider, ttft: avgTTFT, total: avgTotal, ok: true, sample: valid[0]?.text };
}

// ─── Telegram 알림 ────────────────────────────────────────────────────────
function sendTelegramNotify(results, { applied, recommended, current } = {}) {
  const dateStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const top3 = results.filter(r => r.ok).slice(0, 5).map((r, i) => {
    const medal = ['🥇', '🥈', '🥉', '4위', '5위'][i] || '';
    return `${medal} ${r.label} — ${r.ttft}ms`;
  }).join('\n');
  const failed = results.filter(r => !r.ok).length;

  let statusLine;
  if (applied) {
    statusLine = `\n🔄 primary 자동 변경: ${applied}`;
  } else if (recommended && recommended !== current) {
    statusLine = `\n\n📌 현재: ${current}\n💡 추천: ${recommended}\n⚠️ 적용: node scripts/speed-test.js --apply`;
  } else {
    statusLine = `\n\n✅ 현재 모델(${current})이 가장 빠름`;
  }

  const text = `⚡ LLM 속도 테스트 결과 (${dateStr})\n\n${top3}${statusLine}\n\n❌ 실패: ${failed}개`;
  return sender.send('claude-lead', text);
}

function writeLatestSnapshot(results, { applied, recommended, current } = {}) {
  const payload = {
    capturedAt: new Date().toISOString(),
    prompt: TEST_PROMPT,
    runs: runsArg,
    current: current || null,
    recommended: recommended || null,
    applied: applied || null,
    results: results.map((r, index) => ({
      rank: index + 1,
      modelId: r.modelId,
      provider: r.provider,
      label: r.label,
      ttft: r.ttft,
      total: r.total,
      ok: r.ok === true,
      error: r.error || null,
    })),
  };
  try {
    fs.mkdirSync(path.dirname(SPEED_TEST_LATEST_FILE), { recursive: true });
    fs.writeFileSync(SPEED_TEST_LATEST_FILE, JSON.stringify(payload, null, 2) + '\n');
    log(dim(`\n  📝 최신 속도 스냅샷 저장: ${SPEED_TEST_LATEST_FILE}`));
  } catch (e) {
    log(dim(`\n  ⚠️ 속도 스냅샷 저장 실패: ${e.message}`));
  }
  try {
    fs.mkdirSync(path.dirname(SPEED_TEST_HISTORY_FILE), { recursive: true });
    fs.appendFileSync(SPEED_TEST_HISTORY_FILE, JSON.stringify(payload) + '\n');
    log(dim(`  🗂️ 속도 히스토리 누적: ${SPEED_TEST_HISTORY_FILE}`));
  } catch (e) {
    log(dim(`  ⚠️ 속도 히스토리 저장 실패: ${e.message}`));
  }
}

// ─── openclaw.json 업데이트 ────────────────────────────────────────────────
function applyFastest(results) {
  const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));

  // primary는 Gemini(무료 OAuth) 중 가장 빠른 모델 — 버전 무관 자동 교체
  const geminiValid = results.filter(r => r.ok && r.provider === 'google-gemini-cli');
  if (geminiValid.length === 0) { log('\n⚠️  적용할 Gemini 모델 결과 없음'); return null; }

  cfg.agents.defaults.model.primary = geminiValid[0].modelId;

  const geminiRest  = geminiValid.slice(1).map(r => r.modelId);
  const ollamaList  = results.filter(r => r.ok && r.provider === 'ollama').map(r => r.modelId);
  const otherList   = results.filter(r => r.ok && !['google-gemini-cli','ollama'].includes(r.provider)).map(r => r.modelId);
  cfg.agents.defaults.model.fallbacks = [...geminiRest, ...ollamaList, ...otherList];

  fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  log(`\n✅ openclaw.json 업데이트 완료`);
  log(`   primary:   ${geminiValid[0].modelId}`);
  log(`   fallbacks: ${cfg.agents.defaults.model.fallbacks.join(', ')}`);
  return geminiValid[0].modelId;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────
async function main() {
  log(bold('\n🚀 LLM API 속도 테스트'));
  log(dim(`   프롬프트: "${TEST_PROMPT}"`));
  log(dim(`   반복: ${runsArg}회 평균\n`));

  const models = loadModels();
  if (models.length === 0) { log(red('테스트할 모델 없음')); process.exit(1); }

  const ctx = { geminiToken: null, keys: {} };

  // Google Gemini OAuth
  if (models.some(m => m.startsWith('google-gemini-cli/'))) {
    try {
      process.stdout.write('🔑 google-gemini-cli OAuth 갱신...');
      ctx.geminiToken = await refreshGeminiToken();
      log(green(' ✅'));
    } catch (e) {
      log(red(` ❌ ${e.message}`));
    }
  }

  // OpenAI-호환 프로바이더 키 로드
  for (const provider of Object.keys(PROVIDER_ENDPOINTS)) {
    if (!models.some(m => m.startsWith(`${provider}/`))) continue;
    const key = loadProviderKey(provider);
    if (key) {
      ctx.keys[provider] = key;
      log(`🔑 ${provider.padEnd(14)} API 키 ${green('✅')}`);
    } else {
      log(`${yellow('⚠️')}  ${provider.padEnd(14)} API 키 없음 — ${dim('~/.openclaw/speed-test-keys.json 에 추가')}`);
    }
  }

  // Ollama 상태 확인
  if (models.some(m => m.startsWith('ollama/'))) {
    try {
      await new Promise((res, rej) => {
        const req = http.get(`${OLLAMA_BASE}/api/tags`, () => res());
        req.on('error', rej);
        req.setTimeout(2000, () => { req.destroy(); rej(new Error('timeout')); });
      });
      log(`🔑 ${'ollama'.padEnd(14)} 로컬 서버 ${green('✅')}`);
    } catch {
      log(yellow('⚠️  ollama         응답 없음 — 스킵'));
    }
  }

  log('');
  log(dim(`${'모델'.padEnd(36)} ${'TTFT'.padStart(8)} ${'총시간'.padStart(8)}`));
  log(dim('─'.repeat(56)));

  const results = [];
  for (const modelId of models) {
    const provider = modelId.split('/')[0];
    if (provider === 'google-gemini-cli' && !ctx.geminiToken) continue;
    if (OPENAI_COMPAT_PROVIDERS.has(provider) && !ctx.keys[provider]) continue;
    const r = await benchmarkModel(modelId, ctx);
    results.push(r);
  }

  // TTFT 기준 정렬 (실패 마지막)
  results.sort((a, b) => {
    if (a.ttft === null && b.ttft === null) return 0;
    if (a.ttft === null) return 1;
    if (b.ttft === null) return -1;
    return a.ttft - b.ttft;
  });

  log('');
  log(bold('📊 결과 (TTFT 기준 정렬)'));
  log(dim('─'.repeat(64)));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      log(`  ${red('✗')} ${r.label.padEnd(34)} ${red('실패')}  ${dim(r.error?.slice(0,50) ?? '')}`);
      continue;
    }
    const rank     = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    const ttftStr  = `${r.ttft}ms`.padStart(8);
    const totalStr = `${r.total}ms`.padStart(8);
    const color    = i === 0 ? green : i < 3 ? yellow : (s => s);
    log(`  ${rank} ${color(r.label.padEnd(34))} ${cyan(ttftStr)} ${dim(totalStr)}  ${dim(r.sample ?? '')}`);
  }
  log(dim('─'.repeat(64)));

  const current = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'))?.agents?.defaults?.model?.primary;
  log(`\n  현재 primary: ${dim(current)}`);

  const fastest = results.find(r => r.ok);
  let appliedModel = null;
  if (fastest && fastest.modelId !== current) {
    log(`  최고 속도: ${green(fastest.modelId)} (TTFT ${fastest.ttft}ms)`);
    if (doApply) {
      appliedModel = applyFastest(results);
    } else {
      log(dim(`\n  Gemini 기준 적용: node scripts/speed-test.js --apply`));
    }
  } else if (fastest) {
    log(`  ${green('✅ 현재 모델이 가장 빠릅니다')}`);
  }

  // ── 타임아웃 자동 업데이트 (측정값 기반) ──────────────────────────
  if (doUpdateTimeouts && _calcTimeout && _updateTimeouts) {
    const updates = {};
    for (const r of results) {
      if (r.ok && r.total != null) {
        const newMs = _calcTimeout(r.modelId, r.total);
        updates[r.modelId] = newMs;
        // short name도 등록 (provider/model → model)
        const short = r.modelId.split('/').pop();
        if (short !== r.modelId) updates[short] = newMs;
      }
    }
    if (Object.keys(updates).length > 0) {
      _updateTimeouts(updates);
      log(dim(`\n  ⏱️ 타임아웃 갱신 (${Object.keys(updates).length}개): ${path.basename(require('../packages/core/lib/llm-timeouts').OVERRIDE_FILE)}`));
    }
  }

  if (doTelegram) {
    process.stdout.write('\n📨 텔레그램 알림 전송...');
    await sendTelegramNotify(results, {
      applied: appliedModel,
      recommended: fastest?.modelId,
      current,
    });
    log(green(' ✅'));
  }
  writeLatestSnapshot(results, {
    applied: appliedModel,
    recommended: fastest?.modelId,
    current,
  });
  log('');
}

main().catch(e => { log(red(`\n❌ 오류: ${e.message}`)); process.exit(1); });
