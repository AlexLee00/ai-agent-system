'use strict';

/**
 * packages/core/lib/health-state-manager.js — 전 팀 공통 헬스 상태 관리자
 *
 * 역할:
 *   - 팀별 launchd 서비스 헬스 상태를 단일 JSON 파일로 관리
 *   - 중복 알림 방지 (ALERT_COOLDOWN_MS)
 *   - 상태 키 형식: {type}:{label}:{code}
 *       예) exitcode:ai.ska.kiosk-monitor:1
 *           down:ai.ska.naver-monitor
 *           unloaded:ai.claude.dexter.quick
 *
 * 사용:
 *   const hsm = require('../../../packages/core/lib/health-state-manager');
 *   const state = hsm.loadState();
 *   if (hsm.canAlert(state, 'exitcode:ai.ska.kiosk-monitor:1')) { ... }
 *   hsm.recordAlert(state, 'exitcode:ai.ska.kiosk-monitor:1');
 *   hsm.saveState(state);
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STATE_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'health-check-state.json');

// 중복 알림 방지 간격 (30분)
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// ─── 팀별 서비스 레이블 패턴 ────────────────────────────────────────
// 각 팀이 자신의 서비스를 등록하면 됨
const TEAM_PREFIXES = {
  ska:    'ai.ska.',
  claude: 'ai.claude.',
  luna:   'ai.investment.',
  blog:   'ai.blog.',
  worker: 'ai.worker.',
};

// 개발/점검 서비스 — exit 1 알림에 [점검] 태그 부착
// 이 서비스들은 에러 발견 시 exit 1이 정상 동작
// 개발/점검 서비스 — exit 1이 정상 동작인 서비스 (에러 발견 시 exit 1로 종료)
// commander 등 상시 실행 서비스는 포함하지 않음
const DEV_SERVICES = new Set([
  'ai.claude.dexter.quick',
  'ai.claude.dexter.full',
  'ai.claude.dexter',
  'ai.claude.dexter.daily',
  'ai.claude.archer',
  'ai.claude.health-dashboard',
  'ai.claude.health-check',
  'ai.ska.health-check',
  'ai.investment.health-check',
  'ai.blog.health-check',
  'ai.worker.health-check',
]);

// ─── 상태 파일 I/O ───────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    // workspace 디렉토리 없으면 생성
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error(`[health-state-manager] 상태 저장 실패: ${e.message}`);
    return false;
  }
}

// ─── 알림 쿨다운 ─────────────────────────────────────────────────

/**
 * 해당 키에 대한 알림을 지금 보낼 수 있는지 확인
 * @param {object} state  - loadState() 반환값
 * @param {string} key    - 상태 키
 * @returns {boolean}
 */
function canAlert(state, key) {
  const last = state[key];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > ALERT_COOLDOWN_MS;
}

/**
 * 알림 발송 시각 기록
 * @param {object} state
 * @param {string} key
 */
function recordAlert(state, key) {
  state[key] = new Date().toISOString();
}

/**
 * 회복 시 상태 키 삭제
 * @param {object} state
 * @param {string} key  - 정확한 키 또는 패턴 접두사
 * @param {boolean} prefix - true면 key로 시작하는 모든 키 삭제
 */
function clearAlert(state, key, prefix = false) {
  if (prefix) {
    Object.keys(state).filter(k => k.startsWith(key)).forEach(k => delete state[k]);
  } else {
    delete state[key];
  }
}

// ─── 유틸 ────────────────────────────────────────────────────────

/**
 * 서비스 레이블로 팀 식별
 * @param {string} label  - 'ai.ska.kiosk-monitor' 등
 * @returns {string|null}
 */
function getTeam(label) {
  for (const [team, prefix] of Object.entries(TEAM_PREFIXES)) {
    if (label.startsWith(prefix)) return team;
  }
  return null;
}

/**
 * 서비스가 개발/점검 서비스인지 확인
 * @param {string} label
 * @returns {boolean}
 */
function isDevService(label) {
  return DEV_SERVICES.has(label);
}

/**
 * 알림 메시지에 붙일 태그 반환
 * @param {string} label
 * @returns {string}  - '[점검] ' or ''
 */
function getAlertTag(label) {
  return isDevService(label) ? '[점검] ' : '';
}

/**
 * 서비스의 alert_level 반환
 * [점검] 서비스는 MEDIUM(2), 일반 서비스는 HIGH(3)
 * @param {string} label
 * @returns {number}  - 2 or 3
 */
function getAlertLevel(label) {
  return isDevService(label) ? 2 : 3;
}

/**
 * exitcode:*:N 형식 키에서 레이블 추출
 * @param {string} key  - 'exitcode:ai.ska.kiosk-monitor:1'
 * @returns {string}
 */
function parseLabelFromKey(key) {
  // 형식: {type}:{label}:{code} 또는 {type}:{label}
  const parts = key.split(':');
  if (parts.length < 2) return key;
  // 타입(parts[0])과 끝 부분(숫자 코드)을 제외한 나머지가 label
  // exitcode:ai.ska.kiosk-monitor:1 → 'ai.ska.kiosk-monitor'
  // down:ai.ska.naver-monitor → 'ai.ska.naver-monitor'
  const isExitCode = parts[0] === 'exitcode' && /^\d+$/.test(parts[parts.length - 1]);
  return isExitCode
    ? parts.slice(1, -1).join(':')
    : parts.slice(1).join(':');
}

/**
 * 서비스 레이블의 짧은 이름 반환
 * @param {string} label  - 'ai.ska.kiosk-monitor'
 * @returns {string}       - 'kiosk-monitor'
 */
function shortLabel(label) {
  return label.replace(/^ai\.[a-z-]+\./, '');
}

module.exports = {
  // 상태 파일
  STATE_FILE,
  loadState,
  saveState,
  // 알림 관리
  canAlert,
  recordAlert,
  clearAlert,
  ALERT_COOLDOWN_MS,
  // 유틸
  getTeam,
  isDevService,
  getAlertTag,
  getAlertLevel,
  parseLabelFromKey,
  shortLabel,
  TEAM_PREFIXES,
  DEV_SERVICES,
};
