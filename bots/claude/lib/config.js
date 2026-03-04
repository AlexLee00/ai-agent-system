'use strict';

const os   = require('os');
const path = require('path');

const HOME    = os.homedir();
const ROOT    = path.join(HOME, 'projects', 'ai-agent-system');

module.exports = {
  ROOT,

  // ─── 봇 경로 ───────────────────────────────────────
  BOTS: {
    reservation: path.join(ROOT, 'bots', 'reservation'),
    investment:  path.join(ROOT, 'bots', 'investment'),
    ska:         path.join(ROOT, 'bots', 'ska'),
    claude:      path.join(ROOT, 'bots', 'claude'),
  },

  // ─── DB 파일 ───────────────────────────────────────
  DBS: {
    reservation: path.join(HOME, '.openclaw', 'workspace', 'state.db'),
    investment:  path.join(ROOT, 'bots', 'investment', 'db', 'investment.duckdb'),
  },

  // ─── 로그 파일 ─────────────────────────────────────
  LOGS: {
    naver:    '/tmp/naver-ops-mode.log',
    crypto:   '/tmp/investment-crypto.log',
    domestic: '/tmp/investment-domestic.log',
    overseas: '/tmp/investment-overseas.log',
    openclaw: path.join(HOME, '.openclaw', 'logs'),
    dexter:   '/tmp/dexter.log',
    fixes:    path.join(HOME, 'projects', 'ai-agent-system', 'bots', 'claude', 'dexter-fixes.json'),
  },

  // ─── Lock 파일 ─────────────────────────────────────
  LOCKS: {
    dexter: '/tmp/dexter.lock',
  },

  // ─── secrets 경로 (텔레그램 토큰 읽기) — investment는 config.yaml 사용
  SECRETS: {
    reservation: path.join(ROOT, 'bots', 'reservation', 'secrets.json'),
  },

  // ─── 핵심 파일 무결성 체크 대상 ────────────────────
  CRITICAL_FILES: [
    'bots/reservation/lib/secrets.js',
    'bots/reservation/lib/db.js',
    'bots/reservation/auto/monitors/start-ops.sh',
    'bots/investment/markets/crypto.js',
    'bots/investment/markets/domestic.js',
    'bots/investment/markets/overseas.js',
    'bots/investment/shared/secrets.js',
    'bots/investment/shared/llm-client.js',
    'bots/claude/src/dexter.js',
  ],

  // ─── 네트워크 엔드포인트 ───────────────────────────
  ENDPOINTS: {
    binance:  { host: 'api.binance.com',           path: '/api/v3/ping',           label: '바이낸스' },
    upbit:    { host: 'api.upbit.com',              path: '/v1/market/all?isDetails=false', label: '업비트' },
    telegram: { host: 'api.telegram.org',           path: '/bot1/getMe',            label: '텔레그램' },
    naver:    { host: 'smartplace.naver.com',       path: '/',                      label: '네이버 스마트플레이스' },
    anthropic:{ host: 'api.anthropic.com',          path: '/v1/models',             label: 'Anthropic API' },
  },

  // ─── 임계값 ────────────────────────────────────────
  THRESHOLDS: {
    diskMinMB:       500,    // 최소 여유 디스크 (MB)
    logMaxMB:        50,     // 로그 파일 최대 크기 (MB)
    errorRateWarn:   10,     // 최근 100줄 중 오류 경고 기준 (%)
    errorRateCrit:   30,     // 최근 100줄 중 오류 위험 기준 (%)
    memMinFreeGB:    2,      // 최소 여유 메모리 (GB)
    npmAuditLevel:   'high', // npm audit 경고 수준 이상
  },
};
