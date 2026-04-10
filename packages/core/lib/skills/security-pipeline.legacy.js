'use strict';

const fs = require('fs');
const path = require('path');
const codeReview = require('./code-review');

// 추가 보안 검사 패턴
const ENV_LOG_PATTERN = /console\.(log|info|debug)\s*\([^)]*process\.env/;
const HARDCODED_IP_PATTERN = /['"`]\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}['"`]/;
const LOCALHOST_PATTERN = /127\.0\.0\.1|0\.0\.0\.0|localhost/;
const PRIVILEGE_PATTERN = /\b(chmod|chown|sudo)\b/;

const REQUIRED_GITIGNORE = ['secrets.json', '.env', '*.pem', '*.key', 'node_modules'];
const SUSPICIOUS_PACKAGES = ['crypto-miner', 'cryptonight', 'eval', 'shell-exec', 'exec-sync'];

// .gitignore에 필수 항목이 있는지 확인
function checkGitignore() {
  const gitignorePath = path.resolve('.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim());
    const missing = [];

    for (const required of REQUIRED_GITIGNORE) {
      const found = lines.some((line) => {
        if (line.startsWith('#') || line === '') return false;
        return line === required || line.includes(required);
      });
      if (!found) missing.push(required);
    }

    return { pass: missing.length === 0, missing };
  } catch (err) {
    console.warn(`[skills/security-pipeline] .gitignore 읽기 실패: ${err.message}`);
    return { pass: false, missing: REQUIRED_GITIGNORE.slice() };
  }
}

// package.json에서 의심 패키지 감지
function checkDependencies() {
  const pkgPath = path.resolve('package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const allDeps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
    const suspicious = allDeps.filter((dep) =>
      SUSPICIOUS_PACKAGES.some((s) => dep.toLowerCase().includes(s))
    );

    return { pass: suspicious.length === 0, suspicious };
  } catch (err) {
    console.warn(`[skills/security-pipeline] package.json 읽기 실패: ${err.message}`);
    return { pass: true, suspicious: [] };
  }
}

// 파일별 추가 보안 검사
function checkExtraPatterns(filePath) {
  const findings = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // 환경변수 로그 출력
      if (ENV_LOG_PATTERN.test(line)) {
        findings.push({ severity: 'HIGH', desc: 'process.env를 로그에 출력', line: index + 1 });
      }

      // 하드코딩 IP (localhost 제외)
      if (HARDCODED_IP_PATTERN.test(line) && !LOCALHOST_PATTERN.test(line)) {
        findings.push({ severity: 'MEDIUM', desc: '하드코딩 IP 주소', line: index + 1 });
      }

      // 권한 에스컬레이션
      if (PRIVILEGE_PATTERN.test(line)) {
        findings.push({ severity: 'HIGH', desc: '권한 에스컬레이션 명령 사용', line: index + 1 });
      }
    });
  } catch (err) {
    console.warn(`[skills/security-pipeline] 파일 읽기 실패: ${filePath} — ${err.message}`);
  }

  return findings;
}

// 종합 보안 파이프라인
function runSecurityPipeline(files) {
  const fileList = Array.isArray(files) ? files : [];
  const results = [];

  // code-review.js의 checkPatterns + 추가 검사
  for (const file of fileList) {
    if (typeof file !== 'string') continue;
    const baseFindings = codeReview.checkPatterns(file);
    const extraFindings = checkExtraPatterns(file);
    const allFindings = baseFindings.concat(extraFindings).map((f) => ({ file, ...f }));
    results.push(...allFindings);
  }

  // 프로젝트 레벨 검사
  const gitignoreResult = checkGitignore();
  const depsResult = checkDependencies();

  const summary = {
    totalFiles: fileList.length,
    findings: results.length,
    critical: results.filter((r) => r.severity === 'CRITICAL').length,
    high: results.filter((r) => r.severity === 'HIGH').length,
    medium: results.filter((r) => r.severity === 'MEDIUM').length,
    gitignorePass: gitignoreResult.pass,
    depsPass: depsResult.pass,
    pass: results.filter((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH').length === 0
      && gitignoreResult.pass && depsResult.pass,
  };

  return { results, gitignore: gitignoreResult, dependencies: depsResult, summary };
}

module.exports = { runSecurityPipeline, checkGitignore, checkDependencies };
