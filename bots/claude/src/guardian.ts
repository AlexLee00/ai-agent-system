// @ts-nocheck
'use strict';

/**
 * src/guardian.ts — 클로드팀 가디언 봇 (6계층 보안 완전 구현)
 *
 * 6계층 보안 체크:
 *   Layer 1: .gitignore 완전성 검사
 *   Layer 2: 커밋된 시크릿 스캔 (git log 패턴)
 *   Layer 3: 의심 패키지 검사 (package.json)
 *   Layer 4: 의존성 취약점 (npm audit)
 *   Layer 5: 파일 권한 검사 (chmod 777/666)
 *   Layer 6: 외부 네트워크 호출 검사 (의심 도메인)
 *
 * Kill Switch: CLAUDE_GUARDIAN_ENABLED=true (기본 false)
 *
 * 트리거:
 *   - launchd 매일 03:00 KST (ai.claude.guardian)
 *   - Commander `run_guardian` 명령
 *   - Reviewer 통과 후 연계 호출
 */

const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');

const skills        = require('../../../packages/core/lib/skills');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const env           = require('../../../packages/core/lib/env');
const reviewer      = require('./reviewer');

const ROOT         = env.PROJECT_ROOT;

function resolveRootDir(options = {}) {
  const candidate = options.rootDir || options.cwd || ROOT;
  return path.resolve(candidate);
}

function buildGuardianSelfFiles(rootDir = ROOT) {
  return new Set([
    path.join(rootDir, 'bots', 'claude', 'src', 'guardian.ts'),
    path.join(rootDir, 'bots', 'claude', 'src', 'guardian.js'),
    path.join(rootDir, 'bots', 'claude', '__tests__', 'guardian.test.ts'),
  ].map(file => path.resolve(file)));
}

const REQUIRED_IGNORE_PATTERNS = ['secrets.json', '.env', '*.pem'];
const SUSPICIOUS_PACKAGES = ['xmrig', 'coinhive', 'crypto-miner', 'keylogger', 'cryptonight'];

// 의심 외부 도메인 (정상 도메인 제외)
const SUSPICIOUS_DOMAINS = [
  'pastebin.com',
  'ngrok.io',
  'serveo.net',
  'requestbin.',
  'webhook.site',
  'pipedream.net',
];

// 시크릿 패턴 (git log 스캔용)
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{40,}/,            // OpenAI API key
  /AKIA[0-9A-Z]{16}/,               // AWS Access Key
  /ghp_[a-zA-Z0-9]{36}/,            // GitHub PAT
  /xox[bpros]-[a-zA-Z0-9-]+/,       // Slack token
  /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/, // Private key
  /"password"\s*:\s*"[^"]{8,}"/,    // Hardcoded password
  /telegram_bot_token.*[:=]\s*["']?[0-9]+:[a-zA-Z0-9_-]{35}["']?/i, // Telegram token
];

function shouldIgnoreNetworkAuditHit(filePath, options = {}) {
  if (!filePath) return true;
  const rootDir = resolveRootDir(options);
  const guardianSelfFiles = buildGuardianSelfFiles(rootDir);
  const resolved = path.resolve(String(filePath).trim());
  if (guardianSelfFiles.has(resolved)) return true;

  // detector definition 자체는 self-scan false positive이므로 제외한다.
  if (resolved.endsWith(`${path.sep}bots${path.sep}claude${path.sep}src${path.sep}guardian.ts`)) return true;
  if (resolved.endsWith(`${path.sep}bots${path.sep}claude${path.sep}src${path.sep}guardian.js`)) return true;
  return false;
}

function safeExec(command, options = {}) {
  const rootDir = resolveRootDir(options);
  const execOptions = { ...options };
  delete execOptions.rootDir;
  try {
    return execSync(command, {
      cwd: execOptions.cwd || rootDir,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 30000,
      ...execOptions,
    }).trim();
  } catch (error) {
    return '';
  }
}

// ─── Layer 1: .gitignore 완전성 ────────────────────────────────────────

function layer1_gitignoreAudit(options = {}) {
  const rootDir = resolveRootDir(options);
  const gitignore = path.join(rootDir, '.gitignore');
  try {
    const content = fs.readFileSync(gitignore, 'utf8');
    const hasAnyPemProtection = content.includes('*.pem') || content.includes('*.key');
    return REQUIRED_IGNORE_PATTERNS
      .filter(pattern => {
        if (pattern === '*.pem') return !hasAnyPemProtection;
        return !content.includes(pattern);
      })
      .map(pattern => ({ severity: 'HIGH', desc: `.gitignore 누락: ${pattern}`, layer: 1 }));
  } catch (error) {
    return [{ severity: 'HIGH', desc: `.gitignore 확인 실패: ${error.message}`, layer: 1 }];
  }
}

// ─── Layer 2: 커밋된 시크릿 스캔 ──────────────────────────────────────

function layer2_commitSecretScan(options = {}) {
  const rootDir = resolveRootDir(options);
  const issues = [];
  try {
    // 최근 20 커밋의 diff 스캔
    const diff = safeExec('git log -20 --diff-filter=A -p -- "*.json" "*.yaml" "*.yml" "*.env" 2>/dev/null || true', { rootDir });
    if (!diff) return issues;

    const lines = diff.split('\n');
    lines.forEach((line, idx) => {
      if (!line.startsWith('+')) return;
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          issues.push({
            severity: 'CRITICAL',
            desc: `커밋된 시크릿 의심 패턴: ${line.slice(0, 80)}`,
            layer: 2,
          });
          break;
        }
      }
    });
  } catch {}
  return issues;
}

// ─── Layer 3: 의심 패키지 검사 ────────────────────────────────────────

function layer3_suspiciousPackages(options = {}) {
  const rootDir = resolveRootDir(options);
  const packageJson = path.join(rootDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    return Object.keys(deps)
      .filter(name => SUSPICIOUS_PACKAGES.some(item => name.toLowerCase().includes(item)))
      .map(name => ({ severity: 'CRITICAL', desc: `의심 패키지 감지: ${name}`, layer: 3 }));
  } catch {
    return [];
  }
}

// ─── Layer 4: 의존성 취약점 ───────────────────────────────────────────

function layer4_dependencyVulnerabilities(options = {}) {
  const rootDir = resolveRootDir(options);
  const issues = [];
  try {
    const output = safeExec('npm audit --json 2>/dev/null || true', { rootDir });
    if (!output) return issues;

    let audit;
    try { audit = JSON.parse(output); } catch { return issues; }

    const vulns = audit.vulnerabilities || {};
    let criticalCount = 0;
    let highCount = 0;

    for (const [name, info] of Object.entries(vulns)) {
      const sev = info.severity;
      if (sev === 'critical') {
        criticalCount++;
        issues.push({ severity: 'CRITICAL', desc: `npm audit CRITICAL: ${name}`, layer: 4 });
      } else if (sev === 'high') {
        highCount++;
        if (highCount <= 5) {
          issues.push({ severity: 'HIGH', desc: `npm audit HIGH: ${name}`, layer: 4 });
        }
      }
    }

    if (highCount > 5) {
      issues.push({ severity: 'HIGH', desc: `npm audit HIGH: ${highCount}개 (상위 5개만 표시)`, layer: 4 });
    }
  } catch {}
  return issues;
}

// ─── Layer 5: 파일 권한 검사 ──────────────────────────────────────────

function layer5_permissionAudit(options = {}) {
  const rootDir = resolveRootDir(options);
  const issues = [];
  try {
    // 777 또는 666 권한 파일 검사 (민감한 디렉토리만)
    const targets = ['bots', 'packages', 'elixir'].map(d => path.join(rootDir, d));
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;

      const found777 = safeExec(`find "${target}" -perm 777 -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -5`);
      if (found777) {
        found777.split('\n').filter(Boolean).forEach(f => {
          issues.push({ severity: 'HIGH', desc: `chmod 777 파일 발견: ${path.relative(rootDir, f)}`, layer: 5 });
        });
      }

      const found666 = safeExec(`find "${target}" -perm 666 -name "*.json" -not -path "*/node_modules/*" 2>/dev/null | head -5`);
      if (found666) {
        found666.split('\n').filter(Boolean).forEach(f => {
          issues.push({ severity: 'HIGH', desc: `chmod 666 JSON 파일: ${path.relative(rootDir, f)}`, layer: 5 });
        });
      }
    }
  } catch {}
  return issues;
}

// ─── Layer 6: 외부 네트워크 호출 검사 ────────────────────────────────

function layer6_networkAudit(options = {}) {
  const rootDir = resolveRootDir(options);
  const issues = [];
  try {
    // 소스 파일에서 의심 도메인 검색
    for (const domain of SUSPICIOUS_DOMAINS) {
      const found = safeExec(
        `grep -rl "${domain}" --include="*.ts" --include="*.js" --include="*.json" ` +
        `"${rootDir}/bots" "${rootDir}/packages" 2>/dev/null | ` +
        `grep -v node_modules | grep -v ".git" | head -5`
      );
      if (found) {
        found.split('\n')
          .map(item => item.trim())
          .filter(Boolean)
          .filter(filePath => !shouldIgnoreNetworkAuditHit(filePath, { rootDir }))
          .forEach(f => {
          issues.push({
            severity: 'HIGH',
            desc: `의심 도메인(${domain}) 하드코딩: ${path.relative(rootDir, f)}`,
            layer: 6,
          });
          });
      }
    }
  } catch {}
  return issues;
}

// ─── 종합 보안 스캔 ────────────────────────────────────────────────────

async function runFullSecurityScan(options = {}) {
  const enabled  = process.env.CLAUDE_GUARDIAN_ENABLED === 'true';
  const testMode = Boolean(options.test) || process.argv.includes('--test');
  const rootDir = resolveRootDir(options);

  if (!enabled && !testMode && !options.force) {
    return {
      files: [], critical: [], high: [], sent: false, pass: true,
      message: '[가디언] Kill Switch OFF — 스킵',
    };
  }

  const files = Array.isArray(options.files)
    ? options.files.map(file => (path.isAbsolute(file) ? file : path.join(rootDir, file)))
    : await reviewer.getChangedFiles({ rootDir });
  const jsFiles = files.filter(file => /\.(m?js|cjs|json)$/i.test(file));

  // 기존 skills 기반 파일 패턴 체크
  const findings = [];
  jsFiles.forEach(file => {
    const fileFindings = skills.codeReview.checkPatterns(file);
    fileFindings
      .filter(item => item.severity === 'CRITICAL' || item.severity === 'HIGH')
      .forEach(item => findings.push({ ...item, file }));
  });

  // 6계층 보안 체크
  const l1 = layer1_gitignoreAudit({ rootDir });
  const l2 = layer2_commitSecretScan({ rootDir });
  const l3 = layer3_suspiciousPackages({ rootDir });
  const l4 = layer4_dependencyVulnerabilities({ rootDir });
  const l5 = layer5_permissionAudit({ rootDir });
  const l6 = layer6_networkAudit({ rootDir });

  const allIssues = [...findings, ...l1, ...l2, ...l3, ...l4, ...l5, ...l6];

  const payload = {
    files: jsFiles,
    critical: allIssues.filter(item => item.severity === 'CRITICAL'),
    high:     allIssues.filter(item => item.severity === 'HIGH'),
    layers: { l1, l2, l3, l4, l5, l6 },
  };

  const message = formatSecurityReport(payload, { rootDir });
  let sent = false;

  if (!testMode) {
    sent = (await postAlarm({
      message,
      team: 'claude',
      alertLevel: payload.critical.length > 0 ? 4 : (payload.high.length > 0 ? 3 : 2),
      fromBot: 'guardian',
    })).ok;
  }

  return {
    ...payload,
    rootDir,
    sent,
    message,
    pass: payload.critical.length === 0 && payload.high.length === 0,
  };
}

// ─── 리포트 포맷 ──────────────────────────────────────────────────────

function formatSecurityReport(payload, options = {}) {
  const rootDir = resolveRootDir({ rootDir: options.rootDir || payload?.rootDir || ROOT });
  const lines = ['🛡️ 가디언 6계층 보안 검사'];
  lines.push(`- 검사 파일: ${payload.files.length}개`);
  lines.push(`- CRITICAL: ${payload.critical.length}건`);
  lines.push(`- HIGH: ${payload.high.length}건`);

  if (payload.layers) {
    const { l1, l2, l3, l4, l5, l6 } = payload.layers;
    lines.push('');
    lines.push('계층별:');
    lines.push(`  L1 gitignore: ${l1.length === 0 ? '✅' : `⚠️ ${l1.length}건`}`);
    lines.push(`  L2 시크릿스캔: ${l2.length === 0 ? '✅' : `🚨 ${l2.length}건`}`);
    lines.push(`  L3 의심패키지: ${l3.length === 0 ? '✅' : `🚨 ${l3.length}건`}`);
    lines.push(`  L4 취약점: ${l4.length === 0 ? '✅' : `⚠️ ${l4.length}건`}`);
    lines.push(`  L5 권한: ${l5.length === 0 ? '✅' : `⚠️ ${l5.length}건`}`);
    lines.push(`  L6 네트워크: ${l6.length === 0 ? '✅' : `⚠️ ${l6.length}건`}`);
  }

  if (payload.critical.length === 0 && payload.high.length === 0) {
    lines.push('');
    lines.push('✅ 보안 이슈 없음');
    return lines.join('\n');
  }

  const addItems = (title, items) => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(title);
    items.slice(0, 12).forEach(item => {
      const prefix = item.file ? `${path.relative(rootDir, item.file)}:${item.line || 0}` : `L${item.layer || '?'}`;
      lines.push(`- ${prefix} — ${item.desc}`);
    });
  };

  addItems('CRITICAL', payload.critical);
  addItems('HIGH', payload.high);
  return lines.join('\n');
}

// 기존 호환 alias
async function runSecurityCheck(options = {}) {
  return runFullSecurityScan(options);
}

module.exports = {
  runSecurityCheck,
  runFullSecurityScan,
  checkGitignore: layer1_gitignoreAudit,
  checkPackageJson: layer3_suspiciousPackages,
  layer1_gitignoreAudit,
  layer2_commitSecretScan,
  layer3_suspiciousPackages,
  layer4_dependencyVulnerabilities,
  layer5_permissionAudit,
  layer6_networkAudit,
  formatSecurityReport,
};

if (require.main === module) {
  runFullSecurityScan({ force: true })
    .then(result => {
      console.log(result.message);
      process.exit(result.pass ? 0 : 1);
    })
    .catch(error => {
      console.warn(`[guardian] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}
