// @ts-nocheck
/**
 * speed-test.ts - LLM API 속도 테스트 툴 (무료 모델)
 *
 * 지원 프로바이더:
 *   - Google Gemini (OAuth, 무료)  → cloudcode-pa.googleapis.com
 *       gemini-2.5-flash-lite / gemini-2.5-flash / gemini-2.5-pro
 *   - Ollama (로컬, 무료)
 *   - OpenAI  (데이터공유 무료)     → api.openai.com
 *   - Groq    (영구 무료 티어)      → GROQ_API_KEY
 *       llama-3.1-8b-instant / llama-3.3-70b-versatile
 *       meta-llama/llama-4-scout-17b-16e-instruct (750 T/s)
 *       qwen/qwen3-32b
 *       openai/gpt-oss-20b (OpenAI 오픈소스, Groq 경유)
 *   - Cerebras(영구 무료 티어)      → CEREBRAS_API_KEY
 *       llama3.1-8b / gpt-oss-120b
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
 * 키 설정: ~/.ai-agent-system/llm-control/speed-test-keys.json
 *
 * 사용법:
 *   npx tsx scripts/speed-test.ts              # 전체 테스트
 *   npx tsx scripts/speed-test.ts --runs=3     # 반복 횟수 지정
 *   npx tsx scripts/speed-test.ts --apply      # 결과를 Hub LLM control config에 자동 반영
 *   npx tsx scripts/speed-test.ts --model=gemini-2.5-flash,llama-4-scout
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const hubAlarmClient = require('../packages/core/lib/hub-alarm-client');
const { writeLatestSpeedSnapshot } = require('../packages/core/lib/llm-control/service');
const {
  LLM_CONTROL_CONFIG,
  loadModels,
  loadProviderKey,
  applyFastest,
} = require('../packages/core/lib/llm-control/tester-support');
const {
  PROVIDER_ENDPOINTS,
  OPENAI_COMPAT_PROVIDERS,
  refreshGeminiToken,
  benchmarkModel,
} = require('../packages/core/lib/llm-control/tester');

// ─── 설정 ──────────────────────────────────────────────────────────────────
const AI_AGENT_HOME = process.env.AI_AGENT_HOME || process.env.JAY_HOME || path.join(os.homedir(), '.ai-agent-system');
const AI_AGENT_WORKSPACE = process.env.AI_AGENT_WORKSPACE || process.env.JAY_WORKSPACE || path.join(AI_AGENT_HOME, 'workspace');
const SPEED_TEST_LATEST_FILE = path.join(AI_AGENT_WORKSPACE, 'llm-speed-test-latest.json');
const SPEED_TEST_HISTORY_FILE = path.join(AI_AGENT_WORKSPACE, 'llm-speed-test-history.jsonl');
const TEST_PROMPT          = 'Reply with exactly one word: ok';

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
    statusLine = `\n\n📌 현재: ${current}\n💡 추천: ${recommended}\n⚠️ 적용: npx tsx scripts/speed-test.ts --apply`;
  } else {
    statusLine = `\n\n✅ 현재 모델(${current})이 가장 빠름`;
  }

  const text = `⚡ LLM 속도 테스트 결과 (${dateStr})\n\n${top3}${statusLine}\n\n❌ 실패: ${failed}개`;
  return hubAlarmClient.postAlarm({
    team: 'claude-lead',
    message: text,
    alertLevel: 1,
    fromBot: 'speed-test',
  });
}

function writeLatestSnapshot(results, { applied, recommended, current } = {}) {
  const status = writeLatestSpeedSnapshot(results, {
    prompt: TEST_PROMPT,
    runs: runsArg,
    current: current || null,
    recommended: recommended || null,
    applied: applied || null,
  });
  if (status.latestSaved) {
    log(dim(`\n  📝 최신 속도 스냅샷 저장: ${SPEED_TEST_LATEST_FILE}`));
  } else {
    log(dim(`\n  ⚠️ 속도 스냅샷 저장 실패: ${status.latestError}`));
  }
  if (status.historySaved) {
    log(dim(`  🗂️ 속도 히스토리 누적: ${SPEED_TEST_HISTORY_FILE}`));
  } else {
    log(dim(`  ⚠️ 속도 히스토리 저장 실패: ${status.historyError}`));
  }
  return status;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────
async function main() {
  log(bold('\n🚀 LLM API 속도 테스트'));
  log(dim(`   프롬프트: "${TEST_PROMPT}"`));
  log(dim(`   반복: ${runsArg}회 평균\n`));

  const models = loadModels(fs, { modelArg });
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
      const key = loadProviderKey(fs, provider);
    if (key) {
      ctx.keys[provider] = key;
      log(`🔑 ${provider.padEnd(14)} API 키 ${green('✅')}`);
    } else {
      log(`${yellow('⚠️')}  ${provider.padEnd(14)} API 키 없음 — ${dim('~/.ai-agent-system/llm-control/speed-test-keys.json 에 추가')}`);
    }
  }

  // Ollama 상태 확인
  if (models.some(m => m.startsWith('ollama/'))) {
    try {
      await new Promise((res, rej) => {
        const req = require('http').get('http://127.0.0.1:11434/api/tags', () => res());
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
    const r = await benchmarkModel(modelId, ctx, {
      runs: runsArg,
      prompt: TEST_PROMPT,
      onProgress: ({ type, label }) => {
        if (type === 'start') process.stdout.write(`  ${label.padEnd(34)} `);
        if (type === 'success') process.stdout.write(dim('.'));
        if (type === 'error') process.stdout.write(red('✗'));
      },
    });
    process.stdout.write('\n');
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

  const current = JSON.parse(fs.readFileSync(LLM_CONTROL_CONFIG, 'utf-8'))?.agents?.defaults?.model?.primary;
  log(`\n  현재 primary: ${dim(current)}`);

  const fastest = results.find(r => r.ok);
  let appliedModel = null;
  if (fastest && fastest.modelId !== current) {
    log(`  최고 속도: ${green(fastest.modelId)} (TTFT ${fastest.ttft}ms)`);
    if (doApply) {
      appliedModel = applyFastest(fs, results);
      if (appliedModel) {
        const updated = JSON.parse(fs.readFileSync(LLM_CONTROL_CONFIG, 'utf-8'));
        log(`\n✅ Hub LLM control config 업데이트 완료`);
        log(`   primary:   ${appliedModel}`);
        log(`   fallbacks: ${(updated?.agents?.defaults?.model?.fallbacks || []).join(', ')}`);
      } else {
        log('\n⚠️  적용할 Gemini 모델 결과 없음');
      }
    } else {
      log(dim(`\n  Gemini 기준 적용: npx tsx scripts/speed-test.ts --apply`));
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
  const snapshotStatus = writeLatestSnapshot(results, {
    applied: appliedModel,
    recommended: fastest?.modelId,
    current,
  });
  log('');

  const successfulRuns = results.filter((r) => r.ok).length;
  const attemptedRuns = results.length;
  const storageOk = snapshotStatus.latestSaved && snapshotStatus.historySaved;

  if (attemptedRuns === 0) {
    log(red('❌ 속도 테스트 실패: 실행 가능한 모델이 없어 측정 결과가 없습니다.'));
    return 2;
  }

  if (successfulRuns === 0) {
    const sampleErrors = results
      .filter((r) => !r.ok && r.error)
      .slice(0, 3)
      .map((r) => `${r.modelId}: ${r.error}`)
      .join(' | ');
    log(red(`❌ 속도 테스트 실패: 모든 모델 측정이 실패했습니다.${sampleErrors ? ` ${sampleErrors}` : ''}`));
    return 2;
  }

  if (!storageOk) {
    const storageErrors = [snapshotStatus.latestError, snapshotStatus.historyError].filter(Boolean).join(' | ');
    log(red(`❌ 속도 테스트 실패: 측정 결과 저장에 실패했습니다.${storageErrors ? ` ${storageErrors}` : ''}`));
    return 3;
  }

  return 0;
}

main()
  .then((code) => {
    if (Number.isInteger(code) && code !== 0) process.exit(code);
  })
  .catch((e) => {
    log(red(`\n❌ 오류: ${e.message}`));
    process.exit(1);
  });
