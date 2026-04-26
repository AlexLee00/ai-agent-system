// @ts-nocheck
'use strict';

/**
 * lib/autofix.js — 자동 수정 (단순·안전·가역적 항목만)
 *
 * 자동 수정 가능:
 *   - stale lock 파일 제거 (프로세스 종료 확인 후)
 *   - secrets.json 파일 권한 → 600
 *   - 로그 파일 크기 초과 → 로테이션 (백업 후 비움)
 *
 * 자동 수정 불가 → 버그 레포트 등록:
 *   - DB 무결성 오류
 *   - 하드코딩 키 발견
 *   - npm audit 취약점
 *   - 반복 오류 패턴
 *
 * 체크섬 변경 감지 시:
 *   - git diff로 의도적 변경 확인 후 자동 갱신
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cfg  = require('./config');
const bugReport = require('./bug-report');
const { buildNoticeEvent, renderNoticeEvent } = require('../../../packages/core/lib/reporting-hub');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');

// ── 봇 이름 (변경 시 이 상수만 수정)
const BOT_NAME = '덱스터';

// ── 자동 수정 허용/차단 액션 분류 ────────────────────────────────
const ALLOWED_AUTOFIX_ACTIONS = new Set([
  'stale-lock',       // stale lock 파일 제거
  'secrets-perm',     // secrets.json 권한 600
  'log-rotation',     // 로그 로테이션 (백업 후 비움)
  'checksums-update', // 체크섬 갱신 (git 커밋 변경만)
  'bug-report',       // 버그 레포트 DB 등록
]);

const BLOCKED_AUTOFIX_ACTIONS = new Set([
  'source-modify',    // 소스코드(.js/.ts/.py/.sh) 수정
  'git-commit',       // git commit/push
  'npm-install',      // npm install/uninstall
  'db-schema',        // DB 스키마 변경 (ALTER/DROP)
  'config-modify',    // package.json/CLAUDE.md/secrets.json 수정
]);

/**
 * 차단된 autofix 액션 시도 시 텔레그램 보고
 * @param {string} action - BLOCKED_AUTOFIX_ACTIONS 키
 * @param {string} target - 대상 파일·서비스 설명
 * @param {Array}  fixes  - 결과 배열 (null 가능)
 */
function reportInsteadOfFix(action, target, fixes = null) {
  const msg = `[${BOT_NAME}] 차단된 autofix 시도 — action=${action}, target=${target}`;
  console.error('🚨', msg);
  try {
    const event = buildNoticeEvent({
      from_bot: 'dexter-autofix',
      team: 'claude',
      event_type: 'alert',
      alert_level: 4,
      title: '차단된 autofix 시도',
      summary: msg,
      details: ['마스터 확인 필요'],
      action: '상세 점검: /claude-health',
      payload: {
        title: '차단된 autofix 시도',
        summary: msg,
        details: ['마스터 확인 필요'],
        action: '상세 점검: /claude-health',
      },
    });
    postAlarm({
      message: renderNoticeEvent(event),
      team: 'claude',
      alertLevel: event.alert_level || 4,
      fromBot: 'dexter-autofix',
    }).catch(() => {});
  } catch { /* 텔레그램 발송 실패 무시 */ }
  if (fixes) {
    fixes.push({ label: `차단: ${action}`, status: 'error', detail: target });
  }
}

// stale lock 제거
function fixStaleLock(fixes) {
  for (const [name, lockPath] of Object.entries(cfg.LOCKS)) {
    if (name === 'dexter') continue;
    if (!fs.existsSync(lockPath)) continue;

    const pid = fs.readFileSync(lockPath, 'utf8').trim();
    let alive = false;
    try { process.kill(Number(pid), 0); alive = true; } catch {}

    if (!alive) {
      fs.unlinkSync(lockPath);
      fixes.push({ label: `stale lock 제거 (${name})`, status: 'ok', detail: `PID ${pid} 종료 확인 후 삭제` });
    }
  }
}

// secrets.json 권한 → 600
function fixSecretsPermissions(fixes) {
  const { execSync } = require('child_process');
  for (const [team, p] of Object.entries(cfg.SECRETS)) {
    if (!fs.existsSync(p)) continue;
    const stat = fs.statSync(p);
    const mode = (stat.mode & 0o777).toString(8);
    if (mode !== '600') {
      try {
        execSync(`chmod 600 "${p}"`);
        fixes.push({ label: `secrets 권한 수정 (${team})`, status: 'ok', detail: `${mode} → 600` });
      } catch (e) {
        fixes.push({ label: `secrets 권한 수정 실패 (${team})`, status: 'warn', detail: e.message });
      }
    }
  }
}

// 로그 파일 로테이션
function fixLogRotation(fixes) {
  const logs = [
    { path: cfg.LOGS.naver,  label: '스카 로그' },
    { path: cfg.LOGS.invest, label: '루나 파이프라인 로그' },
    { path: cfg.LOGS.bridge, label: '루나 브릿지 로그' },
  ];

  for (const { path: p, label } of logs) {
    if (!fs.existsSync(p)) continue;
    const mb = fs.statSync(p).size / 1048576;
    if (mb > cfg.THRESHOLDS.logMaxMB) {
      // 백업 후 비움
      const backup = `${p}.bak`;
      try {
        fs.copyFileSync(p, backup);
        fs.writeFileSync(p, '');
        fixes.push({ label: `로그 로테이션 (${label})`, status: 'ok', detail: `${mb.toFixed(1)}MB → 백업: ${backup}` });
      } catch (e) {
        fixes.push({ label: `로그 로테이션 실패 (${label})`, status: 'warn', detail: e.message });
      }
    }
  }
}

// 체크섬 자동 갱신 (git에서 의도적 변경이 감지된 파일)
function fixChecksums(results, fixes) {
  const codeSection = results.find(r => r.name === '코드 무결성');
  if (!codeSection) return;

  const candidates = codeSection.items.filter(
    (i) => i.status === 'warn'
      && i.label !== '체크섬'
      && i.label !== 'git 상태'
      && !i.label.includes('문법')
  );
  if (candidates.length === 0) return;

  const hasSyntaxError = codeSection.items.some(
    (i) => i.status === 'error' && String(i.label || '').startsWith('문법:')
  );
  if (hasSyntaxError) return;

  // git diff로 해당 파일이 실제 변경됐는지 확인
  try {
    const gitDiff = execSync('git -C "' + cfg.ROOT + '" diff --name-only HEAD', { encoding: 'utf8', timeout: 5000 });
    const changedFiles = gitDiff.split('\n').map(f => f.trim()).filter(Boolean);
    const gitStatus = execSync('git -C "' + cfg.ROOT + '" status --porcelain | head -200', { encoding: 'utf8', timeout: 5000, shell: '/bin/zsh' }).trim();
    const isClean = !gitStatus;

    // 1) 워킹트리 clean + 경고만 남은 경우 → 커밋 후 의도적 변경으로 간주
    // 2) 미커밋 상태라도 git diff에 잡힌 체크섬 불일치 파일 → 의도적 수정으로 간주
    const baselineMissing = candidates.filter((i) =>
      String(i.detail || '').includes('체크섬 베이스라인 없음')
    );
    const mismatched = candidates.filter((i) =>
      !String(i.detail || '').includes('체크섬 베이스라인 없음')
    );
    const changedMismatch = mismatched.filter((i) =>
      changedFiles.some((f) => i.label.includes(path.basename(f)))
    );
    const toUpdate = isClean ? candidates : [...baselineMissing, ...changedMismatch];
    if (toUpdate.length === 0) return;

    const { updateChecksums } = require('./checks/code');
    const result = updateChecksums();
    fixes.push({
      label:  `체크섬 자동 갱신`,
      status: 'ok',
      detail: isClean
        ? `git clean + 문법 정상 → ${toUpdate.length}개 항목 기준 ${result.updated}개 갱신`
        : `git 변경 파일 ${toUpdate.length}개 → ${result.updated}개 갱신`,
    });
  } catch { /* git 없으면 무시 */ }
}

// 버그 레포트 등록 대상 판별 + 등록
async function reportBugs(results, fixes) {
  const BUG_TRIGGERS = [
    { section: 'DB 무결성',    pattern: 'error',  title: 'DB 무결성 오류' },
    { section: '코드 무결성',  itemLabel: '체크섬', status: 'warn', title: '핵심 파일 체크섬 변경 감지' },
    { section: '보안',         itemLabel: '하드코딩', status: 'error', title: '하드코딩 API 키 발견' },
    { section: '의존성 보안',  pattern: 'error',  title: 'npm 취약점 (critical/high)' },
    { section: '오류 로그',    itemLabel: '반복 오류', status: 'error', title: '봇 반복 오류 감지' },
  ];

  for (const trigger of BUG_TRIGGERS) {
    const section = results.find(r => r.name === trigger.section);
    if (!section) continue;

    let shouldReport = false;
    let detail       = '';

    if (trigger.pattern) {
      const items = section.items.filter(i => i.status === trigger.pattern);
      if (items.length > 0) {
        shouldReport = true;
        detail = items.map(i => `${i.label}: ${i.detail}`).join(' | ');
      }
    } else if (trigger.itemLabel) {
      const item = section.items.find(i => i.label.includes(trigger.itemLabel) && i.status === trigger.status);
      if (item) {
        shouldReport = true;
        detail = item.detail;
      }
    }

    if (shouldReport) {
      const id = await bugReport.register({
        title:    `[${BOT_NAME}] ${trigger.title}`,
        detail,
        source:   'dexter',
        severity: trigger.pattern === 'error' ? 'high' : 'medium',
      });
      fixes.push({ label: `버그 레포트 등록: ${trigger.title}`, status: 'warn', detail: `ID: ${id}` });
    }
  }
}

async function run(results) {
  const fixes = [];

  fixStaleLock(fixes);
  fixSecretsPermissions(fixes);
  fixLogRotation(fixes);
  fixChecksums(results, fixes);
  await reportBugs(results, fixes);

  return fixes;
}

module.exports = { run, reportInsteadOfFix, ALLOWED_AUTOFIX_ACTIONS, BLOCKED_AUTOFIX_ACTIONS };
