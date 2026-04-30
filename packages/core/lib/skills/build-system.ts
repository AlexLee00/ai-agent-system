// @ts-nocheck
'use strict';

const { execSync } = require('child_process');

const BUILD_TARGETS = [];

// 변경 파일에서 빌드 필요한 프로젝트 감지
function detectBuildTargets(changedFiles) {
  const fileList = Array.isArray(changedFiles) ? changedFiles : [];
  const detected = [];

  for (const target of BUILD_TARGETS) {
    const matched = fileList.some((f) => typeof f === 'string' && f.startsWith(target.trigger));
    if (matched) {
      detected.push({ ...target });
    }
  }

  return detected;
}

// 단일 빌드 타겟 실행
function runBuild(target) {
  if (!target || !target.cmd || !target.path) {
    console.warn('[skills/build-system] 빌드 타겟 정보 부족');
    return { target: target?.name || 'unknown', pass: false, output: '타겟 정보 부족', duration: 0 };
  }

  const start = Date.now();
  try {
    const output = execSync(target.cmd, {
      cwd: target.path,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 300000, // 5분
    });
    return {
      target: target.name,
      pass: true,
      output: output.trim(),
      duration: Date.now() - start,
    };
  } catch (err) {
    const errMsg = err.stderr ? String(err.stderr).trim() : (err.message || '알 수 없는 오류');
    return {
      target: target.name,
      pass: false,
      output: errMsg,
      duration: Date.now() - start,
    };
  }
}

// 변경 파일 기반 전체 빌드
function runAllBuilds(changedFiles) {
  const targets = detectBuildTargets(changedFiles);
  const results = targets.map((t) => runBuild(t));

  return {
    results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      pass: results.every((r) => r.pass),
    },
  };
}

module.exports = { BUILD_TARGETS, detectBuildTargets, runBuild, runAllBuilds };
