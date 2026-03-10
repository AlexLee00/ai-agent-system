'use strict';

/**
 * lib/archer/config.js — 아처 전용 설정
 *
 * v2.0: MARKET 제거, WEB_SOURCES 추가, GitHub/NPM 신규 항목 추가
 */

const path = require('path');
const os   = require('os');

const HOME = os.homedir();
const ROOT = path.join(HOME, 'projects', 'ai-agent-system');

module.exports = {
  ROOT,

  // ─── GitHub Releases API ────────────────────────────────────────
  GITHUB: {
    // 핵심 AI/LLM SDK
    'anthropic-sdk-js':  'https://api.github.com/repos/anthropics/anthropic-sdk-node/releases/latest',
    'anthropic-sdk-py':  'https://api.github.com/repos/anthropics/anthropic-sdk-python/releases/latest',
    'mcp-sdk':           'https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases/latest',
    'groq-node':         'https://api.github.com/repos/groq/groq-typescript/releases/latest',
    'gemini-js':         'https://api.github.com/repos/googleapis/js-genai/releases/latest',
    // 런타임·프레임워크
    'claude-code':       'https://api.github.com/repos/anthropics/claude-code/releases/latest',
    'node':              'https://api.github.com/repos/nodejs/node/releases/latest',
    'cpython':           'https://api.github.com/repos/python/cpython/releases/latest',
    // 데이터·실행
    ccxt:               'https://api.github.com/repos/ccxt/ccxt/releases/latest',
    duckdb:             'https://api.github.com/repos/duckdb/duckdb/releases/latest',
    'better-sqlite3':   'https://api.github.com/repos/WiseLibs/better-sqlite3/releases/latest',
    playwright:         'https://api.github.com/repos/microsoft/playwright/releases/latest',
  },

  // ─── npm Registry ───────────────────────────────────────────────
  NPM: {
    BASE:     'registry.npmjs.org',
    PACKAGES: [
      '@anthropic-ai/sdk',
      '@modelcontextprotocol/sdk',
      'groq-sdk',
      'duckdb',
      'better-sqlite3',
      'ccxt',
      'playwright',
    ],
  },

  // ─── 웹 소스 (RSS / HTML) ────────────────────────────────────────
  WEB_SOURCES: [
    {
      id:     'openai-blog',
      label:  'OpenAI 뉴스',
      type:   'rss',
      url:    'https://openai.com/blog/rss.xml',  // 307 → /news/rss.xml 리다이렉트
    },
    {
      id:     'huggingface-blog',
      label:  'HuggingFace 블로그',
      type:   'rss',
      url:    'https://huggingface.co/blog/feed.xml',
    },
    {
      id:     'arxiv-cs-ai',
      label:  'arXiv CS.AI (주간)',
      type:   'rss',
      url:    'https://rss.arxiv.org/rss/cs.AI',
    },
    {
      id:     'simonwillison',
      label:  'Simon Willison (LLM 트렌드)',
      type:   'rss',
      url:    'https://simonwillison.net/atom/everything/',
    },
    {
      id:     'mit-tech-review-ai',
      label:  'MIT Technology Review AI',
      type:   'rss',
      url:    'https://www.technologyreview.com/feed/',
    },
  ],

  // ─── 현재 시스템 사용 버전 (초기값, 이후 cache.json이 관리) ───────
  CURRENT_VERSIONS: {
    '@anthropic-ai/sdk': '0.x',
    'groq-sdk':          '0.x',
    'ccxt':              '4.4.0',
    'duckdb':            '1.1.3',
    'better-sqlite3':    '11.0.0',
    'playwright':        '1.x',
  },

  // ─── 임계값 ─────────────────────────────────────────────────────
  THRESHOLDS: {
    githubTimeout:  8000,
    npmTimeout:     5000,
    webTimeout:     10000,
    openaiTimeout:  60000,
    auditTimeout:   30000,
  },

  // ─── 출력 경로 ──────────────────────────────────────────────────
  OUTPUT: {
    reportDir:        path.join(ROOT, 'bots', 'claude', 'reports'),
    cacheFile:        path.join(ROOT, 'bots', 'claude', 'archer-cache.json'),
    patchDir:         path.join(ROOT, 'bots', 'claude', 'reports', 'patches'),
    patchRequestFile: path.join(ROOT, 'PATCH_REQUEST.md'),
    lockFile:         '/tmp/archer.lock',
    logFile:          '/tmp/archer.log',
  },

  // ─── OpenAI API ─────────────────────────────────────────────────
  OPENAI: {
    model:       'gpt-4o',
    maxTokens:   2048,
    temperature: 0.3,
  },

  // ─── 시크릿 파일 경로 (github_token 등) ─────────────────────────
  SECRETS_PATHS: [
    path.join(ROOT, 'bots', 'claude', 'secrets.json'),
    path.join(HOME, '.openclaw', 'secrets.json'),
  ],

};
