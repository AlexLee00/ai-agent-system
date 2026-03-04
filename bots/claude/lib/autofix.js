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

// ── 봇 이름 (변경 시 이 상수만 수정)
const BOT_NAME = '덱스터';

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

  const mismatch = codeSection.items.filter(
    i => i.status === 'warn' && i.label !== '체크섬' && i.label !== 'git 상태' && !i.label.includes('문법')
  );
  if (mismatch.length === 0) return;

  // git diff로 해당 파일이 실제 변경됐는지 확인
  try {
    const gitDiff = execSync('git -C "' + cfg.ROOT + '" diff --name-only HEAD', { encoding: 'utf8', timeout: 5000 });
    const changedFiles = gitDiff.split('\n').map(f => f.trim()).filter(Boolean);

    // 체크섬 불일치 파일 중 git에서 변경된 파일 → 의도적 수정으로 간주, 자동 갱신
    const toUpdate = mismatch.filter(i => changedFiles.some(f => i.label.includes(path.basename(f))));
    if (toUpdate.length === 0) return;

    const { updateChecksums } = require('./checks/code');
    const result = updateChecksums();
    fixes.push({
      label:  `체크섬 자동 갱신`,
      status: 'ok',
      detail: `git 변경 파일 ${toUpdate.length}개 → ${result.updated}개 갱신`,
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

module.exports = { run };
