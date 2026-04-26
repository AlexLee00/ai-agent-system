// @ts-nocheck
'use strict';

/**
 * lib/dexter-mode.js — 덱스터 이중 모드 관리
 *
 * Normal 모드 (기본):
 *   → 기존과 동일하게 덱스터가 점검하고 텔레그램으로 직접 보고
 *
 * Emergency 모드 진입 조건:
 *   1. 인프라 기반: 스카야 3분 이상 다운
 *   2. Phase 2: 클로드(팀장) 10분 무응답 → 자동 전환
 *
 * Emergency 모드 동작:
 *   → 텔레그램 대신 콘솔 로그 + 로컬 파일 기록
 *   → Groq LLM 임시 판단 대행 ("응급 처치만, 수술은 안 함")
 *   → 복구 시 밀린 알림 일괄 반환 (caller가 telegram으로 발송)
 *
 * 상태 파일: AI_AGENT_WORKSPACE/dexter-mode-state.json  (run 간 지속)
 * 비상 로그: AI_AGENT_WORKSPACE/dexter-emergency.log
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const https = require('https');
const runtimePaths = require('./runtime-paths.js');

const MODES = {
  NORMAL:    'normal',
  EMERGENCY: 'emergency',
};

// Emergency 진입 임계: 보고 채널 다운 분(分)
const EMERGENCY_THRESHOLD_MIN = 3;

// Phase 2: 클로드(팀장) 무응답 임계 (90분 — full 체크 1h + 여유 30분)
// dexter-quickcheck.js는 pollAgentEvents 미포함 → full 체크(1h)만 갱신
const TEAM_LEAD_TIMEOUT_MS = 90 * 60 * 1000;

const STATE_FILE     = runtimePaths.workspacePath('dexter-mode-state.json');
const EMERGENCY_LOG  = runtimePaths.workspacePath('dexter-emergency.log');

// 기본 상태 구조
function defaultState() {
  return {
    mode:                  MODES.NORMAL,
    emergencySince:        null,
    criticalDown:          {},       // { serviceName: firstDownIsoStr }
    bufferedAlerts:        [],       // { ts, message } — Emergency 중 밀린 알림
    lastClaudeLeadActivity: null,    // Phase 2: 팀장 마지막 응답 ISO 시각
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

  // ── Phase 2: 클로드(팀장) 활동 추적 ────────────────────────────

  /**
   * 클로드(팀장) 활동 시각 갱신 — claude-lead-brain.js에서 호출
   */
  updateClaudeLeadActivity() {
    try {
      this.state.lastClaudeLeadActivity = new Date().toISOString();
      this._saveState();
    } catch { /* 저장 실패 무시 */ }
  }

  /**
   * 클로드(팀장) 무응답 여부 확인
   * @returns {boolean}
   */
  isClaudeLeadUnresponsive() {
    try {
      const last = this.state.lastClaudeLeadActivity;
      if (!last) return false;  // 아직 활동 기록 없음 → 비상 아님 (초기화 기간)
      return (Date.now() - new Date(last).getTime()) > TEAM_LEAD_TIMEOUT_MS;
    } catch { return false; }
  }

  /**
   * Phase 2: 팀장 무응답 여부 기반 Emergency 진입 체크
   * dexter.js 점검 완료 후 checkModeTransition 바로 다음에 호출
   */
  checkEmergencyCondition() {
    try {
      if (!this.isClaudeLeadUnresponsive()) return;
      if (this.state.mode === MODES.EMERGENCY) return;  // 이미 비상 모드
      const last    = this.state.lastClaudeLeadActivity;
      const minAgo  = last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : 0;
      this.enterEmergency(`클로드(팀장) ${minAgo}분 무응답`);
    } catch (e) {
      console.warn('[dexter-mode] checkEmergencyCondition 실패 (무시):', e.message);
    }
  }

  /**
   * Phase 2: DB(team-bus agent_state) 기반 클로드(팀장) 마지막 활동 조회
   * 파일 기반 체크의 DB 보완 확인 — 비동기
   * @returns {Promise<{updatedAt: string|null, status?: string|null, isStale: boolean}|null>}
   */
  async checkClaudeLeadDbStatus() {
    try {
      const teamBus = require('./team-bus');
      const st = await teamBus.getStatus('claude-lead');
      if (!st || !st.updated_at) return null;
      const updatedAt = new Date(st.updated_at.replace(' ', 'T'));
      const isStale   = (Date.now() - updatedAt.getTime()) > TEAM_LEAD_TIMEOUT_MS;
      return { updatedAt: st.updated_at, status: st.status, isStale };
    } catch { return null; }
  }

  /**
   * Emergency 중 Groq Scout LLM에 응급 판단 의뢰
   * ("응급 처치만, 수술은 안 함" — monitor/restart/escalate만 결정)
   *
   * @param {string} issueDescription  이슈 설명
   * @returns {Promise<{action: string, reasoning: string}>}
   */
  async emergencyJudgment(issueDescription) {
    // Groq 키 로드 (config.yaml → 환경변수 폴백)
    let groqKey = null;
    try {
      const { getGroqAccounts } = require('../../../packages/core/lib/llm-keys');
      const accounts = getGroqAccounts();
      if (accounts.length > 0) {
        const acct = accounts[0];
        groqKey = (typeof acct === 'string') ? acct : (acct.api_key || acct.key || null);
      }
    } catch { /* llm-keys 없으면 env fallback */ }
    if (!groqKey) groqKey = process.env.GROQ_API_KEY;

    if (!groqKey) {
      const result = { action: 'monitor', reasoning: 'Groq 키 없음 — 기본 monitor 유지' };
      this._appendEmergencyLog(`[GROQ 판단 실패] 키 없음 → ${result.action}`);
      return result;
    }

    const body = JSON.stringify({
      model:       'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens:  120,
      temperature: 0.1,
      messages: [
        {
          role:    'system',
          content: '비상 시스템 대응 전문가. 이슈에 대해 응급 판단만 하세요. 반드시 JSON만 응답: {"action":"monitor|restart|escalate","reasoning":"한국어 1문장"}',
        },
        { role: 'user', content: `이슈: ${issueDescription}` },
      ],
    });

    return new Promise(resolve => {
      const fallback = reason => {
        const result = { action: 'monitor', reasoning: reason };
        this._appendEmergencyLog(`[GROQ 판단 실패] ${reason} → monitor`);
        resolve(result);
      };

      const options = {
        hostname: 'api.groq.com',
        path:     '/openai/v1/chat/completions',
        method:   'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const resp = JSON.parse(data);
            const raw  = resp.choices?.[0]?.message?.content?.trim() || '';
            const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
            const result = JSON.parse(json);
            if (!['monitor', 'restart', 'escalate'].includes(result.action)) throw new Error('invalid action');
            this._appendEmergencyLog(`[GROQ 판단] ${result.action} — ${result.reasoning}`);
            resolve(result);
          } catch {
            fallback('Groq 응답 파싱 실패');
          }
        });
      });

      req.on('error', () => fallback('Groq 호출 오류'));
      req.setTimeout(8000, () => { req.destroy(); fallback('Groq 타임아웃'); });
      req.write(body);
      req.end();
    });
  }

  // ── 다운타임 추적 ───────────────────────────────────────────────

  _updateServiceDown(name, isDown) {
    try {
      const now = new Date().toISOString();
      if (isDown) {
        if (!this.state.criticalDown[name]) {
          this.state.criticalDown[name] = now;  // 첫 감지 시각 기록
        }
      } else {
        delete this.state.criticalDown[name];
      }
    } catch (e) {
      console.warn('[dexter-mode] _updateServiceDown 실패 (무시):', e.message);
    }
  }

  _minutesDown(name) {
    try {
      const since = this.state.criticalDown[name];
      if (!since) return 0;
      return (Date.now() - new Date(since).getTime()) / 60000;
    } catch { return 0; }
  }

  // ── 모드 전환 판단 ─────────────────────────────────────────────

  /**
   * 점검 결과 기반 Emergency 모드 전환 판단
   * dexter.js / dexter-quickcheck.js 점검 완료 후 호출
   *
   * @param {boolean} skayaOk      스카야(tmux:ska) 정상 여부
   * @returns {{ flushed: object[] }}  Emergency 해제 시 밀린 알림 배열
   */
  checkModeTransition(skayaOk = true) {
    try {
      this._updateServiceDown('skaya',    !skayaOk);

      const skayaDownMin    = this._minutesDown('skaya');
      const shouldEmergency = skayaDownMin > EMERGENCY_THRESHOLD_MIN;

      let flushed = [];

      if (shouldEmergency && this.state.mode === MODES.NORMAL) {
        const reason = `스카야 텔레그램 봇 ${Math.round(skayaDownMin)}분 다운`;
        this.enterEmergency(reason);
      } else if (!shouldEmergency && !this.isClaudeLeadUnresponsive() && this.state.mode === MODES.EMERGENCY) {
        // 인프라 복구 + 팀장 응답 정상 → Normal 복귀
        flushed = this.exitEmergency();
      }

      this._saveState();
      return { flushed };
    } catch (e) {
      console.warn('[dexter-mode] checkModeTransition 실패 (무시):', e.message);
      return { flushed: [] };
    }
  }

  // ── 모드 진입/해제 ──────────────────────────────────────────────

  enterEmergency(reason = '보고 채널 다운') {
    try {
      if (this.state.mode === MODES.EMERGENCY) return;
      this.state.mode           = MODES.EMERGENCY;
      this.state.emergencySince = new Date().toISOString();

      const msg = `🚨 덱스터 비상 모드 전환 — ${reason}. 텔레그램 대신 로컬 파일에 기록합니다.`;
      console.warn(`⚠️ ${msg}`);
      this._appendEmergencyLog(`[비상 모드 진입] ${reason}`);
      this._saveState();
    } catch (e) {
      console.warn('[dexter-mode] enterEmergency 실패 (무시):', e.message);
    }
  }

  /**
   * Emergency 해제 → Normal 복귀
   * @returns {object[]} 밀린 알림 배열 — caller가 telegram으로 발송
   */
  exitEmergency() {
    try {
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
    } catch (e) {
      console.warn('[dexter-mode] exitEmergency 실패 (무시):', e.message);
      return [];
    }
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
    try {
      if (this.state.mode !== MODES.EMERGENCY) return false;
      this.state.bufferedAlerts.push({ ts: new Date().toISOString(), message });
      this._appendEmergencyLog(`[BUFFERED] ${message}`);
      this._saveState();
      return true;
    } catch (e) {
      console.warn('[dexter-mode] bufferAlert 실패 (무시):', e.message);
      return false;
    }
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
    try {
      return {
        mode:             this.state.mode,
        isEmergency:      this.isEmergency(),
        emergencySince:   this.state.emergencySince,
        durationMin:      this.state.emergencySince
          ? Math.round((Date.now() - new Date(this.state.emergencySince).getTime()) / 60000)
          : 0,
        criticalDown:     { ...this.state.criticalDown },
        bufferedAlertCount: (this.state.bufferedAlerts || []).length,
        lastClaudeLeadActivity: this.state.lastClaudeLeadActivity,
      };
    } catch (e) {
      console.warn('[dexter-mode] getStatus 실패 (무시):', e.message);
      return { mode: MODES.NORMAL, isEmergency: false, durationMin: 0, criticalDown: {}, bufferedAlertCount: 0 };
    }
  }
}

module.exports = { DexterMode, MODES };
