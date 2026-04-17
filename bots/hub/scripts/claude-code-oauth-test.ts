#!/usr/bin/env tsx
/**
 * Claude Code OAuth 호출 wrapper 테스트 스크립트
 *
 * 목적: Claude Code CLI를 subprocess로 호출하여 Max 구독을 활용한 LLM 호출 검증
 * - Primary: Claude Code OAuth (Max 구독 기반)
 * - Fallback: Groq API (ENV GROQ_API_KEY)
 */

import { spawn } from 'node:child_process';

export interface ClaudeCodeRequest {
  prompt: string;
  model?: 'haiku' | 'sonnet' | 'opus' | string;
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
  maxBudgetUsd?: number;
}

export interface ClaudeCodeResponse {
  ok: boolean;
  result?: string;
  structuredOutput?: unknown;
  durationMs: number;
  apiDurationMs?: number;
  totalCostUsd?: number;
  modelUsage?: Record<string, unknown>;
  sessionId?: string;
  error?: string;
}

/**
 * Claude Code CLI subprocess 호출
 * - `claude -p "prompt" --output-format json` 형태로 실행
 * - stdin을 /dev/null로 redirect하여 3초 warning 제거
 * - timeout / 종료 코드 / JSON parsing 처리
 */
export function callClaudeCodeOAuth(req: ClaudeCodeRequest): Promise<ClaudeCodeResponse> {
  const started = Date.now();
  const timeoutMs = req.timeoutMs ?? 60_000;

  return new Promise((resolve) => {
    const args = [
      '-p',
      req.prompt,
      '--output-format', 'json',
      '--no-session-persistence',
    ];

    if (req.model) {
      args.push('--model', req.model);
    }
    if (req.systemPrompt) {
      args.push('--append-system-prompt', req.systemPrompt);
    }
    if (req.jsonSchema) {
      args.push('--json-schema', JSON.stringify(req.jsonSchema));
    }
    if (req.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(req.maxBudgetUsd));
    }

    const proc = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'], // stdin=/dev/null
      env: {
        ...process.env,
        // ANTHROPIC_API_KEY 제거하여 OAuth 강제 사용
        ANTHROPIC_API_KEY: '',
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;

      if (timedOut) {
        resolve({ ok: false, durationMs, error: `timeout (${timeoutMs}ms)` });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, durationMs, error: `exit ${code}: ${stderr.trim().slice(0, 500)}` });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          ok: !parsed.is_error,
          result: parsed.result,
          structuredOutput: parsed.structured_output,
          durationMs,
          apiDurationMs: parsed.duration_api_ms,
          totalCostUsd: parsed.total_cost_usd,
          modelUsage: parsed.modelUsage,
          sessionId: parsed.session_id,
          error: parsed.is_error ? parsed.api_error_status : undefined,
        });
      } catch (err) {
        resolve({
          ok: false,
          durationMs,
          error: `JSON parse failed: ${(err as Error).message} / stdout: ${stdout.slice(0, 200)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        durationMs: Date.now() - started,
        error: `spawn error: ${err.message}`,
      });
    });
  });
}


// ---------------------------------------------------------------------
// Groq Fallback — OpenAI 호환 API
// ---------------------------------------------------------------------

export interface GroqRequest {
  prompt: string;
  model?: 'llama-3.3-70b-versatile' | 'llama-3.1-8b-instant' | 'qwen-qwq-32b' | string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * secrets-store.json에서 Groq 계정 풀 로드 (9개 계정, 로테이션)
 */
function pickGroqApiKey(): string | null {
  // 1차: 환경변수
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;

  // 2차: secrets-store 풀에서 random pick
  try {
    const path = require('path');
    const secretsPath = path.resolve(__dirname, '../secrets-store.json');
    const store = require(secretsPath);
    const accounts = store?.groq?.accounts ?? [];
    if (accounts.length === 0) return null;
    const idx = Math.floor(Math.random() * accounts.length);
    return accounts[idx]?.api_key ?? null;
  } catch {
    return null;
  }
}

export async function callGroqFallback(req: GroqRequest): Promise<ClaudeCodeResponse> {
  const started = Date.now();
  const apiKey = pickGroqApiKey();

  if (!apiKey) {
    return { ok: false, durationMs: 0, error: 'Groq API Key 없음 (env+secrets 모두)' };
  }

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: req.model ?? 'llama-3.3-70b-versatile',
        messages: [
          ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
          { role: 'user', content: req.prompt },
        ],
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.3,
      }),
    });

    const durationMs = Date.now() - started;

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return {
        ok: false,
        durationMs,
        error: `Groq ${resp.status}: ${body.slice(0, 300)}`,
      };
    }

    const data = await resp.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage ?? {};

    // Groq pricing 대략치 (Developer Tier):
    // Llama 3.3 70B: $0.59/M input, $0.79/M output
    // Llama 3.1 8B:  $0.05/M input, $0.08/M output
    const costPerMInput = req.model?.includes('8b') ? 0.05 : 0.59;
    const costPerMOutput = req.model?.includes('8b') ? 0.08 : 0.79;
    const estimatedCost =
      (usage.prompt_tokens ?? 0) / 1_000_000 * costPerMInput +
      (usage.completion_tokens ?? 0) / 1_000_000 * costPerMOutput;

    return {
      ok: true,
      result: content,
      durationMs,
      apiDurationMs: durationMs,
      totalCostUsd: estimatedCost,
      modelUsage: { [req.model ?? 'llama-3.3-70b-versatile']: usage },
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: `Groq fetch error: ${(err as Error).message}`,
    };
  }
}


// ---------------------------------------------------------------------
// Unified callWithFallback — Primary(Claude Code OAuth) → Fallback(Groq)
// ---------------------------------------------------------------------

export interface UnifiedRequest {
  prompt: string;
  model?: string;                  // Claude Code 모델명 (haiku/sonnet/opus)
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  groqModel?: string;              // Groq fallback 모델
}

export interface UnifiedResponse extends ClaudeCodeResponse {
  provider: 'claude-code-oauth' | 'groq' | 'failed';
  primaryError?: string;
}

export async function callWithFallback(req: UnifiedRequest): Promise<UnifiedResponse> {
  // 1차: Claude Code OAuth 시도
  const primary = await callClaudeCodeOAuth({
    prompt: req.prompt,
    model: req.model,
    systemPrompt: req.systemPrompt,
    jsonSchema: req.jsonSchema,
    timeoutMs: req.timeoutMs,
    maxBudgetUsd: req.maxBudgetUsd,
  });

  if (primary.ok) {
    return { ...primary, provider: 'claude-code-oauth' };
  }

  // 2차: Groq 폴백
  console.warn(`[CC-OAuth] Primary failed: ${primary.error} → Groq 폴백`);
  const fallback = await callGroqFallback({
    prompt: req.prompt,
    model: req.groqModel,
    systemPrompt: req.systemPrompt,
  });

  return {
    ...fallback,
    provider: fallback.ok ? 'groq' : 'failed',
    primaryError: primary.error,
  };
}


// ---------------------------------------------------------------------
// CLI 테스트 러너 — `tsx claude-code-oauth-test.ts` 직접 실행
// ---------------------------------------------------------------------

async function main() {
  console.log('🧪 Claude Code OAuth Wrapper 테스트 시작\n');

  // 테스트 1: Haiku 모델
  console.log('[1/4] Haiku 간단 질문');
  const r1 = await callClaudeCodeOAuth({
    prompt: '한국의 수도는?',
    model: 'haiku',
    timeoutMs: 30_000,
  });
  console.log(`  → ok=${r1.ok}, ${r1.durationMs}ms, $${r1.totalCostUsd?.toFixed(4)}`);
  console.log(`  → result: ${r1.result?.slice(0, 100)}`);
  console.log();

  // 테스트 2: Sonnet + JSON Schema
  console.log('[2/4] Sonnet + JSON Schema (structured output)');
  const r2 = await callClaudeCodeOAuth({
    prompt: '인천의 인구와 면적은?',
    model: 'sonnet',
    jsonSchema: {
      type: 'object',
      properties: {
        population: { type: 'integer' },
        area_km2: { type: 'number' },
      },
      required: ['population', 'area_km2'],
    },
    timeoutMs: 30_000,
  });
  console.log(`  → ok=${r2.ok}, ${r2.durationMs}ms, $${r2.totalCostUsd?.toFixed(4)}`);
  console.log(`  → structured: ${JSON.stringify(r2.structuredOutput)}`);
  console.log();

  // 테스트 3: Groq Fallback (secrets-store 계정 풀 자동 로드)
  console.log('[3/5] Groq Fallback 직접 호출 (secrets-store 풀)');
  const r3 = await callGroqFallback({
    prompt: '한국의 수도는? 한 단어로 답해.',
    model: 'llama-3.1-8b-instant',
  });
  console.log(`  → ok=${r3.ok}, ${r3.durationMs}ms, est $${r3.totalCostUsd?.toFixed(6)}`);
  console.log(`  → result: ${r3.result?.slice(0, 100)}`);
  if (!r3.ok) console.log(`  → error: ${r3.error}`);
  console.log();

  // 테스트 4: Groq 70B 모델 (Llama 3.3)
  console.log('[4/5] Groq Llama 3.3 70B (fallback 주력 모델)');
  const r4 = await callGroqFallback({
    prompt: '인천의 인구를 숫자만 답해. 예: 2990000',
    model: 'llama-3.3-70b-versatile',
  });
  console.log(`  → ok=${r4.ok}, ${r4.durationMs}ms, est $${r4.totalCostUsd?.toFixed(6)}`);
  console.log(`  → result: ${r4.result?.slice(0, 100)}`);
  console.log();

  // 테스트 5: Unified Fallback 체인 (Primary 성공 시나리오)
  console.log('[5/5] callWithFallback (전체 체인, Primary 성공)');
  const r5 = await callWithFallback({
    prompt: '1 + 1 = ?',
    model: 'haiku',
    timeoutMs: 30_000,
  });
  console.log(`  → provider=${r5.provider}, ok=${r5.ok}, ${r5.durationMs}ms`);
  console.log(`  → result: ${r5.result?.slice(0, 100)}`);
  if (r5.primaryError) console.log(`  → primaryError: ${r5.primaryError}`);
  console.log();

  console.log('✅ 테스트 완료');
}

// 직접 실행 감지 (tsx 기준)
const isMain = process.argv[1]?.endsWith('claude-code-oauth-test.ts');
if (isMain) {
  main().catch((err) => {
    console.error('❌ 테스트 실패:', err);
    process.exit(1);
  });
}
