#!/usr/bin/env tsx
// @ts-nocheck

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.cjs',
  '.mjs',
  '.py',
  '.ex',
  '.exs',
]);

const SKIP_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '_build',
  'deps',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
]);

const DIRECT_PROVIDER_PATTERNS = [
  { id: 'openai_sdk', re: /\b(from\s+openai\s+import\s+OpenAI|require\(['"]openai['"]\)|new\s+OpenAI\s*\(|\bOpenAI\s*\(\s*api_key)/ },
  { id: 'anthropic_sdk', re: /\b(anthropic\.Anthropic\s*\(|new\s+Anthropic\s*\(|require\(['"]@anthropic-ai\/sdk['"]\)|from\s+anthropic\s+import)/ },
  { id: 'groq_sdk', re: /\b(require\(['"]groq-sdk['"]\)|from\s+groq\s+import|new\s+Groq\s*\(|chat\.completions\.create\s*\()/ },
  { id: 'gemini_rest', re: /generativelanguage\.googleapis\.com|generateContent\?key=/ },
  { id: 'claude_cli', re: /spawnSync\s*\(\s*['"]claude['"]|execFileSync\s*\(\s*['"]claude['"]|execSync\s*\(\s*['"][^'"]*\bclaude\b/ },
];

const CORE_FALLBACK_PATTERNS = [
  { id: 'core_llm_fallback_import', re: /packages\/core\/lib\/llm-fallback|require\(['"][^'"]*llm-fallback|from ['"][^'"]*llm-fallback/ },
  { id: 'call_with_fallback', re: /\bcallWithFallback\s*\(/ },
  { id: 'call_llm_legacy', re: /\bcallLlm\s*\(/ },
];

const HUB_PATTERNS = [
  /callHubLlm\s*\(/,
  /callHubVision\s*\(/,
  /callHubEmbedding\s*\(/,
  /callLLMWithHub\s*\(/,
  /\/hub\/llm\/call/,
  /\/hub\/llm\/vision/,
  /\/hub\/llm\/embeddings/,
  /buildHubLlmCallPayload\s*\(/,
];

const EXPLICIT_GATE_PATTERNS = [
  /HUB_ENABLE_OPENAI_PUBLIC_API/,
  /HUB_ENABLE_CLAUDE_PUBLIC_API/,
  /HUB_ENABLE_ANTHROPIC_PUBLIC_API/,
  /HUB_ENABLE_GEMINI_PUBLIC_API/,
  /HUB_ENABLE_GOOGLE_PUBLIC_API/,
  /INVESTMENT_LLM_DIRECT_FALLBACK/,
  /HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES/,
];

const CORE_PROVIDER_ADAPTERS = new Set([
  'packages/core/lib/llm-fallback.ts',
  'packages/core/lib/llm-keys.ts',
  'packages/core/lib/llm-control/tester-support.ts',
  'bots/hub/lib/llm/unified-caller.ts',
  'bots/hub/lib/routes/llm.ts',
]);

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!found) return fallback;
  if (found === name) return true;
  return found.slice(prefix.length);
}

function enabled(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function listSourceFiles() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr || result.status}`);
  }
  return String(result.stdout || '')
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .filter((file) => !file.split(/[\\/]/).some((segment) => SKIP_SEGMENTS.has(segment)))
    .filter((file) => file !== 'bots/hub/scripts/llm-non-hub-path-audit.ts');
}

function lineNumbersFor(content, re) {
  const lines = content.split(/\r?\n/);
  const found = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (re.test(lines[idx])) found.push(idx + 1);
    re.lastIndex = 0;
  }
  return found.slice(0, 8);
}

function isHubInternal(file) {
  return file.startsWith('bots/hub/');
}

function isTestOrDiagnostic(file) {
  const name = path.basename(file);
  return file.includes('/test/')
    || file.includes('/tests/')
    || file.includes('/__tests__/')
    || file.startsWith('tests/')
    || file.startsWith('tmp/')
    || file.startsWith('scripts/chaos/')
    || file.startsWith('scripts/build-')
    || /^test[-.]/.test(name)
    || /debug/i.test(name)
    || /(?:smoke|drill|canary|audit|report|readiness|test)\.(?:ts|tsx|js|cjs|mjs|py)$/.test(name)
    || /(?:-smoke|-drill|-canary|-audit|-report|-readiness)/.test(name);
}

function classifyFile(file, content) {
  const directMatches = DIRECT_PROVIDER_PATTERNS
    .filter((pattern) => pattern.re.test(content))
    .map((pattern) => ({
      id: pattern.id,
      lines: lineNumbersFor(content, pattern.re),
    }));
  const fallbackMatches = CORE_FALLBACK_PATTERNS
    .filter((pattern) => pattern.re.test(content))
    .map((pattern) => ({
      id: pattern.id,
      lines: lineNumbersFor(content, pattern.re),
    }));
  const hasHubUsage = HUB_PATTERNS.some((re) => re.test(content));
  const explicitGate = EXPLICIT_GATE_PATTERNS
    .filter((re) => re.test(content))
    .map((re) => String(re).replace(/^\/|\/$/g, ''));

  if (directMatches.length === 0 && fallbackMatches.length === 0) return null;

  const adapter = CORE_PROVIDER_ADAPTERS.has(file);
  const hubInternal = isHubInternal(file);
  const diagnostic = isTestOrDiagnostic(file);
  const gated = explicitGate.length > 0;

  let severity = 'P1';
  let category = 'direct_or_unclear_runtime_path';
  let recommendedAction = 'Hub facade 또는 /hub/llm/call 경유로 이전하고, 직접 provider 키 사용을 제거한다.';

  if (adapter) {
    severity = 'ALLOW';
    category = 'core_or_hub_provider_adapter';
    recommendedAction = '허용된 provider adapter다. 외부 팀 코드는 이 파일을 직접 호출하지 않도록 유지한다.';
  } else if (hubInternal) {
    severity = 'ALLOW';
    category = 'hub_internal_runtime';
    recommendedAction = 'Hub 내부 runtime이다. 팀별 외부 호출자가 이 경로를 우회하지 않는지만 감시한다.';
  } else if (diagnostic) {
    severity = 'P3';
    category = 'test_diagnostic_or_drill';
    recommendedAction = '테스트/진단 전용으로 유지한다. live 비용이 발생하는 스크립트는 confirm/cost cap을 유지한다.';
  } else if (gated || hasHubUsage) {
    severity = 'P2';
    category = 'gated_or_hub_wrapped_direct_fallback';
    recommendedAction = '게이트 기본 OFF를 유지하고, 가능하면 Hub 표준 gateway 기능으로 이전한다.';
  }

  return {
    file,
    severity,
    category,
    directMatches,
    fallbackMatches,
    hasHubUsage,
    explicitGate,
    recommendedAction,
  };
}

function main() {
  const json = enabled(argValue('--json', 'true'));
  const strict = enabled(argValue('--strict', 'false'));
  const files = listSourceFiles();
  const findings = [];

  for (const file of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const finding = classifyFile(file, content);
    if (finding) findings.push(finding);
  }

  const bySeverity = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] || 0) + 1;
    return acc;
  }, {});
  const blockers = findings.filter((finding) => finding.severity === 'P1');
  const warnings = findings.filter((finding) => finding.severity === 'P2');

  const result = {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? (warnings.length ? 'warnings' : 'clear') : 'needs_migration',
    scannedFiles: files.length,
    summary: bySeverity,
    blockers: blockers.map((finding) => ({
      file: finding.file,
      category: finding.category,
      matches: [...finding.directMatches, ...finding.fallbackMatches],
      recommendedAction: finding.recommendedAction,
    })),
    warnings: warnings.map((finding) => ({
      file: finding.file,
      category: finding.category,
      gates: finding.explicitGate,
      hasHubUsage: finding.hasHubUsage,
      matches: [...finding.directMatches, ...finding.fallbackMatches],
      recommendedAction: finding.recommendedAction,
    })),
    findings,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[llm-non-hub-path-audit] status=${result.status} scanned=${files.length} P1=${blockers.length} P2=${warnings.length}`);
    for (const finding of [...blockers, ...warnings].slice(0, 30)) {
      console.log(`- [${finding.severity}] ${finding.file} (${finding.category})`);
    }
  }

  if (strict && !result.ok) process.exitCode = 1;
}

main();
