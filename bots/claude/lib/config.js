'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const HOME    = os.homedir();
const ROOT    = path.join(HOME, 'projects', 'ai-agent-system');
const RUNTIME_CONFIG_PATH = path.join(ROOT, 'bots', 'claude', 'config.json');

function _mergeDeep(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      next[key] = _mergeDeep(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

// 팀별 lib/ 디렉토리에서 .js 파일을 자동 수집 (신규 팀 추가 시 자동 포함)
function _scanBotFiles() {
  const fixed = [
    'bots/reservation/lib/secrets.js',
    'bots/reservation/lib/db.js',
    'bots/reservation/auto/monitors/start-ops.sh',
    'bots/investment/markets/crypto.js',
    'bots/investment/markets/domestic.js',
    'bots/investment/markets/overseas.js',
    'bots/investment/shared/secrets.js',
    'bots/investment/shared/llm-client.js',
    'bots/claude/src/dexter.js',
  ];

  // bots/ 하위 각 팀의 lib/*.js 자동 수집 (blog, worker 등 신규 팀 포함)
  const auto = [];
  const botsDir = path.join(ROOT, 'bots');
  try {
    const teams = fs.readdirSync(botsDir).filter(t => {
      const p = path.join(botsDir, t);
      return fs.statSync(p).isDirectory() && !['claude', 'reservation', 'investment', '_template'].includes(t);
    });
    for (const team of teams) {
      const libDir = path.join(botsDir, team, 'lib');
      if (!fs.existsSync(libDir)) continue;
      fs.readdirSync(libDir)
        .filter(f => f.endsWith('.js'))
        .forEach(f => auto.push(`bots/${team}/lib/${f}`));
    }
  } catch (_) {}

  // 중복 제거 후 반환
  const seen = new Set(fixed);
  const result = [...fixed];
  for (const f of auto) {
    if (!seen.has(f)) { seen.add(f); result.push(f); }
  }
  return result;
}

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
  // reservation: PostgreSQL (reservation 스키마) — SQLite 제거됨
  DBS: {
    investment:  path.join(ROOT, 'bots', 'investment', 'db', 'investment.duckdb'),
    ska:         path.join(ROOT, 'bots', 'ska', 'db', 'ska.duckdb'),
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
  CRITICAL_FILES: _scanBotFiles(),

  // ─── 네트워크 엔드포인트 ───────────────────────────
  ENDPOINTS: {
    binance:  { host: 'api.binance.com',           path: '/api/v3/ping',           label: '바이낸스' },
    upbit:    { host: 'api.upbit.com',              path: '/v1/market/all?isDetails=false', label: '업비트' },
    telegram: { host: 'api.telegram.org',           path: '/bot1/getMe',            label: '텔레그램' },
    naver:    { host: 'smartplace.naver.com',       path: '/',                      label: '네이버 스마트플레이스' },
    anthropic:{ host: 'api.anthropic.com',          path: '/v1/models',             label: 'Anthropic API' },
  },

  // ─── 임계값 / 런타임 설정 ──────────────────────────
  THRESHOLDS: (() => {
    const defaults = {
      diskMinMB:       500,
      logMaxMB:        50,
      errorRateWarn:   10,
      errorRateCrit:   30,
      memMinFreeGB:    2,
      npmAuditLevel:   'high',
    };
    try {
      const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
      return _mergeDeep(defaults, parsed?.runtime_config?.thresholds || {});
    } catch {
      return defaults;
    }
  })(),

  RUNTIME: (() => {
    const defaults = {
      patterns: {
        patternDays: 7,
        newErrorHours: 8,
        errorThreshold: 5,
        warnThreshold: 3,
        cleanupDays: 30,
      },
      n8n: {
        healthUrl: 'http://127.0.0.1:5678/healthz',
        criticalWebhookUrl: 'http://127.0.0.1:5678/webhook/critical',
        timeoutMs: 5000,
      },
      quickcheck: {
        alertCooldownMs: 60 * 60 * 1000,
        restartCooldownMs: 30 * 60 * 1000,
        maxRestarts: 3,
        diskCriticalPercent: 90,
      },
      llmSelectorOverrides: {
        'claude.archer.tech_analysis': {
          chain: [
            { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 4096, temperature: 0.2 },
            { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 4096, temperature: 0.3 },
            { provider: 'groq', model: 'llama-4-scout-17b-16e-instruct', maxTokens: 4096, temperature: 0.3 },
          ],
        },
        'claude.lead.system_issue_triage': {
          chain: [
            { provider: 'openai', model: 'gpt-4o', maxTokens: 300, temperature: 0.1 },
            { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 300, temperature: 0.1 },
            { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 300, temperature: 0.1 },
          ],
        },
        'claude.dexter.ai_analyst': {
          lowModel: 'gpt-4o-mini',
          highModel: 'gpt-4o',
        },
      },
    };
    try {
      const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
      return _mergeDeep(defaults, parsed?.runtime_config || {});
    } catch {
      return defaults;
    }
  })(),
};
