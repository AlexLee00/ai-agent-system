#!/usr/bin/env node
/**
 * speed-test.js - LLM API 속도 테스트 툴 (무료 모델만)
 *
 * 대상:
 *   - Google Gemini (OAuth, 무료) → cloudcode-pa.googleapis.com
 *   - Ollama (로컬, 무료)
 *
 * 사용법:
 *   node scripts/speed-test.js              # 전체 테스트
 *   node scripts/speed-test.js --runs 3     # 반복 횟수 지정
 *   node scripts/speed-test.js --apply      # 결과를 openclaw.json에 자동 반영
 *   node scripts/speed-test.js --model gemini-2.5-flash,gemini-2.5-pro  # 특정 모델만
 */

const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');

// ─── 설정 ──────────────────────────────────────────────────────────────────
const OPENCLAW_CONFIG      = path.join(process.env.HOME, '.openclaw/openclaw.json');
const AUTH_PROFILES_FILE   = path.join(process.env.HOME, '.openclaw/agents/main/agent/auth-profiles.json');
const GEMINI_CLIENT_ID     = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET = 'REMOVED_GOOGLE_OAUTH_SECRET';
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_VERSION  = 'v1internal';
const OLLAMA_BASE          = 'http://127.0.0.1:11434';
const OPENAI_ENDPOINT      = 'https://api.openai.com';
const TEST_PROMPT          = 'Reply with exactly one word: ok';

// ─── 유틸 ──────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const runsArg  = parseInt(args.find(a => a.startsWith('--runs='))?.split('=')[1] ?? '2');
const doApply  = args.includes('--apply');
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1];

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
    id.startsWith('ollama/') ||
    id.startsWith('openai/')
  );

  if (modelArg) {
    const filter = modelArg.split(',');
    return supported.filter(id => filter.some(f => id.includes(f)));
  }
  return supported;
}

// ─── OpenAI 키 로드 ────────────────────────────────────────────────────────
function loadOpenAIKey() {
  const profiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8'));
  const profile  = Object.values(profiles.profiles ?? {})
    .find(p => p.provider === 'openai');
  return profile?.key ?? process.env.OPENAI_API_KEY ?? null;
}

// ─── Google OAuth 토큰 갱신 ───────────────────────────────────────────────
async function refreshGeminiToken() {
  const profiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8'));
  const profile  = Object.values(profiles.profiles ?? {})
    .find(p => p.provider === 'google-gemini-cli' && p.type === 'oauth');

  if (!profile) throw new Error('Google OAuth 프로파일 없음');

  // 만료 5분 전이면 갱신
  if (profile.access && profile.expires && Date.now() < profile.expires - 5 * 60 * 1000) {
    return profile.access;
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: profile.refresh,
    client_id:     GEMINI_CLIENT_ID,
    client_secret: GEMINI_CLIENT_SECRET,
  }).toString();

  const data = await httpPost('https://oauth2.googleapis.com/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  if (data.error) throw new Error(`토큰 갱신 실패: ${data.error_description ?? data.error}`);

  // 갱신된 토큰 auth-profiles에 저장
  const profileKey = Object.keys(profiles.profiles).find(k =>
    profiles.profiles[k].provider === 'google-gemini-cli'
  );
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

// 스트리밍: TTFT(첫 토큰 시간)와 총 소요 시간을 모두 측정
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
      res.on('end', () => resolve({ ttft: ttft ?? Date.now() - start, total: Date.now() - start, raw }));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ─── Gemini 테스트 (Cloud Code API) ────────────────────────────────────────
async function testGemini(modelId, accessToken) {
  // e.g. google-gemini-cli/gemini-2.5-flash → gemini-2.5-flash
  const model   = modelId.split('/')[1];
  const profiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf-8'));
  const profile  = Object.values(profiles.profiles ?? {})
    .find(p => p.provider === 'google-gemini-cli');
  const projectId = profile?.projectId ?? 'inspiring-shell-k4g6t';

  const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_VERSION}/projects/${projectId}/locations/global:streamGenerateContent`;

  const body = {
    model: `models/${model}`,
    request: {
      contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
      generationConfig: { maxOutputTokens: 20 },
    },
  };

  const { ttft, total, raw } = await httpStream(url, body, {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  });

  // 응답 확인
  let text = '';
  try {
    // 스트리밍 응답은 여러 JSON 청크
    const chunks = raw.replace(/^\[|\]$/g, '').split(/\}\s*,\s*\{/).map((c, i, a) => {
      if (i === 0) return c + '}';
      if (i === a.length - 1) return '{' + c;
      return '{' + c + '}';
    });
    for (const c of chunks) {
      try {
        const d = JSON.parse(c);
        const t = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        text += t;
      } catch {}
    }
  } catch {}

  return { ttft, total, ok: text.length > 0 || raw.includes('text'), text: text.trim().slice(0, 30) };
}

// ─── Ollama 테스트 ─────────────────────────────────────────────────────────
async function testOllama(modelId) {
  const model = modelId.split('/')[1];  // ollama/qwen2.5:7b → qwen2.5:7b
  const url   = `${OLLAMA_BASE}/api/generate`;

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
          const lines = chunk.toString().trim().split('\n');
          for (const line of lines) {
            const d = JSON.parse(line);
            if (d.response) text += d.response;
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

// ─── OpenAI 테스트 ─────────────────────────────────────────────────────────
async function testOpenAI(modelId, apiKey) {
  const model = modelId.split('/')[1];  // openai/gpt-4o-mini → gpt-4o-mini
  const url   = `${OPENAI_ENDPOINT}/v1/chat/completions`;

  const body = {
    model,
    messages: [{ role: 'user', content: TEST_PROMPT }],
    max_tokens: 10,
    stream: true,
  };

  const { ttft, total, raw } = await httpStream(url, body, {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  });

  // SSE 파싱: data: {...}\n\ndata: {...}
  let text = '';
  const lines = raw.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
  for (const line of lines) {
    try {
      const d = JSON.parse(line.slice(6));
      text += d?.choices?.[0]?.delta?.content ?? '';
    } catch {}
  }

  return { ttft, total, ok: text.length > 0 || raw.includes('content'), text: text.trim().slice(0, 30) };
}

// ─── 단일 모델 테스트 (runs 횟수 평균) ────────────────────────────────────
async function benchmarkModel(modelId, accessToken, openAIKey) {
  const isGemini = modelId.startsWith('google-gemini-cli/');
  const isOpenAI = modelId.startsWith('openai/');
  const shortId  = modelId.replace('google-gemini-cli/', '').replace('ollama/', '🦙 ').replace('openai/', '🤖 ');
  const label    = isGemini ? `✨ ${shortId}` : shortId;

  process.stdout.write(`  ${label.padEnd(30)} `);

  const results = [];
  for (let i = 0; i < runsArg; i++) {
    try {
      const r = isGemini
        ? await testGemini(modelId, accessToken)
        : isOpenAI
          ? await testOpenAI(modelId, openAIKey)
          : await testOllama(modelId);
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
    return { modelId, label, ttft: null, total: null, ok: false, error: results[0]?.error, isOpenAI };
  }

  const avgTTFT  = Math.round(valid.reduce((s, r) => s + r.ttft,  0) / valid.length);
  const avgTotal = Math.round(valid.reduce((s, r) => s + r.total, 0) / valid.length);
  return { modelId, label, ttft: avgTTFT, total: avgTotal, ok: true, sample: valid[0]?.text, isOpenAI };
}

// ─── openclaw.json 업데이트 ────────────────────────────────────────────────
function applyFastest(results) {
  const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
  // primary는 Gemini(무료 OAuth)만 대상
  const valid = results.filter(r => r.ok && r.modelId.startsWith('google-gemini-cli/'));
  if (valid.length === 0) { log('\n⚠️  적용할 Gemini 모델 결과 없음'); return; }

  const fastest = valid[0];  // 이미 정렬됨
  cfg.agents.defaults.model.primary = fastest.modelId;

  // fallback: Gemini 나머지 → Ollama 순 (OpenAI는 fallback에만 포함, 유료이므로 맨 뒤)
  const geminiModels    = valid.map(r => r.modelId);
  const ollamaFallbacks = results.filter(r => r.ok && r.modelId.startsWith('ollama/')).map(r => r.modelId);
  const openAIFallbacks = results.filter(r => r.ok && r.modelId.startsWith('openai/')).map(r => r.modelId);
  cfg.agents.defaults.model.fallbacks = [...geminiModels.slice(1), ...ollamaFallbacks, ...openAIFallbacks];

  fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  log(`\n✅ openclaw.json 업데이트 완료`);
  log(`   primary: ${fastest.modelId}`);
  log(`   fallbacks: ${cfg.agents.defaults.model.fallbacks.join(', ')}`);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────
async function main() {
  log(bold('\n🚀 LLM API 속도 테스트'));
  log(dim(`   프롬프트: "${TEST_PROMPT}"`));
  log(dim(`   반복: ${runsArg}회 평균\n`));

  // 모델 목록
  const models = loadModels();
  if (models.length === 0) { log(red('테스트할 모델 없음')); process.exit(1); }

  // Google OAuth 토큰 갱신
  let accessToken = null;
  const hasGemini = models.some(m => m.startsWith('google-gemini-cli/'));
  if (hasGemini) {
    try {
      process.stdout.write('🔑 Google OAuth 토큰 갱신 중...');
      accessToken = await refreshGeminiToken();
      log(green(' ✅'));
    } catch (e) {
      log(red(` ❌ ${e.message}`));
      log(dim('   Gemini 모델은 스킵합니다'));
    }
  }

  // OpenAI 키 로드
  let openAIKey = null;
  const hasOpenAI = models.some(m => m.startsWith('openai/'));
  if (hasOpenAI) {
    try {
      openAIKey = loadOpenAIKey();
      if (openAIKey) log(`🔑 OpenAI API 키 로드 ${green('✅')}`);
      else log(yellow('⚠️  OpenAI API 키 없음 — OpenAI 모델 스킵'));
    } catch (e) {
      log(yellow(`⚠️  OpenAI 키 로드 실패: ${e.message} — 스킵`));
    }
  }

  // Ollama 상태 확인
  const hasOllama = models.some(m => m.startsWith('ollama/'));
  if (hasOllama) {
    try {
      await new Promise((res, rej) => {
        const req = http.get(`${OLLAMA_BASE}/api/tags`, r => res());
        req.on('error', rej);
        req.setTimeout(2000, () => { req.destroy(); rej(new Error('timeout')); });
      });
    } catch {
      log(yellow('⚠️  Ollama 응답 없음 — Ollama 모델 스킵'));
    }
  }

  log(dim(`${'모델'.padEnd(32)} ${'TTFT'.padStart(8)} ${'총시간'.padStart(8)}`));
  log(dim('─'.repeat(52)));

  const results = [];
  for (const modelId of models) {
    if (modelId.startsWith('google-gemini-cli/') && !accessToken) continue;
    if (modelId.startsWith('openai/') && !openAIKey) continue;
    const r = await benchmarkModel(modelId, accessToken, openAIKey);
    results.push(r);
  }

  // TTFT 기준 정렬 (실패는 마지막)
  results.sort((a, b) => {
    if (a.ttft === null && b.ttft === null) return 0;
    if (a.ttft === null) return 1;
    if (b.ttft === null) return -1;
    return a.ttft - b.ttft;
  });

  // 결과 출력
  log('');
  log(bold('📊 결과 (TTFT 기준 정렬)'));
  log(dim('─'.repeat(60)));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      log(`  ${red('✗')} ${r.label.padEnd(30)} ${red('실패')}  ${dim(r.error?.slice(0,40) ?? '')}`);
      continue;
    }
    const rank   = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    const ttftStr  = `${r.ttft}ms`.padStart(8);
    const totalStr = `${r.total}ms`.padStart(8);
    const color  = i === 0 ? green : i < 3 ? yellow : (s => s);
    log(`  ${rank} ${color(r.label.padEnd(30))} ${cyan(ttftStr)} ${dim(totalStr)}  ${dim(r.sample ?? '')}`);
  }
  log(dim('─'.repeat(60)));

  const current = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG,'utf-8'))?.agents?.defaults?.model?.primary;
  log(`\n  현재 primary: ${dim(current)}`);

  const fastest = results.find(r => r.ok);
  if (fastest && fastest.modelId !== current) {
    log(`  최고 속도 모델: ${green(fastest.modelId)} (TTFT ${fastest.ttft}ms)`);
    if (doApply) {
      applyFastest(results);
    } else {
      log(dim(`\n  적용하려면: node scripts/speed-test.js --apply`));
    }
  } else if (fastest) {
    log(`  ${green('✅ 현재 모델이 가장 빠릅니다')}`);
  }
  log('');
}

main().catch(e => { log(red(`\n❌ 오류: ${e.message}`)); process.exit(1); });
