import { spawn } from 'node:child_process';
import type { LLMCallResponse } from './types';

export interface ClaudeCodeRequest {
  prompt: string;
  model?: 'haiku' | 'sonnet' | 'opus';
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

const CLAUDE_CODE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_ACCESS_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

function buildClaudeCodeChildEnv() {
  const childEnv = { ...process.env };
  for (const key of CLAUDE_CODE_AUTH_ENV_KEYS) {
    delete childEnv[key];
  }
  return childEnv;
}

function terminationGraceMs(): number {
  const configured = Number(process.env.CLAUDE_CODE_TERMINATION_GRACE_MS || 2_000);
  return Number.isFinite(configured) ? Math.max(10, Math.min(10_000, Math.floor(configured))) : 2_000;
}

function killProcessTree(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): boolean {
  if (process.platform !== 'win32' && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch {}
  }
  return proc.kill(signal);
}

export function callClaudeCodeOAuth(req: ClaudeCodeRequest): Promise<LLMCallResponse> {
  const started = Date.now();
  const timeoutMs = req.timeoutMs ?? 60_000;
  const claudeCodeBin = process.env.CLAUDE_CODE_BIN || 'claude';

  return new Promise((resolve) => {
    const args = [
      '-p', req.prompt,
      '--output-format', 'json',
      '--no-session-persistence',
    ];

    if (req.model) args.push('--model', req.model);
    if (req.systemPrompt) args.push('--append-system-prompt', req.systemPrompt);
    if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
    if (req.maxBudgetUsd != null) args.push('--max-budget-usd', String(req.maxBudgetUsd));

    const proc = spawn(claudeCodeBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildClaudeCodeChildEnv(),
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let terminationRequested = false;
    let escalationTimer: NodeJS.Timeout | null = null;
    const requestTermination = () => {
      timedOut = true;
      if (terminationRequested) return;
      terminationRequested = true;
      killProcessTree(proc, 'SIGTERM');
      escalationTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) killProcessTree(proc, 'SIGKILL');
      }, terminationGraceMs());
      escalationTimer.unref?.();
    };
    if (req.signal?.aborted) requestTermination();
    else req.signal?.addEventListener('abort', requestTermination, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      req.signal?.removeEventListener('abort', requestTermination);
    };

    const timer = setTimeout(requestTermination, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code: number | null) => {
      cleanup();
      const durationMs = Date.now() - started;

      if (timedOut) {
        resolve({ ok: false, provider: 'failed', durationMs, error: `timeout (${timeoutMs}ms)` });
        return;
      }
      if (code !== 0) {
        const parsedError = parseClaudeCodeJson(stdout);
        if (parsedError) {
          resolve({
            ok: false,
            provider: 'failed',
            durationMs,
            apiDurationMs: parsedError.duration_api_ms,
            totalCostUsd: parsedError.total_cost_usd,
            modelUsage: parsedError.modelUsage,
            sessionId: parsedError.session_id,
            error: summarizeClaudeCodeError(parsedError, code),
          });
          return;
        }
        resolve({ ok: false, provider: 'failed', durationMs, error: `exit ${code}: ${stderr.trim().slice(0, 300)}` });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          ok: !parsed.is_error,
          provider: 'claude-code-oauth',
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
          provider: 'failed',
          durationMs,
          error: `JSON parse failed: ${(err as Error).message} / stdout: ${stdout.slice(0, 200)}`,
        });
      }
    });

    proc.on('error', (err: Error) => {
      cleanup();
      resolve({
        ok: false,
        provider: 'failed',
        durationMs: Date.now() - started,
        error: `spawn error: ${err.message}`,
      });
    });
  });
}

function parseClaudeCodeJson(stdout: string): any | null {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeClaudeCodeError(parsed: any, code: number | null): string {
  const parts = [
    parsed?.api_error_status,
    parsed?.subtype,
    Array.isArray(parsed?.errors) ? parsed.errors.join('; ') : null,
    parsed?.error,
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  const message = parts.length > 0 ? parts.join(': ') : `exit ${code}`;
  return message.slice(0, 500);
}
