'use strict';

/**
 * lib/intent-parser.js — 명령 인텐트 3단계 파싱
 *
 * 1단계: 슬래시 명령 직접 매핑 (토큰 0)
 * 2단계: 키워드 패턴 매칭 (토큰 0) — 학습된 패턴 포함 (nlp-learnings.json)
 * 3단계: LLM 폴백 파싱 (토큰 사용 — 현재 모델: llm-keys.js 참조)
 *
 * parse_source: 'slash' | 'keyword' | 'learned' | 'llm' | 'failed'
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { trackTokens }  = require('./token-tracker');
const { getGeminiKey } = require('../../../packages/core/lib/llm-keys');

// ─── 학습 패턴 로더 ─────────────────────────────────────────────────
// claude-commander analyze_unknown이 저장한 NLP 학습 패턴을 주기적으로 로드

const NLP_LEARNINGS_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'nlp-learnings.json');

function loadLearnedPatterns() {
  try {
    if (!fs.existsSync(NLP_LEARNINGS_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(NLP_LEARNINGS_PATH, 'utf8'));
    return raw
      .filter(l => l.re && l.intent)
      .map(l => ({
        re:     new RegExp(l.re, 'i'),
        intent: l.intent,
        args:   l.args || {},
      }));
  } catch { return []; }
}

let _learnedPatterns = loadLearnedPatterns();
// 5분마다 리로드 (analyze_unknown이 새 패턴 추가 시 자동 반영)
setInterval(() => { _learnedPatterns = loadLearnedPatterns(); }, 5 * 60 * 1000);

// ─── LLM 폴백 설정 (3단계 파싱용) ───────────────────────────────────
// 실제 사용 모델·키는 llm-keys.js에서 관리. 모델 교체 시 이 상수만 수정.

const LLM_FALLBACK_MODEL    = 'gemini-2.5-flash';
const LLM_FALLBACK_PROVIDER = 'google';

// ─── 1단계: 슬래시 명령 ──────────────────────────────────────────────

const SLASH_MAP = {
  '/status':  { intent: 'status',  args: {} },
  '/help':    { intent: 'help',    args: {} },
  '/cost':    { intent: 'cost',    args: {} },
  '/mute':    { intent: 'mute',    args: {} },  // 추가 파싱 필요
  '/unmute':  { intent: 'unmute',  args: {} },
  '/mutes':   { intent: 'mutes',   args: {} },
  '/luna':     { intent: 'luna',    args: {} },
  '/ska':      { intent: 'ska',     args: {} },
  '/dexter':   { intent: 'claude_action',     args: { command: 'run_check'        } },
  '/archer':   { intent: 'claude_action',     args: { command: 'run_archer'       } },
  '/brief':    { intent: 'brief',   args: {} },
  '/queue':    { intent: 'queue',   args: {} },
  '/withdraw': { intent: 'upbit_withdraw',    args: {} },
  '/upbit':    { intent: 'upbit_balance',     args: { command: 'get_upbit_balance'  } },
  '/binance':  { intent: 'binance_balance',   args: { command: 'get_binance_balance'} },
  '/price':    { intent: 'crypto_price',      args: { command: 'get_crypto_price'   } },
  '/market':   { intent: 'market_status',     args: { market: 'all' } },
  '/transfer': { intent: 'upbit_transfer',    args: { command: 'upbit_to_binance'   } },
};

function parseSlash(text) {
  const parts  = text.trim().split(/\s+/);
  const cmd    = parts[0].toLowerCase();

  // /claude <질문> — 클로드 AI 직접 질문
  if ((cmd === '/claude' || cmd === '/ask') && parts.length >= 2) {
    const query = text.trim().replace(/^\/\S+\s+/, '').trim();
    if (query) return { intent: 'claude_ask', args: { query }, source: 'slash' };
  }

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
  // ── 스카팀 세부 명령 (일반 'ska'보다 먼저 매칭) ──
  { re: /앤디.*(재시작|다시|restart|안\s*돼|죽|오류|에러)/i,  intent: 'ska_action', args: { command: 'restart_andy' } },
  { re: /지미.*(재시작|다시|restart|안\s*돼|죽|오류|에러)/i,  intent: 'ska_action', args: { command: 'restart_jimmy' } },
  { re: /예약.*(현황|목록|오늘|확인|조회|몇|있어)/i,          intent: 'ska_query',  args: { command: 'query_reservations' } },
  { re: /오늘.*(예약|방문|입장)/i,                            intent: 'ska_query',  args: { command: 'query_reservations' } },
  { re: /매출|수익|오늘.*얼마|얼마.*벌|오늘.*손님|입장.*통계|통계/i, intent: 'ska_query', args: { command: 'query_today_stats' } },
  { re: /알람.*(확인|조회|있어|뭐)|미해결.*(알람|문제|있어)|이상.*있어|경고.*있어/i, intent: 'ska_query', args: { command: 'query_alerts' } },

  // ── KIS 잔고 조회 (시장 현황 패턴보다 먼저 — "미국 주식 잔고" 오매칭 방지) ──
  { re: /국내.*(주식|주).*(잔고|잔액|포트폴리오|현황|얼마|보유)|KIS.*(잔고|잔액|보유|국내)/i,                                                                                         intent: 'kis_domestic_balance', args: { command: 'get_kis_domestic_balance' } },
  { re: /미국.*(주식|주).*(잔고|잔액|포트폴리오|현황|얼마|보유)|해외.*(주식|주).*(잔고|잔액|보유)|(나스닥|NYSE|해외주식).*(잔고|보유)/i,                                             intent: 'kis_overseas_balance', args: { command: 'get_kis_overseas_balance' } },

  // ── 시장 장시간 조회 (해외·암호화폐 먼저 — 국내 패턴에 오매칭 방지) ──
  { re: /미국.*(장|시장|시간|주식|마켓)|나스닥.*(장|열|중|시간)|뉴욕.*(장|열|중)|NYSE|NASDAQ|US.*market/i,                   intent: 'market_status', args: { market: 'overseas' } },
  { re: /지금.*거래.*가능|암호화폐.*장|코인.*장|바이낸스.*열/i,                                                               intent: 'market_status', args: { market: 'crypto' } },
  { re: /전체.*장|모든.*시장|장.*(뭐|뭔|어디).*열/i,                                                                         intent: 'market_status', args: { market: 'all' } },
  { re: /장.*(열렸|열려|시간|중이야|이야|언제|끝나|마감|개장|폐장)|국내.*장|코스피|코스닥/i,                                   intent: 'market_status', args: { market: 'domestic' } },

  // ── 업비트 USDT 출금 전용 (매수 없이 기존 USDT 잔고만 출금) — 전체전송보다 먼저 ──
  { re: /업비트.*(usdt|잔고).*(출금|보내|바이낸스|전송)(?!.*매수|.*구매)/i,     intent: 'upbit_withdraw', args: {} },
  { re: /usdt.*(출금만|만.*출금|출금.*해|출금.*바이낸스|출금.*전송)(?!.*매수)/i, intent: 'upbit_withdraw', args: {} },
  { re: /출금만.*해줘|usdt.*출금.*전용|withdraw.*usdt/i,                         intent: 'upbit_withdraw', args: {} },

  // ── 업비트→바이낸스 USDT 전체 플로우 (KRW 매수 + 출금) ──
  { re: /업비트.*바이낸스|upbit.*binance/i,                                     intent: 'upbit_transfer',  args: { command: 'upbit_to_binance' } },
  { re: /usdt.*(전송|보내|바이낸스)|바이낸스.*(usdt|전송|보내)/i,               intent: 'upbit_transfer',  args: { command: 'upbit_to_binance' } },
  { re: /업비트.*(usdt|달러|달러코인).*구매|krw.*usdt.*매수|원화.*usdt/i,       intent: 'upbit_transfer',  args: { command: 'upbit_to_binance' } },
  { re: /입금.*(usdt|달러|바이낸스|전송)|업비트.*입금.*바이낸스/i,              intent: 'upbit_transfer',  args: { command: 'upbit_to_binance' } },

  // ── 잔고·가격 조회 ──
  { re: /업비트.*(잔고|잔액|계좌|얼마|있어|뭐.*있|확인|조회)|upbit.*(balance|잔고)/i,     intent: 'upbit_balance',  args: { command: 'get_upbit_balance' } },
  { re: /바이낸스.*(잔고|잔액|계좌|얼마|있어|뭐.*있|확인|조회)|binance.*(balance|잔고)/i, intent: 'binance_balance', args: { command: 'get_binance_balance' } },
  { re: /\b(btc|eth|sol|bnb|xrp|ada|avax|doge|meme)\b.*(가격|얼마|현재가|price|시세)|비트코인.*(가격|얼마|현재가|시세)|이더리움.*(가격|얼마|현재가|시세)|솔라나.*(가격|얼마|현재가)/i, intent: 'crypto_price', args: { command: 'get_crypto_price' } },
  { re: /코인.*(가격|현재가|시세|얼마)|(가격|현재가|시세).*(코인|암호화폐|비트)/i,         intent: 'crypto_price',   args: { command: 'get_crypto_price' } },

  // ── 루나팀 세부 명령 ──
  { re: /루나.*(정지|멈춰|pause|중지|꺼|stop)|거래.*(정지|중지|멈춰|stop)|매매.*(멈춰|정지|중지|stop)|투자.*(멈춰|정지|중지)/i, intent: 'luna_action', args: { command: 'pause_trading' } },
  { re: /루나.*(재개|시작|resume|켜|다시)|거래.*(재개|다시|resume)|매매.*(재개|다시|시작)|투자.*(재개|다시)/i,                  intent: 'luna_action', args: { command: 'resume_trading' } },
  { re: /루나.*(리포트|보고|보여|report)|투자.*(리포트|보고|현황|report)|포트폴리오.*(보여|알려|현황)|수익률.*(알려|보여)/i,    intent: 'luna_query',  args: { command: 'force_report' } },
  { re: /루나.*(상태|현황|어때|잔고|포지션)|투자.*(상태|현황|어때)|잔고.*(얼마|어때)|USDT.*(얼마|있어)/i,                      intent: 'luna_query',  args: { command: 'get_status' } },

  // ── 클로드팀 세부 명령 ──
  { re: /아처.*(실행|해줘|보고|report|트렌드|소화)|기술.*(소화|트렌드|보고)|AI.*(트렌드|소식|최신)|LLM.*(소식|트렌드)/i, intent: 'claude_action', args: { command: 'run_archer' } },
  { re: /덱스터.*(전체|full|풀|완전).*점검|(전체|full|풀|완전).*점검|npm.*audit/i,                                       intent: 'claude_action', args: { command: 'run_full' } },
  { re: /덱스터.*(수정|fix|패치|고쳐)|자동.*(수정|fix|패치)/i,                                                           intent: 'claude_action', args: { command: 'run_fix' } },
  { re: /덱스터.*(일일|daily|보고)|일일.*(보고|리포트)|daily.*(report|보고)|오늘.*보고서/i,                              intent: 'claude_action', args: { command: 'daily_report' } },
  { re: /덱스터.*(점검|체크|check|괜찮|확인|살아)|시스템.*(점검|체크|check|괜찮)|서버.*(점검|체크|괜찮|확인)|보안.*점검/i, intent: 'claude_action', args: { command: 'run_check' } },

  // ── 스카팀 점검 (generic '스카' 패턴보다 먼저 체크) ──
  { re: /스카.*(시스템|서버|봇|점검|체크|확인|상태|health|check)|스카.*점검|ska.*check/i, intent: 'claude_action', args: { command: 'run_check' } },

  // ── 봇/팀 명칭 — 세부 명령 미매칭 시 팀 현황 조회 ──
  { re: /루나|luna/i,                             intent: 'luna'    },
  { re: /스카|ska/i,                              intent: 'ska'     },
  { re: /덱스터|dexter/i,                         intent: 'claude_action', args: { command: 'run_check' } },
  { re: /아처|archer/i,                           intent: 'claude_action', args: { command: 'run_archer' } },

  // ── 세션 마감 ──
  { re: /세션.*(마무리|마감|정리|close|끝)|마무리.*해줘|마감.*해줘|정리.*해줘|session.*close/i, intent: 'session_close' },

  // ── 마지막 알람 이벤트 무음·해제 ("이 알람 안 해도 돼" 등) ──
  // unmute가 mute보다 반드시 먼저 매칭 (해제 표현이 무음 표현에 포함될 수 있으므로)
  { re: /이\s*(알람|경고|메시지).*(무음\s*해제|해제해|해제해줘)/i,                                    intent: 'unmute_last_alert', args: {} },
  { re: /이\s*(알람|경고).*(다시|또|계속|알려줘|받을게)/i,                                            intent: 'unmute_last_alert', args: {} },
  { re: /이\s*(알람|경고|거|걸|것).*(안\s*해도|무시|끄|꺼|필요\s*없|충분히\s*알|알았어|됐어|그만|그냥)/i, intent: 'mute_last_alert', args: {} },
  { re: /이\s*(알람|경고|메시지).*(무음|조용히)/i,                                                    intent: 'mute_last_alert',   args: {} },

  // ── 기타 제이 직접 처리 ──
  { re: /브리핑|briefing|아침.*알람|야간.*보류/i, intent: 'brief'  },
  { re: /큐|queue/i,                              intent: 'queue'  },
  { re: /무음\s*(해제|off|cancel)/i,              intent: 'unmute', args: (m, t) => ({ target: extractTarget(t) }) },
  { re: /무음|mute|조용히/i,                      intent: 'mute',   args: (m, t) => ({ target: extractTarget(t), duration: extractDuration(t) }) },
  { re: /비용|cost|토큰|token/i,                  intent: 'cost'   },
  { re: /도움|help|명령\s*목록|뭐\s*할\s*수\s*있/i, intent: 'help' },

  // ── 팀 관련 일반 키워드 (봇 명칭 미매칭 시) ──
  { re: /투자|매매|비트|암호화폐|코인|주식/i,     intent: 'luna'   },
  { re: /예약|스터디|카페|손님/i,                 intent: 'ska'    },

  // ── 마지막: 일반 상태 (가장 포괄적) ──
  { re: /상태|현황|status|다들.*살아|모두.*어때/i, intent: 'status' },
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
  // 학습된 패턴 우선 확인 (analyze_unknown이 추가한 패턴)
  for (const p of _learnedPatterns) {
    if (p.re.test(text)) {
      return { intent: p.intent, args: p.args, source: 'learned' };
    }
  }
  // 기본 정적 패턴
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
사용자의 자연어 메시지를 분석해서 intent와 args를 JSON으로만 응답해.

=== 팀 구성 ===

[스카팀] 스터디카페 운영 관리
- ska_query  command=query_reservations : 오늘 예약 현황·목록
  예) "오늘 예약 뭐 있어", "예약 확인해", "예약 몇 건이야", "오늘 방문객 있어"
- ska_query  command=query_today_stats  : 오늘 매출·입장 통계
  예) "오늘 매출 얼마야", "오늘 얼마 벌었어", "오늘 손님 몇 명", "통계 줘", "수익 확인"
- ska_query  command=query_alerts       : 미해결 알람·경고 목록
  예) "알람 있어?", "미해결 문제 있어?", "이상한 거 있어?", "경고 있어?"
- ska_action command=restart_andy       : 앤디(네이버 모니터) 재시작
  예) "앤디 재시작해", "앤디 죽었어", "앤디 안 돼", "앤디 오류나"
- ska_action command=restart_jimmy      : 지미(키오스크 모니터) 재시작
  예) "지미 재시작해", "지미 죽었어", "지미 안 돼", "지미 오류나"
- ska (현황만) : "스카 상태", "스카 어때", "스카팀 현황"

[루나팀] 암호화폐·주식 자동매매 (바이낸스 BTC/ETH/SOL/BNB)
- luna_action command=pause_trading    : 거래 일시정지
  예) "루나 정지해", "매매 멈춰", "거래 중지해", "투자 일시정지", "루나 꺼"
- luna_action command=resume_trading   : 거래 재개
  예) "루나 재개해", "매매 다시 시작해", "거래 재개", "루나 다시 켜"
- luna_query  command=force_report     : 투자 리포트 즉시 발송
  예) "루나 리포트 줘", "투자 현황 보고해", "포트폴리오 보여줘", "수익률 알려줘"
- luna_query  command=get_status       : 현재 상태 (잔고·모드·포지션)
  예) "루나 상태 어때", "잔고 얼마야", "USDT 얼마 있어", "포지션 어때", "투자 현황"
- luna (현황만) : "루나 어때", "루나팀 상태"
- upbit_withdraw : 업비트 USDT 잔고 전량 바이낸스로 출금 (KRW 매수 없이 기존 USDT만)
  예) "업비트 USDT 출금해줘", "USDT 출금만 해줘", "업비트 잔고 바이낸스로 출금", "출금만 해줘"
  ※ 매수 없이 이미 있는 USDT를 출금할 때만 사용
- upbit_transfer command=upbit_to_binance : 업비트 KRW 전량으로 USDT 매수 후 바이낸스로 전송 (전체 플로우)
  예) "업비트 계좌 입금했어 전량 usdt 구매하고 바이낸스로 보내줘"
  예) "업비트에서 usdt 사서 바이낸스로 전송해줘"
  예) "업비트 바이낸스로 전송"
- upbit_balance command=get_upbit_balance : 업비트 계좌 잔고 조회 (KRW·코인별)
  예) "업비트 잔고 얼마야", "업비트 계좌 확인해", "업비트에 뭐 있어"
- binance_balance command=get_binance_balance : 바이낸스 계좌 잔고 조회 (USDT·코인별)
  예) "바이낸스 잔고 얼마야", "바이낸스 계좌 확인해", "바이낸스에 뭐 있어"
- crypto_price command=get_crypto_price : 암호화폐 현재가 조회 (BTC/ETH/SOL/BNB 기본)
  예) "비트코인 얼마야", "BTC 가격", "이더리움 현재가", "코인 시세", "ETH SOL 가격"
- kis_domestic_balance command=get_kis_domestic_balance : KIS 국내주식 잔고·평가손익
  예) "국내 주식 잔고", "한국 주식 보유 현황", "KIS 국내 잔고"
- kis_overseas_balance command=get_kis_overseas_balance : KIS 해외주식 잔고·평가손익
  예) "미국 주식 잔고", "해외 주식 보유 현황", "나스닥 보유 종목"

[시장 장시간 조회]
- market_status args.market=domestic : 국내주식 장 현황 (KOSPI/KOSDAQ)
  예) "국내장 열렸어?", "코스피 장 중이야?", "지금 국내장이야?", "국내 주식 거래되?", "장 언제 끝나?", "국내 시장 몇 시에 닫혀?"
- market_status args.market=overseas : 미국주식 장 현황 (NYSE/NASDAQ)
  예) "미국장 열렸어?", "나스닥 장 중이야?", "US 마켓 열려있어?", "뉴욕 거래소 열려?", "미국 주식 거래 시간이야?"
- market_status args.market=crypto   : 암호화폐 거래 현황
  예) "코인 거래 가능해?", "바이낸스 열려있어?", "암호화폐 지금 거래돼?"
- market_status args.market=all      : 전체 시장 장 현황
  예) "어디 장 열려있어?", "지금 어떤 시장이야?", "전체 시장 현황", "어느 시장 거래 중이야?"

[클로드팀] 시스템 유지보수·기술 분석
- claude_action command=run_check   : 덱스터 기본 점검 (코드·보안·DB)
  예) "덱스터 점검해", "시스템 점검해줘", "서버 괜찮아?", "보안 체크해"
- claude_action command=run_full    : 덱스터 전체 점검 (npm audit 포함)
  예) "전체 점검해줘", "풀 점검", "완전 점검", "npm audit 해줘"
- claude_action command=run_fix     : 덱스터 자동 수정
  예) "덱스터 수정해", "자동 수정해", "패치해줘", "취약점 고쳐줘"
- claude_action command=daily_report: 덱스터 일일 보고
  예) "일일 보고해줘", "오늘 보고서 줘", "데일리 리포트"
- claude_action command=run_archer  : 아처 기술 트렌드 수집·분석
  예) "아처 실행해", "기술 소화해줘", "AI 트렌드 알려줘", "최신 LLM 소식", "아처 보고"

[클로드 AI 직접 질문]
- claude_ask args.query=<질문내용> : 클로드 AI에게 직접 질문 (개발·분석·조언)
  예) "클로드한테 물어봐 루나 전략 어떻게 생각해", "클로드에게 질문 현재 시스템 구조 분석해줘"
  예) "클로드야 DB 스키마 최적화 방법 알려줘", "클로드 의견 들어봐 아처 보고서 개선방향"
  ※ 질문 내용(query)은 트리거 문구를 제외한 실제 질문만 추출

[제이 직접 처리]
- status : "시스템 현황", "전체 상태", "다들 어때", "모두 살아있어"
- cost   : "비용 얼마야", "토큰 얼마 썼어", "LLM 비용"
- brief  : "브리핑", "야간 알람 뭐 있어", "밤새 뭔 일 있었어"
- queue  : "알람 큐", "큐 확인"
- mute   : "루나 1시간 무음", "전체 조용히 30분" (args: target, duration)
- unmute : "루나 무음 해제" (args: target)
- mutes  : "무음 목록", "뭐 무음했어"
- mute_last_alert   : "이 알람 안 해도 돼", "이거 무시해", "이 경고 필요 없어", "충분히 알았어", "이 알람 꺼줘"
- unmute_last_alert : "이 알람 다시 알려줘", "이 알람 무음 해제해줘", "이거 다시 받을게"
- help   : "도움말", "뭐할 수 있어", "명령 목록"
- unknown: 위 어디에도 해당하지 않을 때

반드시 JSON 형식으로만 응답:
{"intent": "...", "args": {}, "confidence": 0.0~1.0}

args 필드: ska_query/ska_action/luna_query/luna_action/claude_action/upbit_transfer는 반드시 command 포함
claude_ask는 반드시 query 포함 (트리거 문구 제외한 실제 질문)
mute/unmute는 target 포함 (all|luna|ska|dexter|archer|claude)
mute는 duration 포함 (예: "1h", "30m", "1d")`;

async function parseLLMFallback(text) {
  const key = getGeminiKey();
  if (!key) return null;

  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model: LLM_FALLBACK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: text },
      ],
      max_tokens:      150,
      temperature:     0,
      response_format: { type: 'json_object' },
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
            model:     LLM_FALLBACK_MODEL,
            provider:  LLM_FALLBACK_PROVIDER,
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
              source: 'llm',
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

  // 3단계: LLM 폴백
  const llmResult = await parseLLMFallback(t);
  if (llmResult && llmResult.intent !== 'unknown') return llmResult;

  return { intent: 'unknown', args: {}, source: 'failed' };
}

module.exports = { parseIntent };
