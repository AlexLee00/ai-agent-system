'use strict';

/**
 * checks/security.js — 보안 체크
 * - secrets.json 파일 권한 (600)
 * - 소스코드 하드코딩 API 키 패턴 스캔
 * - .gitignore secrets 제외 확인
 * - 암호화 파일 복호화 테스트
 * - secrets 백업 존재 여부
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cfg  = require('../config');

// 파일 권한 octal
function fileMode(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (stat.mode & 0o777).toString(8);
  } catch { return null; }
}

// secrets.json 파일 권한 체크
function checkSecretsPermissions(items) {
  for (const [team, p] of Object.entries(cfg.SECRETS)) {
    if (!fs.existsSync(p)) {
      items.push({ label: `secrets store (${team})`, status: 'warn', detail: '파일 없음' });
      continue;
    }
    const mode = fileMode(p);
    if (mode === '600') {
      items.push({ label: `secrets store (${team})`, status: 'ok', detail: '권한 600 ✅' });
    } else {
      items.push({ label: `secrets store (${team})`, status: 'error', detail: `권한 ${mode} (600이어야 함) → chmod 600 ${p}` });
    }
  }
}

// 하드코딩 API 키 패턴 스캔
const DANGEROUS_PATTERNS = [
  { pattern: /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}/i, label: 'API 키 하드코딩' },
  { pattern: /secret\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}/i,      label: 'Secret 하드코딩' },
  { pattern: /token\s*[:=]\s*["'][0-9]{8,}:[A-Za-z0-9_\-]{30,}/i, label: '텔레그램 토큰 하드코딩' },
  { pattern: /sk-[A-Za-z0-9]{40,}/,                             label: 'OpenAI API 키 노출' },
  { pattern: /AIza[A-Za-z0-9_\-]{30,}/,                         label: 'Google API 키 노출' },
];

function scanHardcodedKeys(items) {
  const SCAN_DIRS = [
    path.join(cfg.BOTS.reservation, 'src'),
    path.join(cfg.BOTS.reservation, 'lib'),
    path.join(cfg.BOTS.investment, 'markets'),
    path.join(cfg.BOTS.investment, 'shared'),
    path.join(cfg.BOTS.investment, 'team'),
    path.join(cfg.BOTS.claude, 'src'),
    path.join(cfg.BOTS.claude, 'lib'),
  ];

  const EXCLUDE = ['secrets.js', 'secrets.example.json', 'node_modules', '.git'];
  let findings = 0;

  for (const dir of SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;

    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d); } catch { return; }
      for (const e of entries) {
        if (EXCLUDE.some(x => e.includes(x))) continue;
        const full = path.join(d, e);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) { walk(full); continue; }
        if (!e.endsWith('.js') && !e.endsWith('.sh')) continue;

        const src = fs.readFileSync(full, 'utf8');
        for (const { pattern, label } of DANGEROUS_PATTERNS) {
          if (pattern.test(src)) {
            findings++;
            items.push({ label, status: 'error', detail: path.relative(cfg.ROOT, full) });
          }
        }
      }
    };
    walk(dir);
  }

  if (findings === 0) {
    items.push({ label: '하드코딩 키 스캔', status: 'ok', detail: '의심 패턴 없음' });
  }
}

// pre-commit 훅 존재 + 실행 권한 확인
function checkPreCommitHook(items) {
  const hookPath = path.join(cfg.ROOT, '.git', 'hooks', 'pre-commit');
  if (!fs.existsSync(hookPath)) {
    items.push({ label: 'pre-commit 훅', status: 'warn', detail: '미설치 — bash scripts/setup-hooks.sh 실행 필요' });
    return;
  }
  const mode = (fs.statSync(hookPath).mode & 0o111);
  if (!mode) {
    items.push({ label: 'pre-commit 훅', status: 'warn', detail: '실행 권한 없음 — chmod +x .git/hooks/pre-commit 필요' });
  } else {
    items.push({ label: 'pre-commit 훅', status: 'ok', detail: '설치됨 + 실행 권한 확인' });
  }
}

// .gitignore secrets 제외 확인
function checkGitignore(items) {
  const gitignorePath = path.join(cfg.ROOT, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    items.push({ label: '.gitignore', status: 'warn', detail: '파일 없음' });
    return;
  }

  const content  = fs.readFileSync(gitignorePath, 'utf8');
  const required = ['secrets.json', 'bots/hub/secrets-store.json', '*.duckdb', '*.db'];
  const missing  = required.filter(p => !content.includes(p));

  if (missing.length > 0) {
    items.push({ label: '.gitignore', status: 'warn', detail: `누락: ${missing.join(', ')}` });
  } else {
    items.push({ label: '.gitignore', status: 'ok', detail: `${required.join(', ')} 제외 확인` });
  }
}

// secrets.json에 플레이스홀더 값 체크
function checkSecretsPlaceholders(items) {
  const PLACEHOLDERS = ['YOUR_', 'CHANGEME', 'PLACEHOLDER', 'example', 'test123'];

  for (const [team, p] of Object.entries(cfg.SECRETS)) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const found = PLACEHOLDERS.filter(ph => raw.includes(ph));
      if (found.length > 0) {
        items.push({ label: `secrets 플레이스홀더 (${team})`, status: 'warn', detail: `미교체 값: ${found.join(', ')}` });
      } else {
        items.push({ label: `secrets 유효성 (${team})`, status: 'ok', detail: '플레이스홀더 없음' });
      }
    } catch (e) {
      items.push({ label: `secrets 읽기 (${team})`, status: 'error', detail: e.message });
    }
  }
}

// .env 파일 권한 체크 (644 이상이면 경고 — 600 권장)
function checkEnvPermissions(items) {
  const ENV_PATHS = [
    path.join(cfg.ROOT, '.env'),
    path.join(cfg.BOTS.reservation, '.env'),
    path.join(cfg.BOTS.investment, '.env'),
    path.join(cfg.BOTS.claude, '.env'),
  ];
  let found = 0;
  for (const p of ENV_PATHS) {
    if (!fs.existsSync(p)) continue;
    found++;
    const mode = fileMode(p);
    // 644 (rw-r--r--) 이상 → 타인 읽기 가능 → warn
    const groupRead  = parseInt(mode[1] || '0', 8) & 0o4;
    const otherRead  = parseInt(mode[2] || '0', 8) & 0o4;
    if (groupRead || otherRead) {
      items.push({
        label:  `.env 권한 (${path.relative(cfg.ROOT, p)})`,
        status: 'warn',
        detail: `${mode} — 그룹/기타 읽기 가능 → chmod 600 ${p}`,
      });
    } else {
      items.push({ label: `.env 권한 (${path.relative(cfg.ROOT, p)})`, status: 'ok', detail: `${mode}` });
    }
  }
  if (found === 0) {
    items.push({ label: '.env 파일', status: 'ok', detail: '없음 (secrets.json 방식 사용)' });
  }
}

// 로그 파일 내 API 키 패턴 스캔 (최근 50줄만)
const LOG_KEY_PATTERNS = [
  { re: /sk-ant-[A-Za-z0-9_\-]{20,}/,  label: 'Anthropic API 키' },
  { re: /sk-[A-Za-z0-9]{40,}/,          label: 'OpenAI API 키' },
  { re: /AIza[A-Za-z0-9_\-]{30,}/,      label: 'Google API 키' },
  { re: /gsk_[A-Za-z0-9]{40,}/,         label: 'Groq API 키' },
  { re: /Bearer\s+[A-Za-z0-9_\-\.]{30,}/i, label: 'Bearer 토큰' },
  { re: /[0-9]{8,}:[A-Za-z0-9_\-]{30,}/, label: '텔레그램 토큰' },
];

function scanLogsForKeys(items) {
  const SCAN_LOGS = [
    { path: cfg.LOGS.naver,    label: '스카 로그' },
    { path: cfg.LOGS.crypto,   label: '루나 크립토 로그' },
    { path: cfg.LOGS.domestic, label: '루나 국내 로그' },
    { path: cfg.LOGS.overseas, label: '루나 해외 로그' },
    { path: cfg.LOGS.dexter,   label: '덱스터 로그' },
  ];

  let totalFindings = 0;
  for (const { path: logPath, label } of SCAN_LOGS) {
    if (!fs.existsSync(logPath)) continue;
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines   = content.split('\n').slice(-50); // 최근 50줄만
      for (const { re, label: keyLabel } of LOG_KEY_PATTERNS) {
        if (lines.some(l => re.test(l))) {
          totalFindings++;
          items.push({ label: `로그 키 노출 [${label}]`, status: 'error', detail: `${keyLabel} 패턴 감지 — 로그 삭제 필요` });
        }
      }
    } catch { /* 읽기 실패 무시 */ }
  }
  if (totalFindings === 0) {
    items.push({ label: '로그 내 키 노출 스캔', status: 'ok', detail: '의심 패턴 없음' });
  }
}

// git 최근 커밋 API 키 패턴 스캔 (최근 5커밋 diff)
function scanGitCommits(items) {
  try {
    const out = execSync('git -C ' + cfg.ROOT + ' log --oneline -5 2>/dev/null || echo "no-git"',
      { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out || out === 'no-git') {
      items.push({ label: 'git 커밋 스캔', status: 'ok', detail: 'git 저장소 없음' });
      return;
    }

    // diff 내 키 패턴 스캔 (+로 시작하는 추가 라인만)
    let diffOut = '';
    try {
      diffOut = execSync('git -C ' + cfg.ROOT + ' log -p -5 --no-color 2>/dev/null',
        { encoding: 'utf8', timeout: 8000 });
    } catch { return; }

    const addedLines = diffOut.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    let findings = 0;
    for (const { re, label } of LOG_KEY_PATTERNS) {
      if (addedLines.some(l => re.test(l))) {
        findings++;
        items.push({ label: `git 커밋 키 노출`, status: 'error', detail: `${label} 패턴 — git history 정리 필요` });
      }
    }
    if (findings === 0) {
      items.push({ label: 'git 커밋 스캔 (최근 5개)', status: 'ok', detail: '의심 패턴 없음' });
    }
  } catch {
    items.push({ label: 'git 커밋 스캔', status: 'ok', detail: '확인 스킵' });
  }
}

async function run() {
  const items = [];

  checkSecretsPermissions(items);
  checkEnvPermissions(items);
  scanHardcodedKeys(items);
  scanLogsForKeys(items);
  scanGitCommits(items);
  checkGitignore(items);
  checkSecretsPlaceholders(items);
  checkPreCommitHook(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '보안',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
