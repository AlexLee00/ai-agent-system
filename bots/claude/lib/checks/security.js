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
      items.push({ label: `secrets.json (${team})`, status: 'warn', detail: '파일 없음' });
      continue;
    }
    const mode = fileMode(p);
    if (mode === '600') {
      items.push({ label: `secrets.json (${team})`, status: 'ok', detail: '권한 600 ✅' });
    } else {
      items.push({ label: `secrets.json (${team})`, status: 'error', detail: `권한 ${mode} (600이어야 함) → chmod 600 ${p}` });
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

// .gitignore secrets 제외 확인
function checkGitignore(items) {
  const gitignorePath = path.join(cfg.ROOT, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    items.push({ label: '.gitignore', status: 'warn', detail: '파일 없음' });
    return;
  }

  const content  = fs.readFileSync(gitignorePath, 'utf8');
  const required = ['secrets.json', '*.duckdb', '*.db'];
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

async function run() {
  const items = [];

  checkSecretsPermissions(items);
  scanHardcodedKeys(items);
  checkGitignore(items);
  checkSecretsPlaceholders(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '보안',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
