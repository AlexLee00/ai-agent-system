'use strict';

/**
 * lib/intent-parser.js — 명령 인텐트 3단계 파싱 v2.0
 *
 * 1단계: 슬래시 명령 직접 매핑 (토큰 0)
 * 2단계: 키워드 패턴 매칭 (토큰 0) — 학습된 패턴 포함 (nlp-learnings.json)
 * 3단계: LLM 폴백 파싱 (CoT + Few-shot + 동적 예시, DB에서 자동 로드)
 *
 * parse_source: 'slash' | 'keyword' | 'learned' | 'llm' | 'failed'
 */

const https = require('https');
const { trackTokens }  = require('./token-tracker');
const { getGeminiKey } = require('../../../packages/core/lib/llm-keys');
const pgPool           = require('../../../packages/core/lib/pg-pool');
const {
  createLearnedPatternReloader,
  createPromotedIntentExampleLoader,
  injectDynamicExamples,
} = require('../../../packages/core/lib/intent-core');
const {
  getIntentLearningPath,
  getPromotedIntentExamples,
} = require('../../../packages/core/lib/intent-store');

// ─── 학습 패턴 로더 ─────────────────────────────────────────────────
// claude-commander analyze_unknown이 저장한 NLP 학습 패턴을 주기적으로 로드

const NLP_LEARNINGS_PATH = getIntentLearningPath();

const learnedPatternReloader = createLearnedPatternReloader({
  filePath: NLP_LEARNINGS_PATH,
  intervalMs: 5 * 60 * 1000,
});

// ─── 동적 Few-shot 예시 로더 (unrecognized_intents.promoted_to) ──────
// router.js의 promoteToIntent()가 승인한 예시를 LLM 프롬프트에 동적 추가

const loadDynamicExamples = createPromotedIntentExampleLoader({
  ttlMs: 5 * 60 * 1000,
  fetchRows: async () => getPromotedIntentExamples(pgPool, { schema: 'claude', limit: 30 }),
  maxTextLength: 60,
  confidence: 0.9,
});

// ─── LLM 폴백 설정 ───────────────────────────────────────────────────

const LLM_FALLBACK_MODEL    = 'gemini-2.5-flash';
const LLM_FALLBACK_PROVIDER = 'google';

// ─── 1단계: 슬래시 명령 ──────────────────────────────────────────────

const SLASH_MAP = {
  '/status':      { intent: 'status',              args: {} },
  '/help':        { intent: 'help',                args: {} },
  '/cost':        { intent: 'cost',                args: {} },
  '/speed':       { intent: 'speed_test',          args: {} },
  '/logs':        { intent: 'system_logs',         args: {} },
  '/mute':        { intent: 'mute',                args: {} },
  '/unmute':      { intent: 'unmute',              args: {} },
  '/mutes':       { intent: 'mutes',               args: {} },
  '/luna':        { intent: 'luna',                args: {} },
  '/ska':         { intent: 'ska',                 args: {} },
  '/dexter':      { intent: 'claude_action',       args: { command: 'run_check'          } },
  '/archer':      { intent: 'claude_action',       args: { command: 'run_archer'         } },
  '/brief':       { intent: 'brief',               args: {} },
  '/queue':       { intent: 'queue',               args: {} },
  '/withdraw':    { intent: 'upbit_withdraw',      args: {} },
  '/upbit':       { intent: 'upbit_balance',       args: { command: 'get_upbit_balance'   } },
  '/binance':     { intent: 'binance_balance',     args: { command: 'get_binance_balance' } },
  '/price':       { intent: 'crypto_price',        args: { command: 'get_crypto_price'    } },
  '/market':      { intent: 'market_status',       args: { market: 'all' } },
  '/transfer':    { intent: 'upbit_transfer',      args: { command: 'upbit_to_binance'    } },
  // ── 신규 슬래시 명령 ──
  '/shadow':      { intent: 'shadow_report',       args: {} },
  '/graduation':  { intent: 'llm_graduation',      args: {} },
  '/stability':   { intent: 'stability',           args: {} },
  '/journal':     { intent: 'trade_journal',       args: {} },
  '/performance': { intent: 'performance',         args: {} },
  '/unrec':       { intent: 'unrecognized_report', args: {} },
  '/promotions':  { intent: 'promotion_candidates', args: {} },
  '/luna-intents': { intent: 'team_intent_report', args: { team: 'luna' } },
  '/ska-intents':  { intent: 'team_intent_report', args: { team: 'ska' } },
  '/dynamic_tpsl_on':     { intent: 'dynamic_tpsl_on',     args: {} },
  '/dynamic_tpsl_off':    { intent: 'dynamic_tpsl_off',    args: {} },
  '/dynamic_tpsl_status': { intent: 'dynamic_tpsl_status', args: {} },
  // ── 블로그팀 커리큘럼 ──
  '/curriculum':          { intent: 'curriculum_status',   args: {} },
  '/curriculum_approve':  { intent: 'curriculum_approve',  args: {} },
};

function parseSlash(text) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  // /claude <질문> 또는 /ask <질문> — 클로드 AI 직접 질문
  if ((cmd === '/claude' || cmd === '/ask') && parts.length >= 2) {
    const query = text.trim().replace(/^\/\S+\s+/, '').trim();
    if (query) return { intent: 'claude_ask', args: { query }, source: 'slash' };
  }

  // /promote <인텐트> <패턴> — 미인식 명령 프로모트
  if (cmd === '/promote' && parts.length >= 3) {
    const toIntent = parts[1];
    const pattern  = parts.slice(2).join(' ');
    return { intent: 'promote_intent', args: { intent: toIntent, pattern }, source: 'slash' };
  }
  if (cmd === '/unrec' && parts.length >= 2) {
    const query = parts.slice(1).join(' ').trim();
    return { intent: 'unrecognized_report', args: { query }, source: 'slash' };
  }
  if (cmd === '/promotions' && parts.length >= 2) {
    const query = parts.slice(1).join(' ').trim();
    return { intent: 'promotion_candidates', args: { query }, source: 'slash' };
  }
  if ((cmd === '/luna-intents' || cmd === '/ska-intents') && parts.length >= 2) {
    const query = parts.slice(1).join(' ').trim();
    return {
      intent: 'team_intent_report',
      args: { team: cmd === '/luna-intents' ? 'luna' : 'ska', query },
      source: 'slash',
    };
  }
  if ((cmd === '/rollback' || cmd === '/forget') && parts.length >= 2) {
    const target = parts.slice(1).join(' ');
    return { intent: 'promotion_rollback', args: { target }, source: 'slash' };
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
  // ── 팀별 로그 direct route (넓은 query/log 패턴보다 먼저) ──
  { re: /(루나|luna).*(오류|에러|로그|상태로그)|투자팀.*(오류|에러|로그)/i, intent: 'team_logs', args: { team: 'luna' } },
  { re: /(스카|ska).*(오류|에러|로그|상태로그)|예약팀.*(오류|에러|로그)/i, intent: 'team_logs', args: { team: 'ska' } },
  { re: /(클로드|claude).*(오류|에러|로그|상태로그)|덱스터.*(오류|에러|로그)/i, intent: 'team_logs', args: { team: 'claude' } },
  { re: /(루나|luna).*(인텐트|학습|미인식|자동반영|패턴).*(현황|상태|후보|보여|조회)|투자팀.*(인텐트|학습).*(현황|후보)/i, intent: 'team_intent_report', args: { team: 'luna' } },
  { re: /(스카|ska).*(인텐트|학습|미인식|자동반영|패턴).*(현황|상태|후보|보여|조회)|예약팀.*(인텐트|학습).*(현황|후보)/i, intent: 'team_intent_report', args: { team: 'ska' } },
  { re: /(스카|ska).*(상태|현황|어때|잘\s*돌아|괜찮|살아)|예약팀.*(상태|현황|어때)/i, intent: 'team_status', args: { team: 'ska' } },
  { re: /(클로드|claude|덱스터).*(상태|현황|어때|잘\s*돌아|괜찮|살아)|클로드팀.*(상태|현황|어때)/i, intent: 'team_status', args: { team: 'claude' } },

  // ── 스카팀 세부 명령 (일반 'ska'보다 먼저 매칭) ──
  { re: /앤디.*(재시작|다시|restart|안\s*돼|죽|오류|에러)/i,  intent: 'ska_action', args: { command: 'restart_andy' } },
  { re: /지미.*(재시작|다시|restart|안\s*돼|죽|오류|에러)/i,  intent: 'ska_action', args: { command: 'restart_jimmy' } },
  { re: /(앤디|지미).*(살려|올려|켜|다시\s*띄워|다시\s*올려)/i,               intent: 'ska_action', args: (m) => ({ command: /앤디/.test(m[0]) ? 'restart_andy' : 'restart_jimmy' }) },
  { re: /알람.*큐|queue|대기.*알람|쌓인.*알람/i,                              intent: 'queue'  },
  { re: /예약.*(현황|목록|오늘|확인|조회|몇|있어)/i,          intent: 'ska_query',  args: { command: 'query_reservations' } },
  { re: /오늘.*(예약|방문|입장)/i,                            intent: 'ska_query',  args: { command: 'query_reservations' } },
  { re: /매출|수익|오늘.*얼마|얼마.*벌|오늘.*손님|입장.*통계/i,    intent: 'ska_query', args: { command: 'query_today_stats' } },
  { re: /알람.*(확인|조회|있어|뭐)|미해결.*(알람|문제|있어)|이상.*있어|경고.*있어/i, intent: 'ska_query', args: { command: 'query_alerts' } },

  // ── KIS 잔고 조회 (시장 현황 패턴보다 먼저) ──
  { re: /국내.*(주식|주).*(잔고|잔액|포트폴리오|현황|얼마|보유)|KIS.*(잔고|잔액|보유|국내)/i,                                                intent: 'kis_domestic_balance', args: { command: 'get_kis_domestic_balance' } },
  { re: /미국.*(주식|주).*(잔고|잔액|포트폴리오|현황|얼마|보유)|해외.*(주식|주).*(잔고|잔액|보유)|(나스닥|NYSE|해외주식).*(잔고|보유)/i,     intent: 'kis_overseas_balance', args: { command: 'get_kis_overseas_balance' } },

  // ── 시장 장시간 조회 ──
  { re: /미국.*(장|시장|시간|주식|마켓)|나스닥.*(장|열|중|시간)|뉴욕.*(장|열|중)|NYSE|NASDAQ|US.*market/i,    intent: 'market_status', args: { market: 'overseas' } },
  { re: /지금.*거래.*가능|암호화폐.*장|코인.*장|바이낸스.*열/i,                                               intent: 'market_status', args: { market: 'crypto' } },
  { re: /전체.*장|모든.*시장|장.*(뭐|뭔|어디).*열/i,                                                         intent: 'market_status', args: { market: 'all' } },
  { re: /장.*(열렸|열려|시간|중이야|이야|언제|끝나|마감|개장|폐장)|국내.*장|코스피|코스닥/i,                   intent: 'market_status', args: { market: 'domestic' } },

  // ── 업비트 USDT 출금 전용 (매수 없이 기존 USDT만) ──
  { re: /테더.*(전송|보내|바이낸스|출금|이동)|바이낸스.*테더.*(보내|전송)/i,     intent: 'upbit_withdraw', args: {} },
  { re: /tether.*(전송|보내|바이낸스|출금)|테더.*있.*(보내|전송|출금)/i,          intent: 'upbit_withdraw', args: {} },
  { re: /업비트.*(usdt|잔고).*(출금|보내|바이낸스|전송)(?!.*매수|.*구매)/i,     intent: 'upbit_withdraw', args: {} },
  { re: /usdt.*(출금만|만.*출금|출금.*해|출금.*바이낸스|출금.*전송)(?!.*매수)/i, intent: 'upbit_withdraw', args: {} },
  { re: /출금만.*해줘|usdt.*출금.*전용|withdraw.*usdt/i,                         intent: 'upbit_withdraw', args: {} },

  // ── 업비트→바이낸스 USDT 전체 플로우 ──
  { re: /업비트.*바이낸스|upbit.*binance/i,                                     intent: 'upbit_transfer', args: { command: 'upbit_to_binance' } },
  { re: /usdt.*(전송|보내|바이낸스)|바이낸스.*(usdt|전송|보내)/i,               intent: 'upbit_transfer', args: { command: 'upbit_to_binance' } },
  { re: /업비트.*(usdt|달러|달러코인).*구매|krw.*usdt.*매수|원화.*usdt/i,       intent: 'upbit_transfer', args: { command: 'upbit_to_binance' } },
  { re: /입금.*(usdt|달러|바이낸스|전송)|업비트.*입금.*바이낸스/i,              intent: 'upbit_transfer', args: { command: 'upbit_to_binance' } },

  // ── 잔고·가격 조회 ──
  { re: /업비트.*(잔고|잔액|계좌|얼마|있어|뭐.*있|확인|조회)|upbit.*(balance|잔고)/i,     intent: 'upbit_balance',  args: { command: 'get_upbit_balance' } },
  { re: /바이낸스.*(잔고|잔액|계좌|얼마|있어|뭐.*있|확인|조회)|binance.*(balance|잔고)/i, intent: 'binance_balance', args: { command: 'get_binance_balance' } },
  { re: /\b(btc|eth|sol|bnb|xrp|ada|avax|doge|meme)\b.*(가격|얼마|현재가|price|시세)|비트코인.*(가격|얼마|현재가|시세)|이더리움.*(가격|얼마|현재가|시세)|솔라나.*(가격|얼마|현재가)/i, intent: 'crypto_price', args: { command: 'get_crypto_price' } },
  { re: /코인.*(가격|현재가|시세|얼마)|(가격|현재가|시세).*(코인|암호화폐|비트)/i, intent: 'crypto_price', args: { command: 'get_crypto_price' } },

  // ── 루나팀 세부 명령 ──
  { re: /루나.*(정지|멈춰|pause|중지|꺼|stop)|거래.*(정지|중지|멈춰|stop)|매매.*(멈춰|정지|중지|stop)|투자.*(멈춰|정지|중지)/i, intent: 'luna_action', args: { command: 'pause_trading' } },
  { re: /루나.*(재개|시작|resume|켜|다시)|거래.*(재개|다시|resume)|매매.*(재개|다시|시작)|투자.*(재개|다시)/i,                  intent: 'luna_action', args: { command: 'resume_trading' } },
  { re: /루나.*(리포트|보고|보여|report)|투자.*(리포트|보고|현황|report)|포트폴리오.*(보여|알려|현황)|수익률.*(알려|보여)/i,    intent: 'luna_query',  args: { command: 'force_report' } },
  { re: /(투자|매매).*(요약|브리핑)|루나.*(브리핑|정리해줘)|오늘.*(투자|매매).*(정리|요약)/i,                              intent: 'luna_query',  args: { command: 'force_report' } },
  { re: /루나.*(상태|현황|어때|잔고|포지션)|투자.*(상태|현황|어때)|잔고.*(얼마|어때)|USDT.*(얼마|있어)/i,                      intent: 'luna_query',  args: { command: 'get_status' } },
  { re: /(루나|luna).*(지금|현재).*(어때|상태|현황|뭐\s*해|뭐하는)|루나.*(무슨\s*상황|무슨\s*일|잘\s*돌아|돌고\s*있)/i,         intent: 'luna_query',  args: { command: 'get_status' } },

  // ── 투자 분석 세부 ──
  { re: /애널리스트.*(정확도|정확성|accuracy)|분석가.*(정확도|성과|적중)/i,       intent: 'analyst_accuracy' },
  { re: /애널리스트.*(가중치|weight|비율)|분석가.*(가중치|비율)/i,               intent: 'analyst_weight' },
  { re: /매매일지|trade.*journal|거래.*일지|매매.*기록/i,                         intent: 'trade_journal' },
  { re: /매매.*리뷰|trade.*review|거래.*리뷰|투자.*후기/i,                        intent: 'trade_review' },
  { re: /투자.*성과|수익률.*상세|성과.*분석|performance.*detail/i,                intent: 'performance' },
  { re: /TP.*SL.*(현황|상태|설정)|손절.*익절.*(현황|상태)|stop.*loss.*(현황|설정)/i, intent: 'tp_sl_status' },

  // ── 클로드팀 세부 명령 ──
  { re: /아처.*(실행|해줘|보고|report|트렌드|소화)|기술.*(소화|트렌드|보고)|AI.*(트렌드|소식|최신)|LLM.*(소식|트렌드)/i, intent: 'claude_action', args: { command: 'run_archer' } },
  { re: /덱스터.*(전체|full|풀|완전).*점검|(전체|full|풀|완전).*점검|npm.*audit/i,                                       intent: 'claude_action', args: { command: 'run_full' } },
  { re: /덱스터.*(수정|fix|패치|고쳐)|자동.*(수정|fix|패치)/i,                                                           intent: 'claude_action', args: { command: 'run_fix' } },
  { re: /덱스터.*(퀵|빠른|quick|5분|단기)|퀵.*체크|quick.*check/i,                                                       intent: 'dexter_quickcheck' },
  { re: /덱스터.*(빠르게|간단히|짧게)|간단.*점검|빠른.*점검/i,                                                           intent: 'dexter_quickcheck' },
  { re: /덱스터.*(일일|daily|보고서|리포트)|일일.*(보고|리포트)|daily.*(report|보고)|오늘.*보고서/i,                       intent: 'dexter_report' },
  { re: /오늘.*(점검|시스템).*(요약|보고)|덱스터.*(요약|브리핑)|점검.*(요약|브리핑)/i,                                     intent: 'dexter_report' },
  { re: /덱스터.*(점검|체크|check|괜찮|확인|살아)|시스템.*(점검|체크|check|괜찮)|서버.*(점검|체크|괜찮|확인)|보안.*점검/i, intent: 'claude_action', args: { command: 'run_check' } },
  { re: /덱스터.*(지금.*봐|바로.*봐|지금.*점검)|바로.*덱스터.*(돌려|실행)|즉시.*점검/i,                                     intent: 'claude_action', args: { command: 'run_check' } },
  { re: /점검.*(이력|히스토리|기록)|에러.*(이력|log|기록)|오류.*(이력|기록)/i,                                            intent: 'doctor_history' },

  // ── 스카팀 점검 ──
  { re: /스카.*(시스템|서버|봇|점검|체크|확인|상태|health|check)|스카.*점검|ska.*check/i, intent: 'claude_action', args: { command: 'run_check' } },

  // ── 섀도 모드 ──
  { re: /섀도.*(불일치|오류|틀린|mismatch)|LLM.*(불일치|틀린)/i,             intent: 'shadow_mismatches' },
  { re: /섀도.*(리포트|보고|현황|결과|통계)|shadow.*(report|현황|리포트)/i,   intent: 'shadow_report' },

  // ── LLM 캐시·비용·졸업 ──
  { re: /캐시.*(현황|통계|적중|조회|hit)|cache.*(stats|현황|적중|통계)/i,      intent: 'cache_stats' },
  { re: /LLM.*(비용.*상세|팀별.*비용|cost.*detail)|토큰.*(상세|팀별|breakdown)/i, intent: 'llm_cost' },
  { re: /졸업.*(현황|후보|리포트|목록)|LLM.*졸업|graduation.*(현황|report)/i,  intent: 'llm_graduation' },

  // ── 시스템 안정성·텔레그램 ──
  { re: /안정성.*(현황|대시보드|dashboard)|stability.*(현황|report|대시보드)|시스템.*안정/i, intent: 'stability' },
  { re: /텔레그램.*(상태|연결|폴링|봇.*상태)|telegram.*(status|connected|polling)/i,       intent: 'telegram_status' },
  { re: /(오픈클로|openclaw|게이트웨이|gateway).*(상태|연결|어때|괜찮|살아)|제이.*(텔레그램|연결).*(어때|상태)/i,              intent: 'telegram_status' },
  { re: /속도.*(체크|테스트|측정|확인)|speed.*(check|test)|제일.*빠른.*모델|빠른.*모델.*뭐/i, intent: 'speed_test' },
  { re: /(최근|최신)?.*(오류|에러|로그).*(보여|확인|요약)|log.*(check|summary|error)|로그.*(확인|체크)|최근.*오류.*보여/i, intent: 'system_logs' },
  { re: /(mainbot|메인봇|제이|오픈클로|게이트웨이|gateway).*(오류|에러|로그)|오픈클로.*(무슨\s*문제|문제\s*있|에러)|제이.*로그/i, intent: 'system_logs' },
  // ── 미인식 패턴 리포트 ──
  { re: /미인식.*(명령|패턴|목록)|unrecognized.*(list|report)/i, intent: 'unrecognized_report' },
  { re: /자동.*(학습|반영).*(후보|목록|현황)|학습.*후보.*보여|promot(e|ion).*(candidate|list)|반영.*후보/i, intent: 'promotion_candidates' },
  { re: /(자동|학습).*(반영|패턴).*(취소|삭제|롤백)|패턴.*(되돌려|지워|삭제해)|forget.*pattern|rollback.*promotion/i, intent: 'promotion_rollback' },

  // ── 봇/팀 명칭 (세부 명령 미매칭 시) ──
  { re: /루나|luna/i,     intent: 'luna' },
  { re: /스카|ska/i,      intent: 'ska' },
  { re: /덱스터|dexter/i, intent: 'claude_action', args: { command: 'run_check' } },
  { re: /아처|archer/i,   intent: 'claude_action', args: { command: 'run_archer' } },

  // ── 블로그팀 커리큘럼 ──
  { re: /^[123]$/, intent: 'curriculum_approve', args: {} },  // 제안 번호 회신
  { re: /커리큘럼.*(승인|선택|확인|[123]번)|차기.*(시리즈|강의).*(승인|선택|[123])/i, intent: 'curriculum_approve', args: {} },
  { re: /커리큘럼.*(현황|상태|어때|잔여|남은|몇\s*강)/i, intent: 'curriculum_status', args: {} },
  { re: /차기.*시리즈.*(현황|제안|추천|언제)/i, intent: 'curriculum_status', args: {} },

  // ── 세션 마감 ──
  { re: /세션.*(마무리|마감|정리|close|끝)|마무리.*해줘|마감.*해줘|정리.*해줘|session.*close/i, intent: 'session_close' },

  // ── 마지막 알람 이벤트 무음·해제 ──
  { re: /이\s*(알람|경고|메시지).*(무음\s*해제|해제해|해제해줘)/i,                                    intent: 'unmute_last_alert', args: {} },
  { re: /이\s*(알람|경고).*(다시|또|계속|알려줘|받을게)/i,                                            intent: 'unmute_last_alert', args: {} },
  { re: /이\s*(알람|경고|거|걸|것).*(안\s*해도|무시|끄|꺼|필요\s*없|충분히\s*알|알았어|됐어|그만|그냥)/i, intent: 'mute_last_alert', args: {} },
  { re: /이\s*(알람|경고|메시지).*(무음|조용히)/i,                                                    intent: 'mute_last_alert',   args: {} },

  // ── 기타 제이 직접 처리 ──
  { re: /브리핑|briefing|아침.*알람|야간.*보류/i, intent: 'brief'  },
  { re: /브리핑|briefing|아침.*알람|야간.*보류|아침.*브리핑|보류.*알람.*보여/i, intent: 'brief'  },
  { re: /무음\s*(해제|off|cancel)/i,              intent: 'unmute', args: (m, t) => ({ target: extractTarget(t) }) },
  { re: /무음|mute|조용히/i,                      intent: 'mute',   args: (m, t) => ({ target: extractTarget(t), duration: extractDuration(t) }) },
  { re: /비용|cost|토큰|token/i,                  intent: 'cost'   },
  { re: /도움|help|명령\s*목록|뭐\s*할\s*수\s*있/i, intent: 'help' },

  // ── 팀 관련 일반 키워드 ──
  { re: /투자|매매|비트|암호화폐|코인|주식/i, intent: 'luna' },
  { re: /예약|스터디|카페|손님/i,             intent: 'ska'  },

  // ── 마지막: 일반 상태 ──
  { re: /제이.*(상태|현황|어때)|오픈클로.*(상태|현황|어때)|상태|현황|status|다들.*살아|모두.*어때/i, intent: 'status' },
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
  // 학습된 패턴 우선 확인
  for (const p of learnedPatternReloader.getPatterns()) {
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

// ─── 3단계: Gemini LLM (Chain-of-Thought + Few-shot) ─────────────────

const SYSTEM_PROMPT_BASE = `너는 AI 봇 시스템 제이(Jay)의 명령 분류기다.
사용자의 자연어 메시지를 분석해서 intent와 args를 JSON으로만 응답해.

=== 분류 방법 (Chain-of-Thought) ===
1단계: 어느 팀/영역인지 파악
   - 예약·스터디·카페·손님·앤디·지미·매출 → 스카팀
   - 투자·매매·코인·비트·주식·루나·바이낸스·업비트·잔고·포지션·수익 → 루나팀
   - 덱스터·아처·시스템·점검·체크·개발·서버·보안 → 클로드팀
   - 섀도·LLM·캐시·졸업·비용·토큰·안정성 → 시스템 분석
   - 인사말·잡담·날씨·이해 불가 → chat

2단계: 명령 유형 결정
   - 데이터 조회: query/balance/status → ska_query / luna_query / kis_*_balance 등
   - 액션 실행: 재시작/정지/재개 → ska_action / luna_action / claude_action
   - 분석 리포트: shadow/cost/graduation → 전용 intent
   - 일반 대화: 위 없음 → chat

=== 팀 구성 ===

[스카팀] 스터디카페 운영 관리
- ska_query  command=query_reservations : 예약 현황·목록
  예) "오늘 예약 뭐 있어", "예약 확인해", "예약 몇 건이야"
- ska_query  command=query_today_stats  : 오늘 매출·입장 통계
  예) "오늘 매출 얼마야", "오늘 얼마 벌었어", "오늘 손님 몇 명"
- ska_query  command=query_alerts       : 미해결 알람·경고 목록
  예) "알람 있어?", "미해결 문제 있어?", "경고 있어?"
- ska_action command=restart_andy       : 앤디(네이버 모니터) 재시작
- ska_action command=restart_jimmy      : 지미(키오스크 모니터) 재시작
- ska (현황만)

[루나팀] 암호화폐·주식 자동매매
- luna_action command=pause_trading    : 거래 일시정지
- luna_action command=resume_trading   : 거래 재개
- luna_query  command=force_report     : 투자 리포트 즉시 발송
- luna_query  command=get_status       : 현재 상태 (잔고·모드·포지션)
- luna (현황만)
- upbit_withdraw : 업비트 USDT 잔고 바이낸스 출금 (매수 없이)
  ※ "테더"라는 단어 포함 시 반드시 upbit_withdraw
- upbit_transfer command=upbit_to_binance : 업비트 KRW→USDT 매수 후 바이낸스 전송
- upbit_balance  : 업비트 계좌 잔고 조회
- binance_balance : 바이낸스 계좌 잔고 조회
- crypto_price command=get_crypto_price : 암호화폐 현재가
- kis_domestic_balance : KIS 국내주식 잔고·평가손익
- kis_overseas_balance : KIS 해외주식 잔고·평가손익
- market_status args.market=domestic/overseas/crypto/all : 시장 장 현황
- analyst_accuracy  : 애널리스트 정확도 통계
- analyst_weight    : 애널리스트 가중치 조회
- trade_journal     : 매매일지 조회 (최근 거래 기록)
- trade_review      : 매매 리뷰 조회 (사후 분석)
- performance       : 투자 성과 상세 (수익률·기간별)
- tp_sl_status      : TP/SL 설정 현황 (손절·익절 라인)

[클로드팀] 시스템 유지보수·기술 분석
- claude_action command=run_check   : 덱스터 기본 점검
- claude_action command=run_full    : 덱스터 전체 점검 (npm audit)
- claude_action command=run_fix     : 덱스터 자동 수정
- claude_action command=run_archer  : 아처 기술 트렌드 분석
- dexter_report    : 덱스터 일일 보고
- dexter_quickcheck: 덱스터 퀵체크 (5분 단기 점검)
- doctor_history   : 점검 에러 이력 조회
- stability        : 시스템 안정성 대시보드
- telegram_status  : 텔레그램 폴링 상태
- claude_ask args.query=<질문> : 클로드 AI 직접 질문

[시스템 분석]
- shadow_report    : 섀도 모드 리포트 (LLM vs 규칙 비교)
- shadow_mismatches: 섀도 불일치 목록 (LLM이 틀린 케이스)
- llm_cost         : LLM 비용 상세 분석 (팀별·모델별)
- cache_stats      : LLM 캐시 적중률 통계
- llm_graduation   : LLM 졸업 현황 (자동 규칙 전환 후보)

[제이 직접 처리]
- status : 전체 시스템 현황 ("/status", "다들 어때", "전체 상태")
- cost   : LLM 비용 요약 ("/cost", "비용 얼마야", "토큰 사용량")
- brief  : 야간 브리핑 ("브리핑", "밤새 뭔 일 있었어")
- queue  : 알람 큐 확인 ("/queue", "큐 확인")
- mute   : 무음 설정 args: target, duration (예: "루나 1시간 무음")
- unmute : 무음 해제 args: target
- mutes  : 무음 목록
- mute_last_alert   : 방금 받은 알람 타입 무음
- unmute_last_alert : 방금 받은 알람 무음 해제
- help   : 도움말
- chat   : 일반 대화·인사·이해 불가 (모든 팀과 무관한 자유 대화)

=== 분류 예시 (Few-shot) ===
사용자: "오늘 예약 뭐 있어?" → {"intent": "ska_query", "args": {"command": "query_reservations"}, "confidence": 0.97}
사용자: "루나 상태 어때?" → {"intent": "luna_query", "args": {"command": "get_status"}, "confidence": 0.95}
사용자: "시스템 섀도 리포트 보여줘" → {"intent": "shadow_report", "args": {}, "confidence": 0.92}
사용자: "LLM 졸업 현황" → {"intent": "llm_graduation", "args": {}, "confidence": 0.95}
사용자: "캐시 통계 보여줘" → {"intent": "cache_stats", "args": {}, "confidence": 0.90}
사용자: "매매일지 최근 10건" → {"intent": "trade_journal", "args": {}, "confidence": 0.93}
사용자: "TP SL 설정 어떻게 돼있어?" → {"intent": "tp_sl_status", "args": {}, "confidence": 0.92}
사용자: "덱스터 퀵체크 결과 알려줘" → {"intent": "dexter_quickcheck", "args": {}, "confidence": 0.93}
사용자: "안녕 제이야 잘 지내?" → {"intent": "chat", "args": {}, "confidence": 0.90}
사용자: "오늘 날씨 어때?" → {"intent": "chat", "args": {}, "confidence": 0.85}
{DYNAMIC_EXAMPLES}

반드시 JSON 형식으로만 응답:
{"intent": "...", "args": {}, "confidence": 0.0~1.0}

args 필드: ska_query/ska_action/luna_query/luna_action/claude_action/upbit_transfer는 반드시 command 포함
claude_ask는 반드시 query 포함 (트리거 문구 제외한 실제 질문)
mute/unmute는 target 포함 (all|luna|ska|dexter|archer|claude)
mute는 duration 포함 (예: "1h", "30m", "1d")`;

async function parseLLMFallback(text) {
  const key = getGeminiKey();
  if (!key) return null;

  // 동적 Few-shot 예시 주입 (unrecognized_intents에서 승인된 예시)
  const dynamicExamples = await loadDynamicExamples();
  const systemPrompt = injectDynamicExamples(SYSTEM_PROMPT_BASE, dynamicExamples);

  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model: LLM_FALLBACK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: text },
      ],
      max_tokens:      200,
      temperature:     0,
      response_format: { type: 'json_object' },
    }));

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path:     '/v1beta/openai/chat/completions',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${key}`,
        'Content-Type':   'application/json',
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

          trackTokens({
            bot:       '제이',
            team:      'orchestrator',
            model:     LLM_FALLBACK_MODEL,
            provider:  LLM_FALLBACK_PROVIDER,
            taskType:  'command_parse',
            tokensIn:  usage.prompt_tokens     || 0,
            tokensOut: usage.completion_tokens || 0,
          });

          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (!jsonMatch) { resolve(null); return; }

          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.intent) {
            resolve({
              intent:     parsed.intent,
              args:       parsed.args || {},
              source:     'llm',
              confidence: parsed.confidence || 0.8,
              tokensIn:   usage.prompt_tokens     || 0,
              tokensOut:  usage.completion_tokens || 0,
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
 * @returns {Promise<{intent, args, source, confidence?}>}
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

  // 3단계: LLM 폴백 (CoT + Few-shot + 동적 예시)
  const llmResult = await parseLLMFallback(t);
  if (llmResult) return llmResult;

  // 모든 단계 실패 → chat 폴백 (router.js가 handleChatFallback 처리)
  return { intent: 'chat', args: { text: t }, source: 'failed' };
}

module.exports = { parseIntent };
