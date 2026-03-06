'use strict';

/**
 * lib/dexter-mode.js — 덱스터 이중 모드 관리
 *
 * Normal 모드 (기본):
 *   → 기존과 동일하게 덱스터가 점검하고 텔레그램으로 직접 보고
 *
 * Emergency 모드 진입 조건 (현재 인프라 기반):
 *   → OpenClaw 게이트웨이 다운 + EMERGENCY_THRESHOLD_MIN 이상 미복구
 *   → 또는 스카야(tmux:ska) 텔레그램 봇 다운 + EMERGENCY_THRESHOLD_MIN 이상 미복구
 *   → 즉, "보고 채널 자체가 죽었을 때"
 *
 * Emergency 모드 동작:
 *   → 텔레그램 대신 콘솔 로그 + 로컬 파일 기록
 *   → 복구 시 밀린 알림 일괄 반환 (caller가 telegram으로 발송)
 *
 * TODO: 클로드(팀장) 구축(5주차) 후 → 팀장 무응답 기반 Emergency 전환
 * TODO: Emergency 시 Groq LLM으로 임시 판단 대행 (LLM 폴백: Groq → Gemini → Ollama)
 *
 * 상태 파일: ~/.openclaw/workspace/dexter-mode-state.json  (run 간 지속)
 * 비상 로그: ~/.openclaw/workspace/dexter-emergency.log
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const MODES = {
  NORMAL:    'normal',
  EMERGENCY: 'emergency',
};

// Emergency 진입 임계: 보고 채널 다운 분(分)
const EMERGENCY_THRESHOLD_MIN = 3;

const STATE_FILE     = path.join(os.homedir(), '.openclaw', 'workspace', 'dexter-mode-state.json');
const EMERGENCY_LOG  = path.join(os.homedir(), '.openclaw', 'workspace', 'dexter-emergency.log');

// 기본 상태 구조
function defaultState() {
  return {
    mode:           MODES.NORMAL,
    emergencySince: null,
    criticalDown:   {},       // { serviceName: firstDownIsoStr }
    bufferedAlerts: [],       // { ts, message } — Emergency 중 밀린 알림
  };
}

class DexterMode {
  constructor() {
    this.state = this._loadState();
  }

  // ── 상태 파일 I/O ───────────────────────────────────────────────

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        return { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
      }
    } catch { /* 손상 시 기본값 */ }
    return defaultState();
  }

  _saveState() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch { /* 저장 실패 무시 */ }
  }

  _appendEmergencyLog(message) {
    try {
      const dir = path.dirname(EMERGENCY_LOG);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(EMERGENCY_LOG, `[${new Date().toISOString()}] ${message}\n`);
    } catch { /* 파일 쓰기 실패 무시 */ }
  }

  // ── 다운타임 추적 ───────────────────────────────────────────────

  _updateServiceDown(name, isDown) {
    const now = new Date().toISOString();
    if (isDown) {
      if (!this.state.criticalDown[name]) {
        this.state.criticalDown[name] = now;  // 첫 감지 시각 기록
      }
    } else {
      delete this.state.criticalDown[name];
    }
  }

  _minutesDown(name) {
    const since = this.state.criticalDown[name];
    if (!since) return 0;
    return (Date.now() - new Date(since).getTime()) / 60000;
  }

  // ── 모드 전환 판단 ─────────────────────────────────────────────

  /**
   * 점검 결과 기반 Emergency 모드 전환 판단
   * dexter.js / dexter-quickcheck.js 점검 완료 후 호출
   *
   * @param {boolean} openclawOk   OpenClaw 게이트웨이 정상 여부
   * @param {boolean} skayaOk      스카야(tmux:ska) 정상 여부
   * @returns {{ flushed: object[] }}  Emergency 해제 시 밀린 알림 배열
   */
  checkModeTransition(openclawOk, skayaOk = true) {
    this._updateServiceDown('openclaw', !openclawOk);
    this._updateServiceDown('skaya',    !skayaOk);

    const openclawDownMin = this._minutesDown('openclaw');
    const skayaDownMin    = this._minutesDown('skaya');
    const shouldEmergency = openclawDownMin > EMERGENCY_THRESHOLD_MIN ||
                            skayaDownMin    > EMERGENCY_THRESHOLD_MIN;

    let flushed = [];

    if (shouldEmergency && this.state.mode === MODES.NORMAL) {
      const reason = openclawDownMin > EMERGENCY_THRESHOLD_MIN
        ? `OpenClaw 게이트웨이 ${Math.round(openclawDownMin)}분 다운`
        : `스카야 텔레그램 봇 ${Math.round(skayaDownMin)}분 다운`;
      this.enterEmergency(reason);
    } else if (!shouldEmergency && this.state.mode === MODES.EMERGENCY) {
      flushed = this.exitEmergency();
    }

    this._saveState();
    return { flushed };
  }

  // ── 모드 진입/해제 ──────────────────────────────────────────────

  enterEmergency(reason = '보고 채널 다운') {
    if (this.state.mode === MODES.EMERGENCY) return;
    this.state.mode           = MODES.EMERGENCY;
    this.state.emergencySince = new Date().toISOString();

    const msg = `🚨 덱스터 비상 모드 전환 — ${reason}. 텔레그램 대신 로컬 파일에 기록합니다.`;
    console.warn(`⚠️ ${msg}`);
    this._appendEmergencyLog(`[비상 모드 진입] ${reason}`);
    this._saveState();
  }

  /**
   * Emergency 해제 → Normal 복귀
   * @returns {object[]} 밀린 알림 배열 — caller가 telegram으로 발송
   */
  exitEmergency() {
    if (this.state.mode === MODES.NORMAL) return [];

    const since = this.state.emergencySince;
    const durationMin = since
      ? Math.round((Date.now() - new Date(since).getTime()) / 60000)
      : 0;
    const buffered = [...(this.state.bufferedAlerts || [])];

    this.state.mode           = MODES.NORMAL;
    this.state.emergencySince = null;
    this.state.bufferedAlerts = [];

    const msg = `✅ 덱스터 기본 모드 복귀 (비상 지속: ${durationMin}분, 밀린 알림: ${buffered.length}건)`;
    console.log(msg);
    this._appendEmergencyLog(`[비상 모드 해제] 지속: ${durationMin}분, 밀린 알림: ${buffered.length}건`);
    this._saveState();

    return buffered;
  }

  // ── Emergency 중 알림 버퍼링 ───────────────────────────────────

  /**
   * Emergency 모드일 때 알림을 버퍼에 저장 + 로컬 파일 기록
   * Normal 모드일 때는 false를 반환 (caller가 직접 telegram 발송)
   *
   * @param {string} message  알림 내용
   * @returns {boolean}  true: 버퍼에 저장됨, false: 버퍼 안 함 (직접 발송 필요)
   */
  bufferAlert(message) {
    if (this.state.mode !== MODES.EMERGENCY) return false;
    this.state.bufferedAlerts.push({ ts: new Date().toISOString(), message });
    this._appendEmergencyLog(`[BUFFERED] ${message}`);
    this._saveState();
    return true;
  }

  /**
   * 밀린 알림 조회 후 초기화
   * @returns {object[]}
   */
  flushBufferedAlerts() {
    const alerts = [...(this.state.bufferedAlerts || [])];
    this.state.bufferedAlerts = [];
    this._saveState();
    return alerts;
  }

  // ── 상태 조회 ─────────────────────────────────────────────────

  isEmergency() {
    return this.state.mode === MODES.EMERGENCY;
  }

  get currentMode() {
    return this.state.mode;
  }

  getStatus() {
    return {
      mode:             this.state.mode,
      isEmergency:      this.isEmergency(),
      emergencySince:   this.state.emergencySince,
      durationMin:      this.state.emergencySince
        ? Math.round((Date.now() - new Date(this.state.emergencySince).getTime()) / 60000)
        : 0,
      criticalDown:     { ...this.state.criticalDown },
      bufferedAlertCount: (this.state.bufferedAlerts || []).length,
    };
  }
}

module.exports = { DexterMode, MODES };
