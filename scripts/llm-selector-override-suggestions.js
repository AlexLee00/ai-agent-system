'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  insertSelectorOverrideSuggestionLog,
} = require(path.join(__dirname, '../bots/worker/lib/llm-api-monitoring'));
const {
  normalizeChain,
} = require(path.join(__dirname, '../packages/core/lib/llm-selector-advisor'));

const SELECTOR_PATHS = {
  'orchestrator.jay.intent': {
    config: 'bots/orchestrator/config.json',
    path: 'runtime_config.llmSelectorOverrides.orchestrator.jay.intent',
  },
  'orchestrator.jay.chat_fallback': {
    config: 'bots/orchestrator/config.json',
    path: 'runtime_config.llmSelectorOverrides.orchestrator.jay.chat_fallback.chain',
  },
  'worker.ai.fallback': {
    config: 'bots/worker/config.json',
    path: 'runtime_config.llmSelectorOverrides.worker.ai.fallback.providerModels',
  },
  'worker.chat.task_intake': {
    config: 'bots/worker/config.json',
    path: 'runtime_config.llmSelectorOverrides.worker.chat.task_intake.chain',
  },
  'claude.archer.tech_analysis': {
    config: 'bots/claude/config.json',
    path: 'runtime_config.llmSelectorOverrides.claude.archer.tech_analysis.chain',
  },
  'claude.lead.system_issue_triage': {
    config: 'bots/claude/config.json',
    path: 'runtime_config.llmSelectorOverrides.claude.lead.system_issue_triage.chain',
  },
  'claude.dexter.ai_analyst.warn': {
    config: 'bots/claude/config.json',
    path: 'runtime_config.llmSelectorOverrides.claude.dexter.ai_analyst.lowModel',
  },
  'claude.dexter.ai_analyst.critical': {
    config: 'bots/claude/config.json',
    path: 'runtime_config.llmSelectorOverrides.claude.dexter.ai_analyst.highModel',
  },
  'blog.pos.writer': {
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.pos.writer.chain',
  },
  'blog.gems.writer': {
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.gems.writer.chain',
  },
  'blog.social.summarize': {
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.social.summarize.chain',
  },
  'blog.social.caption': {
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.social.caption.chain',
  },
  'blog.star.summarize': {
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.star.summarize.chain',
  },
  'blog.star.caption': {
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.star.caption.chain',
  },
  'blog.curriculum.recommend': {
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.curriculum.recommend.chain',
  },
  'blog.curriculum.generate': {
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.curriculum.generate.chain',
  },
};

function runSelectorReportJson() {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'llm-selector-report.js');
  const result = spawnSync(process.execPath, [script, '--json'], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'selector report failed').trim());
  }
  return JSON.parse(result.stdout);
}

function moveCandidateFirst(chain, candidateModel) {
  const out = [];
  const seen = new Set();
  const candidate = chain.find((entry) => entry.model === candidateModel);
  if (candidate) {
    out.push(candidate);
    seen.add(`${candidate.provider}:${candidate.model}`);
  }
  for (const entry of chain) {
    const key = `${entry.provider}:${entry.model}`;
    if (seen.has(key)) continue;
    out.push(entry);
    seen.add(key);
  }
  return out;
}

function buildSuggestion({ key, label, description, advice }) {
  if (!advice || !['compare', 'switch_candidate'].includes(advice.decision) || !advice.candidate) return null;
  const mapping = SELECTOR_PATHS[key] || null;
  const chain = normalizeChain(description);
  const currentPrimary = chain[0] || null;
  const suggestedChain = moveCandidateFirst(chain, advice.candidate);

  return {
    key,
    label,
    decision: advice.decision,
    reason: advice.reason,
    candidate: advice.candidate,
    config: mapping?.config || null,
    path: mapping?.path || null,
    currentPrimary: currentPrimary ? `${currentPrimary.provider}/${currentPrimary.model}` : null,
    suggestedPrimary: suggestedChain[0] ? `${suggestedChain[0].provider}/${suggestedChain[0].model}` : null,
    suggestedChain,
  };
}

function collectSuggestions(report) {
  const suggestions = [];

  const push = (key, label, description, advice) => {
    const item = buildSuggestion({ key, label, description, advice });
    if (item) suggestions.push(item);
  };

  push('orchestrator.jay.intent', 'Jay Intent', report.jay?.intent, report.advice?.jay?.intent);
  push('orchestrator.jay.chat_fallback', 'Jay Chat Fallback', report.jay?.chatFallback, report.advice?.jay?.chatFallback);
  push('worker.ai.fallback', 'Worker AI Fallback', report.worker?.aiFallback, report.advice?.worker?.aiFallback);
  push('worker.chat.task_intake', 'Worker Task Intake', report.worker?.taskIntake, report.advice?.worker?.taskIntake);
  push('claude.archer.tech_analysis', 'Claude Archer', report.claude?.archer, report.advice?.claude?.archer);
  push('claude.lead.system_issue_triage', 'Claude Lead', report.claude?.lead, report.advice?.claude?.lead);
  push('claude.dexter.ai_analyst.warn', 'Dexter Warn', report.claude?.dexterWarn, report.advice?.claude?.dexterWarn);
  push('claude.dexter.ai_analyst.critical', 'Dexter Critical', report.claude?.dexterCritical, report.advice?.claude?.dexterCritical);
  push('blog.pos.writer', 'Blog POS Writer', report.blog?.pos, report.advice?.blog?.pos);
  push('blog.gems.writer', 'Blog GEMS Writer', report.blog?.gems, report.advice?.blog?.gems);
  push('blog.social.summarize', 'Blog Social Summarize', report.blog?.socialSummarize, report.advice?.blog?.socialSummarize);
  push('blog.social.caption', 'Blog Social Caption', report.blog?.socialCaption, report.advice?.blog?.socialCaption);
  push('blog.star.summarize', 'Blog STAR Summarize', report.blog?.starSummarize, report.advice?.blog?.starSummarize);
  push('blog.star.caption', 'Blog STAR Caption', report.blog?.starCaption, report.advice?.blog?.starCaption);
  push('blog.curriculum.recommend', 'Blog Curriculum Recommend', report.blog?.curriculumRecommend, report.advice?.blog?.curriculumRecommend);
  push('blog.curriculum.generate', 'Blog Curriculum Generate', report.blog?.curriculumGenerate, report.advice?.blog?.curriculumGenerate);

  return suggestions;
}

function formatSuggestion(item) {
  return [
    `- ${item.label} (${item.key})`,
    `  decision: ${item.decision}`,
    `  current: ${item.currentPrimary || '-'}`,
    `  candidate: ${item.candidate}`,
    `  config: ${item.config || '직접 매핑 필요'}`,
    `  path: ${item.path || '직접 매핑 필요'}`,
    `  reason: ${item.reason}`,
  ].join('\n');
}

function main() {
  const asJson = process.argv.includes('--json');
  const shouldWrite = process.argv.includes('--write');
  const report = runSelectorReportJson();
  const suggestions = collectSuggestions(report);
  return Promise.resolve().then(async () => {
    const saved = [];
    if (shouldWrite) {
      for (const item of suggestions) {
        // 운영 승인 전 단계이므로 추천 스냅샷만 저장한다.
        saved.push(await insertSelectorOverrideSuggestionLog(item));
      }
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      speedTest: report.speedTest || null,
      count: suggestions.length,
      write: shouldWrite,
      savedCount: saved.length,
      saved,
      suggestions,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (!suggestions.length) {
      console.log('LLM selector override 추천 없음\n- 현재 speed-test 기준으로 compare/switch_candidate 대상이 없습니다.');
      return;
    }

    const savedSummary = shouldWrite
      ? [`- 저장됨: ${saved.length}건`, ...saved.map((item) => `  - #${item.id} ${item.selector_key} (${item.review_status})`), '']
      : [];

    console.log([
      'LLM selector override 추천',
      report.speedTest
        ? `- 최근 speed-test: ${report.speedTest.capturedAt} | current=${report.speedTest.current || '-'} | recommended=${report.speedTest.recommended || '-'}`
        : '- 최근 speed-test: 없음',
      ...savedSummary,
      ...suggestions.map(formatSuggestion),
    ].join('\n'));
  });
}

try {
  Promise.resolve(main()).catch((error) => {
    console.error('[llm-selector-override-suggestions] 실패:', error.message);
    process.exit(1);
  });
} catch (error) {
  console.error('[llm-selector-override-suggestions] 실패:', error.message);
  process.exit(1);
}
