/**
 * shared/llm-client.js — 통합 LLM 클라이언트 (Phase 3-A v2.1)
 *
 * PAPER_MODE=true  → 전원 Groq llama-4-scout (무료, ~$0/월)
 * PAPER_MODE=false → luna·nemesis = Claude Haiku 4.5 + 프롬프트 캐싱
 *                    나머지       = Groq Scout (무료)
 *
 * 모델 단가 (live mode):
 *   Haiku input  $1.00/1M | output $5.00/1M
 *   캐시 hit $0.10/1M (90% 절감) | write $1.25/1M
 *
 * 예상 비용:
 *   PAPER: ~$0/월
 *   LIVE:  ~$3-5/월 (luna+nemesis만 haiku, 30분 4심볼)
 */

import Anthropic    from '@anthropic-ai/sdk';
import Groq         from 'groq-sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml         from 'js-yaml';
import { tracker }  from './cost-tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 설정 로드 (config.yaml → secrets.json fallback) ─────────────────

let _cfg;
try {
  _cfg = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
} catch {
  try {
    const s = JSON.parse(readFileSync(join(__dirname, '..', 'secrets.json'), 'utf8'));
    _cfg = {
      paper_mode: s.paper_mode,
      anthropic: { api_key: s.anthropic_api_key || '' },
      groq: { accounts: (s.groq_api_keys || [s.groq_api_key]).filter(Boolean).map(k => ({ api_key: k })) },
    };
  } catch {
    _cfg = { paper_mode: true, anthropic: { api_key: '' }, groq: { accounts: [] } };
  }
}

export const PAPER_MODE = process.env.PAPER_MODE !== 'false' && _cfg.paper_mode !== false;

// ─── 모델 상수 ───────────────────────────────────────────────────────

export const GROQ_SCOUT_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
export const HAIKU_MODEL      = 'claude-haiku-4-5-20251001';

// live mode에서 Haiku를 사용하는 에이전트
const HAIKU_AGENTS = new Set(['luna', 'nemesis']);

// ─── Groq 클라이언트 (라운드로빈) ────────────────────────────────────

const _groqAccounts = (_cfg.groq?.accounts || []).filter(a => a.api_key);
const _groqClients  = _groqAccounts.map(a => new Groq({ apiKey: a.api_key }));
let   _groqIdx      = 0;

function nextGroqClient() {
  if (_groqClients.length === 0) throw new Error('Groq API 키 없음 — config.yaml groq.accounts 설정 필요');
  const client = _groqClients[_groqIdx % _groqClients.length];
  _groqIdx++;
  return client;
}

// ─── Anthropic 클라이언트 (지연 초기화) ─────────────────────────────

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  const apiKey = _cfg.anthropic?.api_key || '';
  if (!apiKey) throw new Error('Anthropic API 키 없음 — config.yaml anthropic.api_key 설정 필요');
  _anthropic = new Anthropic({
    apiKey,
    defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });
  return _anthropic;
}

// ─── JSON 파싱 헬퍼 ──────────────────────────────────────────────────

export function parseJSON(text) {
  if (!text) return null;
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = clean.search(/[\[{]/);
  const end   = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  try { return JSON.parse(clean); } catch { return null; }
}

// ─── 통합 LLM 호출 ───────────────────────────────────────────────────

/**
 * @param {string} agentName  'luna'|'nemesis'|'zeus'|'athena'|'oracle'|'hermes'|'sophia'
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [maxTokens=512]
 * @returns {Promise<string>}  LLM 응답 텍스트
 */
export async function callLLM(agentName, systemPrompt, userPrompt, maxTokens = 512) {
  const useHaiku = !PAPER_MODE && HAIKU_AGENTS.has(agentName);

  if (useHaiku) {
    // Claude Haiku + 프롬프트 캐싱 (live mode 전용)
    const res = await getAnthropic().messages.create({
      model:      HAIKU_MODEL,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });
    tracker.track(res.usage, agentName);
    return res.content[0]?.text || '';
  }

  // Groq Scout 라운드로빈 (rate limit 시 다음 키로)
  let lastErr;
  const maxAttempts = Math.max(_groqClients.length, 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const groq = nextGroqClient();
      const res  = await groq.chat.completions.create({
        model:      GROQ_SCOUT_MODEL,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      });
      return res.choices[0]?.message?.content || '';
    } catch (err) {
      if (err.status === 429) { lastErr = err; continue; } // rate limit → 다음 키
      throw err;
    }
  }
  throw lastErr ?? new Error(`Groq 전체 키 rate limit — ${agentName}`);
}
