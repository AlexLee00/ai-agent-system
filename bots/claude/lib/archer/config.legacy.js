'use strict';

/**
 * lib/archer/config.js — 아처 전용 설정
 *
 * v2.0: MARKET 제거, WEB_SOURCES 추가, GitHub/NPM 신규 항목 추가
 */

const path = require('path');
const os   = require('os');
const { selectLLMChain } = require('../../../../packages/core/lib/llm-model-selector');
const sharedConfig = require('../config');

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
  //
  // ★★★ 현재 활성 (10개)
  // ★★  검토 후 추가 권장 — 하단 CANDIDATE_SOURCES 주석 참조
  //
  WEB_SOURCES: [
    // ── 공식 AI 기업 블로그 ──────────────────────────────────────
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
      id:     'google-research',
      label:  'Google Research 블로그',
      type:   'rss',
      url:    'https://research.google/blog/rss/',
    },
    // ── arXiv 논문 (3채널) ───────────────────────────────────────
    {
      id:     'arxiv-cs-ai',
      label:  'arXiv CS.AI',
      type:   'rss',
      url:    'https://rss.arxiv.org/rss/cs.AI',
    },
    {
      id:     'arxiv-cs-lg',
      label:  'arXiv CS.LG (머신러닝)',
      type:   'rss',
      url:    'https://rss.arxiv.org/rss/cs.LG',
    },
    {
      id:     'arxiv-cs-cl',
      label:  'arXiv CS.CL (NLP/LLM)',
      type:   'rss',
      url:    'https://rss.arxiv.org/rss/cs.CL',
    },
    // ── 주간 뉴스레터 (월요일 봇과 타이밍 최적) ──────────────────
    {
      id:     'last-week-in-ai',
      label:  'Last Week in AI',
      type:   'rss',
      url:    'https://lastweekin.ai/feed',
    },
    {
      id:     'interconnects-ai',
      label:  'Interconnects AI (Nathan Lambert)',
      type:   'rss',
      url:    'https://www.interconnects.ai/feed',
    },
    {
      id:     'import-ai',
      label:  'Import AI (Jack Clark)',
      type:   'rss',
      url:    'https://jack-clark.net/feed/',
    },
    // ── 테크 미디어 ──────────────────────────────────────────────
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

  // ─── 추가 후보 소스 (클로드 검토 의견) ──────────────────────────
  //
  // 아래 소스들은 검증됐으나 현재 미포함. 필요 시 WEB_SOURCES에 추가.
  //
  // ★★ 추천 (실용성 높음)
  //   - VentureBeat AI        : https://venturebeat.com/category/ai/feed/
  //                             → 스타트업 펀딩·LLM 출시 속보. 노이즈 많지만 산업 동향 빠름.
  //                             → MIT TR이 있으면 중복 가능성 있어 현재 제외.
  //
  //   - Lil'Log (Lilian Weng) : https://lilianweng.github.io/index.xml
  //                             → OpenAI 연구원. 에이전트·정렬·추론 심층 기술 리뷰.
  //                             → 업데이트 월 0~1회로 드물지만 나오면 반드시 읽을 가치.
  //                             → 추가 권장 — 저빈도라 컨텍스트 부담 없음.
  //
  //   - AI News (smol.ai)     : https://buttondown.com/ainews/rss
  //                             → Reddit·Discord·Twitter AI 커뮤니티 동향 일간 집계.
  //                             → 커뮤니티 반응 온도 파악에 유용. 단, 매일 발행이라 양 많음.
  //
  // ★ 참고 (상황에 따라)
  //   - HN AI 필터            : https://hnrss.org/newest?q=LLM+AI&points=50
  //                             → HN 점수 50+ AI 게시물. 커뮤니티 화제 파악용.
  //                             → Simon Willison이 HN 링크를 이미 많이 커버해 중복 가능성.
  //
  //   - The Gradient          : https://thegradient.pub/rss/
  //                             → AI 철학·안전·정렬 심층 분석. 월 2~4회.
  //                             → 실무 적용보다 연구/철학 성격 강함.
  //
  //   - Sebastian Raschka     : https://sebastianraschka.com/rss_feed.xml
  //                             → LLM 아키텍처·PyTorch 실습. 주 1~2회.
  //                             → 구현 수준 튜토리얼 필요 시 추가.
  //
  // ⛔ RSS 없음 (수집 불가)
  //   - Anthropic 공식 뉴스, Google DeepMind, Mistral AI, Cohere

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

  // ─── Archer LLM 체인 ────────────────────────────────────────────
  // 문서 기준 아처는 Claude Sonnet 급 분석 품질을 우선한다.
  // 따라서 primary는 Anthropic, 비용/가용성 fallback은 OpenAI → Groq 순으로 둔다.
  LLM_CHAIN: selectLLMChain('claude.archer.tech_analysis', {
    policyOverride: sharedConfig.RUNTIME?.llmSelectorOverrides?.['claude.archer.tech_analysis'],
  }),

  // 하위 호환성 유지 — 기존 참조가 있더라도 OpenAI fallback 설정값은 계속 노출
  OPENAI: {
    model:       'gpt-4o-mini',
    maxTokens:   4096,
    temperature: 0.3,
  },

  // ─── 시크릿 파일 경로 (github_token 등) ─────────────────────────
  SECRETS_PATHS: [
    path.join(ROOT, 'bots', 'claude', 'secrets.json'),
    path.join(HOME, '.openclaw', 'secrets.json'),
  ],

};
