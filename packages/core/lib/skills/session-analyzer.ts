// @ts-nocheck
'use strict';

const { execSync } = require('child_process');

// 위험 파일 패턴
const HIGH_RISK_PATTERNS = [
  /bots\/investment\//,   // 실투자
  /secrets/i,             // 보안
  /\.env/,                // 환경변수
  /migration/i,           // DB 마이그레이션
  /pg-pool/,              // DB 연결
];

// git diff 기반 변경사항 분석
function analyzeChanges(since) {
  const sinceArg = since || '4 hours ago';
  try {
    const logOutput = execSync(`git log --since="${sinceArg}" --oneline`, {
      stdio: 'pipe', encoding: 'utf8', timeout: 10000,
    }).trim();

    const commitCount = logOutput ? logOutput.split('\n').length : 0;
    if (commitCount === 0) {
      return { files: [], additions: 0, deletions: 0, riskLevel: 'LOW' };
    }

    const diffOutput = execSync(`git diff --stat HEAD~${commitCount} HEAD`, {
      stdio: 'pipe', encoding: 'utf8', timeout: 10000,
    }).trim();

    const lines = diffOutput ? diffOutput.split('\n') : [];
    const files = [];
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      const fileMatch = line.match(/^\s*([^\s|]+)\s*\|/);
      if (fileMatch) files.push(fileMatch[1].trim());

      const statMatch = line.match(/(\d+)\s+insertion/);
      if (statMatch) additions += parseInt(statMatch[1], 10);

      const delMatch = line.match(/(\d+)\s+deletion/);
      if (delMatch) deletions += parseInt(delMatch[1], 10);
    }

    const hasHighRisk = files.some((f) => HIGH_RISK_PATTERNS.some((p) => p.test(f)));
    const riskLevel = hasHighRisk ? 'HIGH' : (files.length > 10 ? 'MEDIUM' : 'LOW');

    return { files, additions, deletions, riskLevel };
  } catch (err) {
    console.warn(`[skills/session-analyzer] 변경 분석 실패: ${err.message}`);
    return { files: [], additions: 0, deletions: 0, riskLevel: 'UNKNOWN' };
  }
}

// 누락된 검증 항목 감지
function detectMissingVerification(changes) {
  const data = changes || {};
  const files = Array.isArray(data.files) ? data.files : [];
  const missing = [];
  const suggestions = [];

  const hasJsChange = files.some((f) => /\.js$/.test(f));
  const hasTestChange = files.some((f) => /test|spec/i.test(f));
  const hasDbChange = files.some((f) => /migration|schema|pg-pool/i.test(f));
  const hasConfigChange = files.some((f) => /config|CLAUDE\.md|\.env/i.test(f));

  if (hasJsChange && !hasTestChange) {
    missing.push('테스트 파일 변경 없음');
    suggestions.push('JS 변경에 대한 테스트 추가 권장');
  }

  if (hasDbChange) {
    missing.push('DB 관련 변경 감지');
    suggestions.push('마이그레이션 및 롤백 절차 확인 필요');
  }

  if (hasConfigChange) {
    missing.push('설정 파일 변경 감지');
    suggestions.push('CLAUDE.md 또는 관련 문서 업데이트 확인');
  }

  return { missing, suggestions };
}

// 검증 리포트 생성
function generateVerificationReport(changes, missing) {
  const c = changes || {};
  const m = missing || {};
  const lines = [
    '=== 세션 변경사항 검증 리포트 ===',
    '',
    `파일: ${(c.files || []).length}개 변경`,
    `추가: +${c.additions || 0} / 삭제: -${c.deletions || 0}`,
    `위험도: ${c.riskLevel || 'UNKNOWN'}`,
    '',
  ];

  if ((m.missing || []).length > 0) {
    lines.push('⚠️ 누락 항목:');
    for (const item of m.missing) {
      lines.push(`  - ${item}`);
    }
    lines.push('');
  }

  if ((m.suggestions || []).length > 0) {
    lines.push('💡 권장 사항:');
    for (const s of m.suggestions) {
      lines.push(`  - ${s}`);
    }
  }

  return lines.join('\n');
}

module.exports = { analyzeChanges, detectMissingVerification, generateVerificationReport };
