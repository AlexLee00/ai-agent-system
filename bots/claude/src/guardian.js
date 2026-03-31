#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const skills = require('../../../packages/core/lib/skills');
const sender = require('../../../packages/core/lib/telegram-sender');
const env = require('../../../packages/core/lib/env');
const reviewer = require('./reviewer');

const ROOT = env.PROJECT_ROOT;
const GITIGNORE = path.join(ROOT, '.gitignore');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const REQUIRED_IGNORE_PATTERNS = ['secrets.json', '.env', '*.pem'];
const SUSPICIOUS_PACKAGES = ['xmrig', 'coinhive', 'crypto-miner', 'keylogger'];

function checkGitignore() {
  try {
    const content = fs.readFileSync(GITIGNORE, 'utf8');
    const hasAnyPemProtection = content.includes('*.pem') || content.includes('*.key');
    return REQUIRED_IGNORE_PATTERNS
      .filter((pattern) => {
        if (pattern === '*.pem') return !hasAnyPemProtection;
        return !content.includes(pattern);
      })
      .map((pattern) => ({
        severity: 'HIGH',
        desc: `.gitignore 누락: ${pattern}`,
      }));
  } catch (error) {
    console.warn(`[guardian] .gitignore 확인 실패: ${error.message}`);
    return [{ severity: 'HIGH', desc: '.gitignore 확인 실패' }];
  }
}

function checkPackageJson() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    return Object.keys(deps)
      .filter((name) => SUSPICIOUS_PACKAGES.some((item) => name.toLowerCase().includes(item)))
      .map((name) => ({
        severity: 'CRITICAL',
        desc: `의심 패키지 감지: ${name}`,
      }));
  } catch (error) {
    console.warn(`[guardian] package.json 확인 실패: ${error.message}`);
    return [];
  }
}

function formatSecurityReport(payload) {
  const lines = ['🛡️ 가디언 보안 검사'];
  lines.push(`- 검사 파일: ${payload.files.length}개`);
  lines.push(`- CRITICAL: ${payload.critical.length}건`);
  lines.push(`- HIGH: ${payload.high.length}건`);
  if (payload.critical.length === 0 && payload.high.length === 0) {
    lines.push('✅ 보안 이슈 없음');
    return lines.join('\n');
  }

  const addItems = (title, items) => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(title);
    items.slice(0, 12).forEach((item) => {
      const prefix = item.file ? `${path.relative(ROOT, item.file)}:${item.line || 0}` : 'global';
      lines.push(`- ${prefix} — ${item.desc}`);
    });
  };

  addItems('CRITICAL', payload.critical);
  addItems('HIGH', payload.high);
  return lines.join('\n');
}

async function runSecurityCheck(options = {}) {
  const testMode = Boolean(options.test) || process.argv.includes('--test');
  const files = Array.isArray(options.files) ? options.files : await reviewer.getChangedFiles();
  const jsFiles = files.filter((file) => /\.(m?js|cjs|json)$/i.test(file));

  const findings = [];
  jsFiles.forEach((file) => {
    const fileFindings = skills.codeReview.checkPatterns(file);
    fileFindings
      .filter((item) => item.severity === 'CRITICAL' || item.severity === 'HIGH')
      .forEach((item) => findings.push({ ...item, file }));
  });

  checkGitignore().forEach((item) => findings.push(item));
  checkPackageJson().forEach((item) => findings.push(item));

  const payload = {
    files: jsFiles,
    critical: findings.filter((item) => item.severity === 'CRITICAL'),
    high: findings.filter((item) => item.severity === 'HIGH'),
  };

  const message = formatSecurityReport(payload);
  let sent = false;
  if (!testMode) {
    sent = payload.critical.length > 0
      ? await sender.sendCritical('claude', message)
      : await sender.send('claude', message);
  }

  return {
    ...payload,
    sent,
    message,
    pass: payload.critical.length === 0 && payload.high.length === 0,
  };
}

module.exports = { runSecurityCheck, checkGitignore, checkPackageJson };

if (require.main === module) {
  runSecurityCheck()
    .then((result) => {
      console.log(result.message);
      process.exit(result.pass ? 0 : 1);
    })
    .catch((error) => {
      console.warn(`[guardian] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}
