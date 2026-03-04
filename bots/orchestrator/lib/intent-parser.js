'use strict';

/**
 * lib/intent-parser.js — 명령 인텐트 3단계 파싱
 *
 * 1단계: 슬래시 명령 직접 매핑 (토큰 0)
 * 2단계: 키워드 패턴 매칭 (토큰 0)
 * 3단계: Groq Scout LLM 파싱 (토큰 사용, 단 무료)
 *
 * parse_source: 'slash' | 'keyword' | 'groq' | 'failed'
 */

const https = require('https');
const path  = require('path');
const fs    = require('fs');
const { trackTokens } = require('./token-tracker');

// ─── Groq 클라이언트 설정 ─────────────────────────────────────────────

function loadGroqKeys() {
  try {
    const cfgPath = path.join(__dirname, '..', '..', 'investment', 'config.yaml');
    const yaml = require('js-yaml');
    const cfg  = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
    return (cfg?.groq?.accounts || []).map(a => a.api_key).filter(Boolean);
  } catch {}
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets.json'), 'utf8'));
    return [s.groq_api_key].filter(Boolean);
  } catch {}
  return [];
}

let _groqKeys = null;
let _groqIdx  = 0;

function nextGroqKey() {
  if (!_groqKeys) _groqKeys = loadGroqKeys();
  if (_groqKeys.length === 0) return null;
  const key = _groqKeys[_groqIdx % _groqKeys.length];
  _groqIdx++;
  return key;
}

const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// ─── 1단계: 슬래시 명령 ──────────────────────────────────────────────

const SLASH_MAP = {
  '/status':  { intent: 'status',  args: {} },
  '/help':    { intent: 'help',    args: {} },
  '/cost':    { intent: 'cost',    args: {} },
  '/mute':    { intent: 'mute',    args: {} },  // 추가 파싱 필요
  '/unmute':  { intent: 'unmute',  args: {} },
  '/mutes':   { intent: 'mutes',   args: {} },
  '/luna':    { intent: 'luna',    args: {} },
  '/ska':     { intent: 'ska',     args: {} },
  '/dexter':  { intent: 'dexter',  args: {} },
  '/archer':  { intent: 'archer',  args: {} },
  '/brief':   { intent: 'brief',   args: {} },
  '/queue':   { intent: 'queue',   args: {} },
};

function parseSlash(text) {
  const parts  = text.trim().split(/\s+/);
  const cmd    = parts[0].toLowerCase();
  const mapped = SLASH_MAP[cmd];
  if (!mapped) return null;

  // /mute luna 1h 파싱
  if (cmd === '/mute' && parts.length >= 3) {
    return { intent: 'mute', args: { target: parts[1], duration: parts[2] }, source: 'slash' };
  }
  if (cmd === '/unmute' && parts.length >= 2) {
    return { intent: 'unmute', args: { target: parts[1] }, source: 'slash' };
  }

  return { intent: mapped.intent, args: mapped.args, source: 'slash' };
}

// ─── 2단계: 키워드 패턴 ──────────────────────────────────────────────

const KEYWORD_PATTERNS = [
  // 봇/팀 명칭을 먼저 (더 구체적) — 순서 중요
  { re: /루나|luna/i,                       intent: 'luna'    },
  { re: /스카|ska/i,                        intent: 'ska'     },
  { re: /덱스터|dexter/i,                   intent: 'dexter'  },
  { re: /아처|archer/i,                     intent: 'archer'  },
  { re: /브리핑|briefing|아침.*알람|야간.*보류/i, intent: 'brief' },
  { re: /큐|queue/i,                        intent: 'queue'   },
  { re: /무음\s*(해제|off|cancel)/i,        intent: 'unmute', args: (m, t) => ({ target: extractTarget(t) }) },
  { re: /무음|mute|조용히/i,                intent: 'mute',   args: (m, t) => ({ target: extractTarget(t), duration: extractDuration(t) }) },
  { re: /비용|cost|토큰|token/i,            intent: 'cost'    },
  { re: /도움|help|명령\s*목록/i,           intent: 'help'    },
  { re: /투자|매매/i,                       intent: 'luna'    },
  { re: /예약|스터디/i,                     intent: 'ska'     },
  { re: /시스템.*점검|점검.*시스템/i,       intent: 'dexter'  },
  { re: /기술.*소화/i,                      intent: 'archer'  },
  // 마지막: 일반 상태 키워드 (가장 포괄적)
  { re: /상태|현황|status/i,                intent: 'status'  },
];

function extractTarget(text) {
  const m = text.match(/\b(all|luna|ska|dexter|archer|investment|reservation|claude)\b/i);
  return m ? m[1].toLowerCase() : 'all';
}

function extractDuration(text) {
  const m = text.match(/(\d+)\s*(분|m|시간|h|일|d)/i);
  if (!m) return '1h';
  const n    = m[1];
  const unit = { '분': 'm', 'm': 'm', '시간': 'h', 'h': 'h', '일': 'd', 'd': 'd' }[m[2].toLowerCase()];
  return `${n}${unit}`;
}

function parseKeyword(text) {
  for (const p of KEYWORD_PATTERNS) {
    if (p.re.test(text)) {
      const args = typeof p.args === 'function' ? p.args(null, text) : (p.args || {});
      return { intent: p.intent, args, source: 'keyword' };
    }
  }
  return null;
}

// ─── 3단계: Groq Scout LLM ───────────────────────────────────────────

const SYSTEM_PROMPT = `너는 AI 봇 시스템 제이(Jay)의 명령 파서다.
사용자의 자연어 메시지를 분석해서 JSON으로만 응답해.

가능한 intent:
- status    : 시스템 현황 조회
- cost      : LLM 비용/토큰 사용 조회
- help      : 도움말
- mute      : 알람 무음 설정 (args: target, duration)
- unmute    : 무음 해제 (args: target)
- mutes     : 무음 목록 조회
- luna      : 루나팀(투자봇) 현황
- ska       : 스카팀(예약봇) 현황
- dexter    : 덱스터 시스템 점검
- archer    : 아처 기술 분석
- brief     : 야간 보류 알람 브리핑
- queue     : 메시지 큐 조회
- unknown   : 알 수 없음

반드시 JSON 형식으로만 응답:
{"intent": "...", "args": {}, "confidence": 0.0~1.0}`;

async function parseGroq(text) {
  const key = nextGroqKey();
  if (!key) return null;

  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: text },
      ],
      max_tokens:  150,
      temperature: 0,
    }));

    const req = https.request({
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const r = JSON.parse(raw);
          if (r.error) { resolve(null); return; }

          const content = r.choices?.[0]?.message?.content?.trim() || '';
          const usage   = r.usage || {};

          // 토큰 기록
          trackTokens({
            bot:       '제이',
            team:      'orchestrator',
            model:     GROQ_MODEL,
            provider:  'groq',
            taskType:  'command_parse',
            tokensIn:  usage.prompt_tokens     || 0,
            tokensOut: usage.completion_tokens || 0,
          });

          // JSON 추출
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (!jsonMatch) { resolve(null); return; }

          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.intent) {
            resolve({
              intent: parsed.intent,
              args:   parsed.args || {},
              source: 'groq',
              confidence: parsed.confidence || 0.8,
              tokensIn:  usage.prompt_tokens     || 0,
              tokensOut: usage.completion_tokens || 0,
            });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── 통합 파서 ───────────────────────────────────────────────────────

/**
 * 명령 파싱 (3단계)
 * @param {string} text  사용자 입력 텍스트
 * @returns {Promise<{intent, args, source}>}
 */
async function parseIntent(text) {
  const t = text.trim();

  // 1단계: 슬래시
  if (t.startsWith('/')) {
    const result = parseSlash(t);
    if (result) return result;
  }

  // 2단계: 키워드
  const kw = parseKeyword(t);
  if (kw) return kw;

  // 3단계: Groq
  const groqResult = await parseGroq(t);
  if (groqResult && groqResult.intent !== 'unknown') return groqResult;

  return { intent: 'unknown', args: {}, source: 'failed' };
}

module.exports = { parseIntent };
