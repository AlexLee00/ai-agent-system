'use strict';

/**
 * lib/archer/config.js — 아처 전용 설정
 */

const path = require('path');
const os   = require('os');

const HOME = os.homedir();
const ROOT = path.join(HOME, 'projects', 'ai-agent-system');

module.exports = {
  ROOT,

  // ─── GitHub Releases API ────────────────────────────────────
  GITHUB: {
    ccxt:             'https://api.github.com/repos/ccxt/ccxt/releases/latest',
    duckdb:           'https://api.github.com/repos/duckdb/duckdb/releases/latest',
    'better-sqlite3': 'https://api.github.com/repos/WiseLibs/better-sqlite3/releases/latest',
    playwright:       'https://api.github.com/repos/microsoft/playwright/releases/latest',
    'anthropic-sdk':  'https://api.github.com/repos/anthropics/anthropic-sdk-python/releases/latest',
    'groq-node':      'https://api.github.com/repos/groq/groq-typescript/releases/latest',
    'gemini-js':      'https://api.github.com/repos/googleapis/js-genai/releases/latest',
  },

  // ─── npm Registry ───────────────────────────────────────────
  NPM: {
    BASE: 'registry.npmjs.org',
    PACKAGES: ['duckdb', 'better-sqlite3', 'ccxt', 'playwright', '@anthropic-ai/sdk'],
  },

  // ─── 시장 데이터 ────────────────────────────────────────────
  MARKET: {
    fearGreed: { host: 'api.alternative.me', path: '/fng/?limit=7' },
    btc:       { host: 'api.binance.com',    path: '/api/v3/ticker/24hr?symbol=BTCUSDT' },
    eth:       { host: 'api.binance.com',    path: '/api/v3/ticker/24hr?symbol=ETHUSDT' },
  },

  // ─── 현재 우리 시스템 사용 버전 (초기값, 이후 cache.json이 관리) ──
  CURRENT_VERSIONS: {
    'ccxt':           '4.4.0',
    'duckdb':         '1.1.3',
    'better-sqlite3': '11.0.0',
    'playwright':     '1.x',
    'anthropic-sdk':  '0.x',
  },

  // ─── 임계값 ─────────────────────────────────────────────────
  THRESHOLDS: {
    fearGreedExtremeFear:  25,  // 이하: 극단적 공포
    fearGreedExtremeGreed: 75,  // 이상: 극단적 탐욕
    btcDropPct:           -5,   // 24h 하락 -5% → 주목
    githubTimeout:        8000,
    marketTimeout:        5000,
    claudeTimeout:        60000,
  },

  // ─── 출력 경로 ───────────────────────────────────────────────
  OUTPUT: {
    reportDir: path.join(ROOT, 'bots', 'claude', 'reports'),
    cacheFile: path.join(ROOT, 'bots', 'claude', 'archer-cache.json'),
    lockFile:  '/tmp/archer.lock',
    logFile:   '/tmp/archer.log',
  },

  // ─── Claude API ─────────────────────────────────────────────
  CLAUDE: {
    model:      'claude-sonnet-4-6',
    maxTokens:  4096,
    temperature: 0.3,
  },

  // ─── secrets 경로 (API 키 로드) ──────────────────────────────
  SECRETS_PATHS: [
    path.join(ROOT, 'bots', 'invest', 'secrets.json'),
    path.join(ROOT, 'bots', 'reservation', 'secrets.json'),
  ],
};
