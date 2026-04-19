import fs from 'fs';
import path from 'path';
import { PROFILES, LOCAL_LLM_BASE_URL } from '../lib/runtime-profiles';

type RouteIssue = {
  team: string;
  purpose: string;
  kind: string;
  value: string;
};

type FileIssue = {
  path: string;
  pattern: string;
  line: number;
  text: string;
};

const PROJECT_ROOT = '/Users/alexlee/projects/ai-agent-system';

const ACTIVE_FILES = [
  '/Users/alexlee/projects/ai-agent-system/packages/core/lib/llm-model-selector.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/hub/lib/runtime-profiles.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/blog/lib/runtime-config.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/blog/lib/commenter.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/claude/lib/config.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/darwin/lib/research-evaluator.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/darwin/lib/applicator.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/investment/team/chronos.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/legal/lib/llm-helper.js',
  '/Users/alexlee/projects/ai-agent-system/bots/legal/config.json',
  '/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/seed-agent-registry.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/seed-three-teams.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/seed-team-reinforce-phase6.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/seed-blog-reinforce.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/seed-blog-agents-phase2.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/seed-sigma-expansion.ts',
];

const COMPATIBILITY_FILES = [
  '/Users/alexlee/projects/ai-agent-system/packages/core/lib/llm-model-selector.ts',
  '/Users/alexlee/projects/ai-agent-system/bots/investment/team/chronos.ts',
];

const LOCAL_PATTERNS = [
  /provider:\s*['"]local['"]/,
  /local\/qwen2\.5-7b/,
  /local\/deepseek-r1-32b/,
  /model:\s*['"]qwen2\.5-7b['"]/,
  /model:\s*['"]deepseek-r1-32b['"]/,
];

function shouldIgnoreCompatibilityTrace(filePath: string, text: string): boolean {
  if (filePath.endsWith('/bots/investment/team/chronos.ts')) {
    return text.includes("'local/qwen2.5-7b':") || text.includes("'local/deepseek-r1-32b':");
  }
  return false;
}

function findActiveFileIssues(filePath: string): FileIssue[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const issues: FileIssue[] = [];

  lines.forEach((text, index) => {
    for (const pattern of LOCAL_PATTERNS) {
      if (pattern.test(text)) {
        if (shouldIgnoreCompatibilityTrace(filePath, text)) {
          continue;
        }
        issues.push({
          path: filePath,
          pattern: String(pattern),
          line: index + 1,
          text: text.trim(),
        });
      }
    }
  });

  return issues;
}

function findRuntimeRouteIssues(): RouteIssue[] {
  const issues: RouteIssue[] = [];

  for (const [team, profiles] of Object.entries(PROFILES)) {
    for (const [purpose, profile] of Object.entries(profiles)) {
      if (profile.provider === 'local') {
        issues.push({ team, purpose, kind: 'direct_provider', value: String(profile.model || '') });
      }
      for (const route of profile.primary_routes || []) {
        if (String(route).startsWith('local/')) {
          issues.push({ team, purpose, kind: 'primary_route', value: String(route) });
        }
      }
      for (const route of profile.fallback_routes || []) {
        if (String(route).startsWith('local/')) {
          issues.push({ team, purpose, kind: 'fallback_route', value: String(route) });
        }
      }
      if (profile.base_url === LOCAL_LLM_BASE_URL && !profile.local_image && profile.provider === 'local') {
        issues.push({ team, purpose, kind: 'direct_base_url_local', value: LOCAL_LLM_BASE_URL });
      }
    }
  }

  return issues;
}

function buildReport() {
  const runtimeIssues = findRuntimeRouteIssues();
  const fileIssues = ACTIVE_FILES.flatMap((filePath) => findActiveFileIssues(filePath));

  const compatibilityIssues = fileIssues.filter((issue) => COMPATIBILITY_FILES.includes(issue.path));
  const activeIssues = fileIssues.filter((issue) => !COMPATIBILITY_FILES.includes(issue.path));

  const status = runtimeIssues.length === 0 && activeIssues.length === 0
    ? 'local_chat_policy_clean'
    : 'local_chat_policy_attention';

  return {
    checkedAt: new Date().toISOString(),
    status,
    summary: {
      runtimeIssues: runtimeIssues.length,
      activeFileIssues: activeIssues.length,
      compatibilityIssues: compatibilityIssues.length,
      embeddingBaseUrl: LOCAL_LLM_BASE_URL,
    },
    runtimeIssues,
    activeFileIssues: activeIssues,
    compatibilityIssues,
    checkedFiles: ACTIVE_FILES.map((filePath) => path.relative(PROJECT_ROOT, filePath)),
  };
}

function printText(report: ReturnType<typeof buildReport>) {
  console.log(`Local LLM policy: ${report.status}`);
  console.log(`runtime issues: ${report.summary.runtimeIssues}`);
  console.log(`active file issues: ${report.summary.activeFileIssues}`);
  console.log(`compatibility issues: ${report.summary.compatibilityIssues}`);
  console.log(`embedding endpoint: ${report.summary.embeddingBaseUrl}`);

  if (report.runtimeIssues.length > 0) {
    console.log('\nRuntime issues:');
    for (const issue of report.runtimeIssues) {
      console.log(`- ${issue.team}:${issue.purpose} | ${issue.kind} | ${issue.value}`);
    }
  }

  if (report.activeFileIssues.length > 0) {
    console.log('\nActive file issues:');
    for (const issue of report.activeFileIssues) {
      console.log(`- ${path.relative(PROJECT_ROOT, issue.path)}:${issue.line} | ${issue.text}`);
    }
  }

  if (report.compatibilityIssues.length > 0) {
    console.log('\nCompatibility-only traces:');
    for (const issue of report.compatibilityIssues) {
      console.log(`- ${path.relative(PROJECT_ROOT, issue.path)}:${issue.line} | ${issue.text}`);
    }
  }
}

const asJson = process.argv.includes('--json');
const report = buildReport();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printText(report);
}
