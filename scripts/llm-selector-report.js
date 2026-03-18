'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const {
  describeLLMSelector,
} = require(path.join(__dirname, '../packages/core/lib/llm-model-selector'));

const orchestratorRuntime = require(path.join(__dirname, '../bots/orchestrator/lib/runtime-config'));
const workerRuntime = require(path.join(__dirname, '../bots/worker/lib/runtime-config'));
const blogRuntime = require(path.join(__dirname, '../bots/blog/lib/runtime-config'));
const claudeConfig = require(path.join(__dirname, '../bots/claude/lib/config'));

async function getWorkerPreferredApiSafe() {
  try {
    const { getWorkerMonitoringPreference } = require(path.join(__dirname, '../bots/worker/lib/llm-api-monitoring'));
    return await getWorkerMonitoringPreference();
  } catch {
    return 'groq';
  }
}

async function getInvestmentPolicyOverrideSafe() {
  try {
    const moduleUrl = pathToFileURL(path.join(__dirname, '../bots/investment/shared/runtime-config.js')).href;
    const mod = await import(moduleUrl);
    return mod.getInvestmentLLMPolicyConfig().investmentAgentPolicy || null;
  } catch {
    return null;
  }
}

function formatChainEntry(entry, index) {
  return `${index === 0 ? 'primary' : `fallback${index}`}: ${entry.provider} / ${entry.model}${entry.maxTokens ? ` | maxTokens=${entry.maxTokens}` : ''}${entry.temperature != null ? ` | temperature=${entry.temperature}` : ''}`;
}

function formatSelectorBlock(title, description) {
  if (description.kind === 'chain') {
    return [
      `## ${title}`,
      ...description.chain.map((entry, index) => formatChainEntry(entry, index)),
      '',
    ].join('\n');
  }

  if (description.kind === 'policy') {
    const policy = description.policy || {};
    const lines = [`## ${title}`];
    if (policy.route) lines.push(`route: ${policy.route}`);
    if (policy.primary) lines.push(formatChainEntry(policy.primary, 0));
    if (Array.isArray(policy.fallbacks)) {
      lines.push(...policy.fallbacks.map((entry, index) => formatChainEntry(entry, index + 1)));
    }
    if (!policy.primary && !Array.isArray(policy.fallbacks)) {
      lines.push(JSON.stringify(policy, null, 2));
    }
    lines.push('');
    return lines.join('\n');
  }

  return `## ${title}\n(unknown)\n`;
}

async function buildReport() {
  const jayOverrides = orchestratorRuntime.getLLMSelectorOverrides();
  const workerOverrides = workerRuntime.getWorkerLLMSelectorOverrides();
  const blogOverrides = blogRuntime.getBlogLLMSelectorOverrides();
  const claudeOverrides = claudeConfig.RUNTIME?.llmSelectorOverrides || {};
  const workerPreferredApi = await getWorkerPreferredApiSafe();
  const investmentPolicyOverride = await getInvestmentPolicyOverrideSafe();

  const blocks = [
    '# LLM Selector Report',
    '',
    formatSelectorBlock('Jay Intent', describeLLMSelector('orchestrator.jay.intent', {
      policyOverride: jayOverrides['orchestrator.jay.intent'],
    })),
    formatSelectorBlock('Jay Chat Fallback', describeLLMSelector('orchestrator.jay.chat_fallback', {
      policyOverride: jayOverrides['orchestrator.jay.chat_fallback'],
    })),
    formatSelectorBlock(`Worker AI Fallback (preferredApi=${workerPreferredApi})`, describeLLMSelector('worker.ai.fallback', {
      preferredApi: workerPreferredApi,
      configuredProviders: ['groq', 'anthropic', 'gemini', 'openai'],
      policyOverride: workerOverrides['worker.ai.fallback'],
    })),
    formatSelectorBlock('Worker Chat Task Intake', describeLLMSelector('worker.chat.task_intake', {
      policyOverride: workerOverrides['worker.chat.task_intake'],
    })),
    formatSelectorBlock('Claude Archer', describeLLMSelector('claude.archer.tech_analysis', {
      policyOverride: claudeOverrides['claude.archer.tech_analysis'],
    })),
    formatSelectorBlock('Claude Lead', describeLLMSelector('claude.lead.system_issue_triage', {
      policyOverride: claudeOverrides['claude.lead.system_issue_triage'],
    })),
    formatSelectorBlock('Dexter Analyst (warn/error)', describeLLMSelector('claude.dexter.ai_analyst', {
      level: 2,
      policyOverride: claudeOverrides['claude.dexter.ai_analyst']
        ? { model: claudeOverrides['claude.dexter.ai_analyst'].lowModel || 'gpt-4o-mini' }
        : null,
    })),
    formatSelectorBlock('Dexter Analyst (critical)', describeLLMSelector('claude.dexter.ai_analyst', {
      level: 4,
      policyOverride: claudeOverrides['claude.dexter.ai_analyst']
        ? { model: claudeOverrides['claude.dexter.ai_analyst'].highModel || 'gpt-4o' }
        : null,
    })),
    formatSelectorBlock('Blog POS Writer', describeLLMSelector('blog.pos.writer', {
      policyOverride: blogOverrides['blog.pos.writer'],
    })),
    formatSelectorBlock('Blog GEMS Writer', describeLLMSelector('blog.gems.writer', {
      policyOverride: blogOverrides['blog.gems.writer'],
    })),
    formatSelectorBlock('Blog Social Summarize', describeLLMSelector('blog.social.summarize', {
      policyOverride: blogOverrides['blog.social.summarize'],
    })),
    formatSelectorBlock('Blog Social Caption', describeLLMSelector('blog.social.caption', {
      policyOverride: blogOverrides['blog.social.caption'],
    })),
    formatSelectorBlock('Blog STAR Summarize', describeLLMSelector('blog.star.summarize', {
      policyOverride: blogOverrides['blog.star.summarize'],
    })),
    formatSelectorBlock('Blog STAR Caption', describeLLMSelector('blog.star.caption', {
      policyOverride: blogOverrides['blog.star.caption'],
    })),
    formatSelectorBlock('Blog Curriculum Recommend', describeLLMSelector('blog.curriculum.recommend', {
      policyOverride: blogOverrides['blog.curriculum.recommend'],
    })),
    formatSelectorBlock('Blog Curriculum Generate', describeLLMSelector('blog.curriculum.generate', {
      policyOverride: blogOverrides['blog.curriculum.generate'],
    })),
  ];

  const investmentAgents = ['luna', 'nemesis', 'oracle', 'hermes', 'sophia', 'zeus', 'athena', 'argos'];
  const investmentBlocks = investmentAgents.map((agentName) =>
    formatSelectorBlock(`Investment ${agentName}`, describeLLMSelector('investment.agent_policy', {
      agentName,
      policyOverride: investmentPolicyOverride,
    })));

  return [...blocks, ...investmentBlocks].join('\n');
}

async function main() {
  const asJson = process.argv.includes('--json');
  const report = await buildReport();
  if (!asJson) {
    console.log(report);
    return;
  }

  const workerPreferredApi = await getWorkerPreferredApiSafe();
  const investmentPolicyOverride = await getInvestmentPolicyOverrideSafe();
  const payload = {
    jay: {
      intent: describeLLMSelector('orchestrator.jay.intent', {
        policyOverride: orchestratorRuntime.getLLMSelectorOverrides()['orchestrator.jay.intent'],
      }),
      chatFallback: describeLLMSelector('orchestrator.jay.chat_fallback', {
        policyOverride: orchestratorRuntime.getLLMSelectorOverrides()['orchestrator.jay.chat_fallback'],
      }),
    },
    worker: {
      preferredApi: workerPreferredApi,
      aiFallback: describeLLMSelector('worker.ai.fallback', {
        preferredApi: workerPreferredApi,
        configuredProviders: ['groq', 'anthropic', 'gemini', 'openai'],
        policyOverride: workerRuntime.getWorkerLLMSelectorOverrides()['worker.ai.fallback'],
      }),
      taskIntake: describeLLMSelector('worker.chat.task_intake', {
        policyOverride: workerRuntime.getWorkerLLMSelectorOverrides()['worker.chat.task_intake'],
      }),
    },
    claude: {
      archer: describeLLMSelector('claude.archer.tech_analysis', {
        policyOverride: claudeConfig.RUNTIME?.llmSelectorOverrides?.['claude.archer.tech_analysis'],
      }),
      lead: describeLLMSelector('claude.lead.system_issue_triage', {
        policyOverride: claudeConfig.RUNTIME?.llmSelectorOverrides?.['claude.lead.system_issue_triage'],
      }),
      dexterWarn: describeLLMSelector('claude.dexter.ai_analyst', {
        level: 2,
        policyOverride: claudeConfig.RUNTIME?.llmSelectorOverrides?.['claude.dexter.ai_analyst']
          ? { model: claudeConfig.RUNTIME.llmSelectorOverrides['claude.dexter.ai_analyst'].lowModel || 'gpt-4o-mini' }
          : null,
      }),
      dexterCritical: describeLLMSelector('claude.dexter.ai_analyst', {
        level: 4,
        policyOverride: claudeConfig.RUNTIME?.llmSelectorOverrides?.['claude.dexter.ai_analyst']
          ? { model: claudeConfig.RUNTIME.llmSelectorOverrides['claude.dexter.ai_analyst'].highModel || 'gpt-4o' }
          : null,
      }),
    },
    blog: {
      pos: describeLLMSelector('blog.pos.writer', { policyOverride: blogRuntime.getBlogLLMSelectorOverrides()['blog.pos.writer'] }),
      gems: describeLLMSelector('blog.gems.writer', { policyOverride: blogRuntime.getBlogLLMSelectorOverrides()['blog.gems.writer'] }),
      socialSummarize: describeLLMSelector('blog.social.summarize', { policyOverride: blogRuntime.getBlogLLMSelectorOverrides()['blog.social.summarize'] }),
      socialCaption: describeLLMSelector('blog.social.caption', { policyOverride: blogRuntime.getBlogLLMSelectorOverrides()['blog.social.caption'] }),
      starSummarize: describeLLMSelector('blog.star.summarize', { policyOverride: blogRuntime.getBlogLLMSelectorOverrides()['blog.star.summarize'] }),
      starCaption: describeLLMSelector('blog.star.caption', { policyOverride: blogRuntime.getBlogLLMSelectorOverrides()['blog.star.caption'] }),
      curriculumRecommend: describeLLMSelector('blog.curriculum.recommend', { policyOverride: blogRuntime.getBlogLLMSelectorOverrides()['blog.curriculum.recommend'] }),
      curriculumGenerate: describeLLMSelector('blog.curriculum.generate', { policyOverride: blogRuntime.getBlogLLMSelectorOverrides()['blog.curriculum.generate'] }),
    },
    investment: Object.fromEntries(
      ['luna', 'nemesis', 'oracle', 'hermes', 'sophia', 'zeus', 'athena', 'argos']
        .map((agent) => [agent, describeLLMSelector('investment.agent_policy', { agentName: agent, policyOverride: investmentPolicyOverride })])
    ),
  };
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error('[llm-selector-report] 실패:', error.message);
  process.exit(1);
});
