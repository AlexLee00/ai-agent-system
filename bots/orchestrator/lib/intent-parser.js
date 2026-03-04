'use strict';

/**
 * lib/intent-parser.js — 명령 인텐트 3단계 파싱
 *
 * 1단계: 슬래시 명령 직접 매핑 (토큰 0)
 * 2단계: 키워드 패턴 매칭 (토큰 0)
 * 3단계: Gemini LLM 파싱 (토큰 사용, 단 무료)
 *
 * parse_source: 'slash' | 'keyword' | 'gemini' | 'failed'
 */

const https = require('https');
const { trackTokens }  = require('./token-tracker');
const { getGeminiKey } = require('../../../packages/core/lib/llm-keys');

// ─── Gemini 클라이언트 설정 ───────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash';

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
  // ── 스카 세부 명령 (일반 'ska'보다 먼저 매칭) ──
  { re: /예약.*(현황|목록|오늘)|오늘.*예약/i,     intent: 'ska_query',  args: { command: 'query_reservations' } },
  { re: /매출|수익|통계/i,                        intent: 'ska_query',  args: { command: 'query_today_stats' } },
  { re: /알람.*(확인|조회)|미해결.*알람/i,        intent: 'ska_query',  args: { command: 'query_alerts' } },
  { re: /앤디.*(재시작|다시|restart)/i,           intent: 'ska_action', args: { command: 'restart_andy' } },
  { re: /지미.*(재시작|다시|restart)/i,           intent: 'ska_action', args: { command: 'restart_jimmy' } },
  // ── 루나 세부 명령 ──
  { re: /루나.*(일시정지|멈춰|pause)|거래.*정지/i,   intent: 'luna_action', args: { command: 'pause_trading' } },
  { re: /루나.*(재개|시작|resume)|거래.*재개/i,       intent: 'luna_action', args: { command: 'resume_trading' } },
  { re: /투자.*리포트|루나.*리포트|루나.*보고/i,      intent: 'luna_query',  args: { command: 'force_report' } },
  { re: /루나.*상태|투자.*현황/i,                     intent: 'luna_query',  args: { command: 'get_status' } },
  // ── 클로드팀 세부 명령 ──
  { re: /덱스터.*(전체|full).*점검|전체.*점검/i,      intent: 'claude_action', args: { command: 'run_full' } },
  { re: /덱스터.*(수정|fix)|자동.*수정/i,             intent: 'claude_action', args: { command: 'run_fix' } },
  { re: /덱스터.*점검|시스템.*점검/i,                 intent: 'claude_action', args: { command: 'run_check' } },
  { re: /덱스터.*일일.*보고|일일.*보고/i,             intent: 'claude_action', args: { command: 'daily_report' } },
  { re: /아처.*실행|기술.*소화/i,                     intent: 'claude_action', args: { command: 'run_archer' } },
  // ── 봇/팀 명칭을 먼저 (더 구체적) — 순서 중요 ──
  { re: /루나|luna/i,                             intent: 'luna'    },
  { re: /스카|ska/i,                              intent: 'ska'     },
  { re: /덱스터|dexter/i,                         intent: 'dexter'  },
  { re: /아처|archer/i,                           intent: 'archer'  },
  { re: /브리핑|briefing|아침.*알람|야간.*보류/i, intent: 'brief' },
  { re: /큐|queue/i,                              intent: 'queue'   },
  { re: /무음\s*(해제|off|cancel)/i,              intent: 'unmute', args: (m, t) => ({ target: extractTarget(t) }) },
  { re: /무음|mute|조용히/i,                      intent: 'mute',   args: (m, t) => ({ target: extractTarget(t), duration: extractDuration(t) }) },
  { re: /비용|cost|토큰|token/i,                  intent: 'cost'    },
  { re: /도움|help|명령\s*목록/i,                 intent: 'help'    },
  { re: /투자|매매/i,                             intent: 'luna'    },
  { re: /예약|스터디/i,                           intent: 'ska'     },
  { re: /시스템.*점검|점검.*시스템/i,             intent: 'dexter'  },
  { re: /기술.*소화/i,                            intent: 'archer'  },
  // 마지막: 일반 상태 키워드 (가장 포괄적)
  { re: /상태|현황|status/i,                      intent: 'status'  },
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

// ─── 3단계: Gemini LLM ───────────────────────────────────────────────

const SYSTEM_PROMPT = `너는 AI 봇 시스템 제이(Jay)의 명령 파서다.
사용자의 자연어 메시지를 분석해서 JSON으로만 응답해.

가능한 intent:
- status      : 시스템 현황 조회
- cost        : LLM 비용/토큰 사용 조회
- help        : 도움말
- mute        : 알람 무음 설정 (args: target, duration)
- unmute      : 무음 해제 (args: target)
- mutes       : 무음 목록 조회
- luna        : 루나팀(투자봇) 현황
- ska         : 스카팀(예약봇) 현황
- ska_query    : 스카팀 세부 조회 (args: command = query_reservations|query_today_stats|query_alerts)
- ska_action   : 스카팀 제어 (args: command = restart_andy|restart_jimmy)
- luna_query   : 루나팀 세부 조회 (args: command = get_status|force_report)
- luna_action  : 루나팀 제어 (args: command = pause_trading|resume_trading)
- claude_action: 클로드팀 실행 (args: command = run_check|run_full|run_fix|daily_report|run_archer)
- dexter       : 덱스터 시스템 점검
- archer      : 아처 기술 분석
- brief       : 야간 보류 알람 브리핑
- queue       : 메시지 큐 조회
- unknown     : 알 수 없음

반드시 JSON 형식으로만 응답:
{"intent": "...", "args": {}, "confidence": 0.0~1.0}`;

async function parseGemini(text) {
  const key = getGeminiKey();
  if (!key) return null;

  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model: GEMINI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: text },
      ],
      max_tokens:  150,
      temperature: 0,
    }));

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path:     '/v1beta/openai/chat/completions',
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
            model:     GEMINI_MODEL,
            provider:  'google',
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
              source: 'gemini',
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

  // 3단계: Gemini
  const groqResult = await parseGemini(t);
  if (groqResult && groqResult.intent !== 'unknown') return groqResult;

  return { intent: 'unknown', args: {}, source: 'failed' };
}

module.exports = { parseIntent };
