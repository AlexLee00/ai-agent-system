import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const AI_AGENT_HOME = process.env.AI_AGENT_HOME
  || process.env.JAY_HOME
  || path.join(os.homedir(), '.ai-agent-system');
const AI_AGENT_WORKSPACE = process.env.AI_AGENT_WORKSPACE
  || process.env.JAY_WORKSPACE
  || path.join(AI_AGENT_HOME, 'workspace');

export const OVERRIDE_FILE = path.join(AI_AGENT_WORKSPACE, 'llm-timeouts.json');

const DEFAULTS = {
  'meta-llama/llama-4-scout-17b-16e-instruct': 5_000,
  'meta-llama/llama-4-maverick-17b-128e-instruct': 8_000,
  'llama-4-scout-17b-16e-instruct': 5_000,
  'llama-4-maverick-17b-128e-instruct': 8_000,
  'openai/gpt-oss-20b': 5_000,
  groq: 5_000,
  'claude-haiku-4-5-20251001': 15_000,
  'claude-sonnet-4-6': 90_000,
  'claude-opus-4-6': 120_000,
  haiku: 15_000,
  sonnet: 90_000,
  opus: 120_000,
  'gpt-4o': 30_000,
  'gpt-4o-mini': 20_000,
  openai: 30_000,
  'gemini-2.5-flash': 20_000,
  'gemini-2.5-flash-lite': 15_000,
  'gemini-2.5-pro': 60_000,
  'gemini-oauth/gemini-2.5-flash': 20_000,
  'gemini-oauth/gemini-2.5-flash-lite': 15_000,
  'gemini-oauth/gemini-2.5-pro': 60_000,
  'google-gemini-cli/gemini-2.5-flash': 20_000,
  'google-gemini-cli/gemini-2.5-flash-lite': 15_000,
  'google-gemini-cli/gemini-2.5-pro': 60_000,
  gemini: 20_000,
  default: 30_000,
} as const;

type TimeoutKey = keyof typeof DEFAULTS | string;
type TimeoutOverrides = Record<string, number>;

let overrides: TimeoutOverrides = {};
try {
  if (fs.existsSync(OVERRIDE_FILE)) {
    overrides = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')) as TimeoutOverrides;
  }
} catch {}

export const LLM_TIMEOUTS: Record<string, number> = { ...DEFAULTS, ...overrides };

export function getTimeout(modelOrProvider?: string | null): number {
  if (!modelOrProvider) return LLM_TIMEOUTS.default;
  if (LLM_TIMEOUTS[modelOrProvider] !== undefined) return LLM_TIMEOUTS[modelOrProvider]!;
  const shortName = modelOrProvider.split('/').pop();
  if (shortName && LLM_TIMEOUTS[shortName] !== undefined) return LLM_TIMEOUTS[shortName]!;
  return LLM_TIMEOUTS.default;
}

export function updateTimeouts(updates?: TimeoutOverrides | null): void {
  if (!updates || typeof updates !== 'object') return;
  Object.assign(overrides, updates);
  Object.assign(LLM_TIMEOUTS, updates);
  try {
    const dir = path.dirname(OVERRIDE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(overrides, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[llm-timeouts] 파일 저장 실패:', message);
  }
}

export function calcTimeout(model: string, measuredMs: number): number {
  const raw = measuredMs * 3;
  const rounded = Math.ceil(raw / 1000) * 1000;
  const minMap: Record<string, number> = {
    groq: 3_000,
    gemini: 5_000,
    openai: 10_000,
    anthropic: 10_000,
  };
  let minMs = 5_000;
  for (const [provider, min] of Object.entries(minMap)) {
    if (model.toLowerCase().includes(provider)) {
      minMs = min;
      break;
    }
  }
  return Math.max(rounded, minMs);
}
