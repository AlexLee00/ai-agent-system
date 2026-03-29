'use strict';
/**
 * packages/core/lib/env.js — 팀 제이 공용 환경 계층
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  경로 + 환경(ops/dev) + PAPER_MODE를 단일 모듈에서 제공             │
 * │                                                                     │
 * │  대체 대상:                                                          │
 * │    packages/core/lib/mode-guard.js  → 이 모듈로 통합               │
 * │    bots/reservation/lib/mode.js     → 이 모듈로 통합               │
 * │    /Users/alexlee/... 하드코딩     → PROJECT_ROOT 로 대체           │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 사용법:
 *   const env = require('../../../packages/core/lib/env');
 *
 *   // 경로
 *   const db = require(env.corePath('pg-pool'));
 *   const cfg = env.projectPath('bots/investment/config.yaml');
 *
 *   // 환경 분기
 *   if (env.IS_OPS) { ... }
 *   await env.runIfOps('주문 실행', () => placeOrder(), () => console.log('dry-run'));
 *
 *   // 보호 가드
 *   env.ensureOps('실투자 주문');   // dev에서 호출 시 throw
 *   env.ensureDev('실험 코드');     // ops에서 호출 시 throw
 *
 *   // 모드 접미사 (파일 분리)
 *   const lockFile = `/tmp/ska${env.modeSuffix()}.lock`;  // '' | '-dev'
 *
 * 환경변수 우선순위:
 *   PROJECT_ROOT > ~/projects/ai-agent-system
 *   MODE         > 'dev'          ('ops' | 'dev')
 *   PAPER_MODE   > 'true'         ('true' | 'false')
 *   NODE_ENV     > 'development'  ('production' | 'development' | 'test')
 */

const path = require('path');
const os   = require('os');

// ─── 경로 ────────────────────────────────────────────────────────────────

/**
 * 프로젝트 루트 절대경로.
 * 환경변수 PROJECT_ROOT 없으면 ~/projects/ai-agent-system
 */
const PROJECT_ROOT = process.env.PROJECT_ROOT ||
  path.join(os.homedir(), 'projects', 'ai-agent-system');

/**
 * 프로젝트 루트 기준 경로 결합
 * @param {...string} segments
 * @returns {string}
 * @example env.projectPath('bots/investment/config.yaml')
 */
function projectPath(...segments) {
  return path.join(PROJECT_ROOT, ...segments);
}

/**
 * packages/core/lib/ 기준 모듈 경로 결합
 * @param {string} moduleName  (확장자 없어도 됨)
 * @returns {string}
 * @example env.corePath('pg-pool')  →  '/Users/.../packages/core/lib/pg-pool.js'
 */
function corePath(moduleName) {
  return path.join(PROJECT_ROOT, 'packages', 'core', 'lib', moduleName);
}

// ─── 환경 ────────────────────────────────────────────────────────────────

const _raw_mode = (process.env.MODE || 'dev').toLowerCase().trim();
const _valid_modes = ['ops', 'dev'];
if (!_valid_modes.includes(_raw_mode)) {
  console.warn(`[env] ⚠️ 알 수 없는 MODE: "${_raw_mode}" — dev 로 처리`);
}

/** 현재 실행 모드 ('ops' | 'dev') */
const MODE = _valid_modes.includes(_raw_mode) ? _raw_mode : 'dev';

/** 운영 환경 여부 (MODE=ops) */
const IS_OPS = MODE === 'ops';

/** 개발 환경 여부 (MODE=dev) */
const IS_DEV = MODE === 'dev';

/** 페이퍼 트레이딩 여부 (PAPER_MODE=true 이거나 IS_DEV) */
const PAPER_MODE = process.env.PAPER_MODE !== 'false' || IS_DEV;

/** Node.js 환경 ('production' | 'development' | 'test') */
const NODE_ENV = process.env.NODE_ENV || (IS_OPS ? 'production' : 'development');

// ─── 서비스 접근 주소 ─────────────────────────────────────────────────────

const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://127.0.0.1:5678';

const N8N_ENABLED = IS_OPS
  ? (process.env.N8N_ENABLED !== 'false')
  : (process.env.N8N_ENABLED === 'true');

const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = parseInt(process.env.PG_PORT || '5432', 10);

const LAUNCHD_AVAILABLE = IS_OPS
  ? (process.env.LAUNCHD_AVAILABLE !== 'false')
  : (process.env.LAUNCHD_AVAILABLE === 'true');

const OPENCLAW_PORT = IS_OPS
  ? parseInt(process.env.OPENCLAW_PORT || '18789', 10)
  : -1;

const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE ||
  path.join(os.homedir(), '.openclaw', 'workspace');

const OPENCLAW_LOGS = process.env.OPENCLAW_LOGS ||
  path.join(os.homedir(), '.openclaw', 'logs');

// ─── Resource API Hub ────────────────────────────────────────────────

const HUB_BASE_URL = IS_DEV
  ? (process.env.HUB_BASE_URL || 'http://localhost:7788')
  : null;

const USE_HUB = IS_DEV && !!HUB_BASE_URL;

const HUB_AUTH_TOKEN = process.env.HUB_AUTH_TOKEN || '';

/** 시크릿 Hub 경로 사용 여부 (자동배포 안전성을 위해 기본값은 false) */
const USE_HUB_SECRETS = process.env.USE_HUB_SECRETS === 'true';

const HUB_PORT = parseInt(process.env.HUB_PORT || '7788', 10);

// ─── 모드 보호 ───────────────────────────────────────────────────────────

/**
 * OPS 전용 진입 보호. dev에서 호출 시 throw.
 * @param {string} operation
 * @throws {Error}
 */
function ensureOps(operation) {
  if (!IS_OPS) {
    throw new Error(
      `[env] "${operation}"은 MODE=ops 에서만 실행 가능. ` +
      `현재: MODE=${MODE}. 실서비스 전환은 마스터 승인 후 ops 모드로 기동하세요.`
    );
  }
}

/**
 * DEV 전용 진입 보호. ops에서 호출 시 throw.
 * @param {string} operation
 * @throws {Error}
 */
function ensureDev(operation) {
  if (!IS_DEV) {
    throw new Error(
      `[env] "${operation}"은 MODE=dev 에서만 실행 가능. ` +
      `현재: MODE=${MODE}. 실험 코드가 ops 환경에서 실행되는 것을 차단합니다.`
    );
  }
}

/**
 * OPS에서만 실행, DEV에서는 dry-run 로그 또는 dryRunFn 실행.
 * @param {string}   operation
 * @param {function} fn         OPS에서 실행할 함수 (async 지원)
 * @param {function} [dryRunFn] DEV 대체 함수 (생략 시 로그만)
 * @returns {Promise<any>}
 */
async function runIfOps(operation, fn, dryRunFn = null) {
  if (IS_OPS) return fn();
  if (dryRunFn) return dryRunFn();
  console.log(`[env] DEV 모드 — "${operation}" dry-run 스킵`);
  return null;
}

/**
 * DEV에서만 실행, OPS에서는 dryRunFn 또는 로그만.
 * @param {string}   operation
 * @param {function} fn
 * @param {function} [dryRunFn]
 */
async function runIfDev(operation, fn, dryRunFn = null) {
  if (IS_DEV) return fn();
  if (dryRunFn) return dryRunFn();
  console.log(`[env] OPS 모드 — "${operation}" 실험 코드 스킵`);
  return null;
}

// ─── 모드 접미사 ─────────────────────────────────────────────────────────

/**
 * 파일 분리용 접미사. OPS: '' / DEV: '-dev'
 * OPS와 DEV가 동시에 실행될 때 lock/status 파일이 충돌하지 않도록.
 * @returns {string}
 * @example `/tmp/ska-status${env.modeSuffix()}.json`
 */
function modeSuffix() {
  return IS_OPS ? '' : '-dev';
}

/**
 * 배너 출력 (프로세스 시작 시)
 * @param {string} [scriptName]
 */
function printModeBanner(scriptName = '') {
  if (IS_OPS) {
    const tag = scriptName ? `   실행: ${scriptName}` : '';
    console.log('');
    console.log('🟢 ============================================');
    console.log('🟢   OPS 모드 — 실서비스 (실제 데이터 접근)');
    console.log('🟢 ============================================');
    if (tag) console.log(tag);
    console.log('🟢 ============================================');
    console.log('');
  } else {
    const tag = scriptName ? ` ${scriptName}` : '';
    console.log(`🧪 [DEV 모드]${tag} — 실계정 변경 없음 (PAPER_MODE=${PAPER_MODE})`);
  }
}

// ─── 내보내기 ────────────────────────────────────────────────────────────

module.exports = {
  // 경로
  PROJECT_ROOT,
  projectPath,
  corePath,

  // 환경
  MODE,
  IS_OPS,
  IS_DEV,
  PAPER_MODE,
  NODE_ENV,

  // 서비스 접근
  N8N_BASE_URL,
  N8N_ENABLED,
  PG_HOST,
  PG_PORT,
  LAUNCHD_AVAILABLE,
  OPENCLAW_PORT,
  OPENCLAW_WORKSPACE,
  OPENCLAW_LOGS,

  // Resource API Hub
  HUB_BASE_URL,
  USE_HUB,
  HUB_AUTH_TOKEN,
  USE_HUB_SECRETS,
  HUB_PORT,

  // 보호 가드
  ensureOps,
  ensureDev,
  runIfOps,
  runIfDev,

  // 유틸
  modeSuffix,
  printModeBanner,
};
