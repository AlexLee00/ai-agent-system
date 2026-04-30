// @ts-nocheck
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const {
  describeLLMSelector,
  buildSpeedLookup,
  buildSelectorAdvice,
  loadLatestSpeedSnapshot,
} = require(path.join(__dirname, '../packages/core/lib/llm-control/service'));

const orchestratorRuntime = require(path.join(__dirname, '../bots/orchestrator/lib/runtime-config'));
const blogRuntime = require(path.join(__dirname, '../bots/blog/lib/runtime-config'));
const claudeConfig = require(path.join(__dirname, '../bots/claude/lib/config'));

async function getInvestmentPolicyOverrideSafe() {
  try {
    const moduleUrl = pathToFileURL(path.join(__dirname, '../bots/investment/shared/runtime-config.js')).href;
    const mod = await import(moduleUrl);
    return mod.getInvestmentLLMPolicyConfig().investmentAgentPolicy || null;
  } catch {
    return null;
  }
}

function attachSpeed(entry, speedLookup) {
  const speed = speedLookup?.get(entry.model) || null;
  return speed ? { ...entry, speed } : entry;
}

function formatChainEntry(entry, index) {
  const speed = entry.speed
    ? ` | speed=${entry.speed.ok ? `${entry.speed.ttft ?? '-'}ms/${entry.speed.total ?? '-'}ms` : `fail(${entry.speed.error || 'error'})`}`
    : '';
  return `${index === 0 ? 'primary' : `fallback${index}`}: ${entry.provider} / ${entry.model}${entry.maxTokens ? ` | maxTokens=${entry.maxTokens}` : ''}${entry.temperature != null ? ` | temperature=${entry.temperature}` : ''}${speed}`;
}

function formatSelectorBlock(title, description, speedLookup) {
  const advice = buildSelectorAdvice(description, speedLookup);
  if (description.kind === 'chain') {
    return [
      `## ${title}`,
      ...description.chain.map((entry, index) => formatChainEntry(attachSpeed(entry, speedLookup), index)),
      `advice: ${advice.decision}${advice.candidate ? ` | candidate=${advice.candidate}` : ''} | ${advice.reason}`,
      '',
    ].join('\n');
  }

  if (description.kind === 'policy') {
    const policy = description.policy || {};
    const lines = [`## ${title}`];
    if (policy.route) lines.push(`route: ${policy.route}`);
    if (policy.primary) lines.push(formatChainEntry(attachSpeed(policy.primary, speedLookup), 0));
    if (Array.isArray(policy.fallbacks)) {
      lines.push(...policy.fallbacks.map((entry, index) => formatChainEntry(attachSpeed(entry, speedLookup), index + 1)));
    }
    if (!policy.primary && !Array.isArray(policy.fallbacks)) {
      lines.push(JSON.stringify(policy, null, 2));
    }
    lines.push(`advice: ${advice.decision}${advice.candidate ? ` | candidate=${advice.candidate}` : ''} | ${advice.reason}`);
    lines.push('');
    return lines.join('\n');
  }

  return `## ${title}\n(unknown)\n`;
}

async function buildReport() {
  const jayOverrides = orchestratorRuntime.getLLMSelectorOverrides();
  const blogOverrides = blogRuntime.getBlogLLMSelectorOverrides();
  const claudeOverrides = claudeConfig.RUNTIME?.llmSelectorOverrides || {};
  const investmentPolicyOverride = await getInvestmentPolicyOverrideSafe();
  const speedSnapshot = loadLatestSpeedSnapshot();
  const speedLookup = buildSpeedLookup(speedSnapshot);

  const blocks = [
    '# LLM Selector Report',
    '',
    speedSnapshot
      ? `최근 speed-test: ${speedSnapshot.capturedAt} | current=${speedSnapshot.current || '-'} | recommended=${speedSnapshot.recommended || '-'}`
      : '최근 speed-test: 없음',
    '',
    formatSelectorBlock('Jay Intent', describeLLMSelector('orchestrator.jay.intent', {
      policyOverride: jayOverrides['orchestrator.jay.intent'],
    }), speedLookup),
    formatSelectorBlock('Jay Chat Fallback', describeLLMSelector('orchestrator.jay.chat_fallback', {
      policyOverride: jayOverrides['orchestrator.jay.chat_fallback'],
    }), speedLookup),
    formatSelectorBlock('Claude Archer', describeLLMSelector('claude.archer.tech_analysis', {
      policyOverride: claudeOverrides['claude.archer.tech_analysis'],
    }), speedLookup),
    formatSelectorBlock('Claude Lead', describeLLMSelector('claude.lead.system_issue_triage', {
      policyOverride: claudeOverrides['claude.lead.system_issue_triage'],
    }), speedLookup),
    formatSelectorBlock('Dexter Analyst (warn/error)', describeLLMSelector('claude.dexter.ai_analyst', {
      level: 2,
      policyOverride: claudeOverrides['claude.dexter.ai_analyst'] || null,
    }), speedLookup),
    formatSelectorBlock('Dexter Analyst (critical)', describeLLMSelector('claude.dexter.ai_analyst', {
      level: 4,
      policyOverride: claudeOverrides['claude.dexter.ai_analyst'] || null,
    }), speedLookup),
    formatSelectorBlock('Blog POS Writer', describeLLMSelector('blog.pos.writer', {
      policyOverride: blogOverrides['blog.pos.writer'],
    }), speedLookup),
    formatSelectorBlock('Blog GEMS Writer', describeLLMSelector('blog.gems.writer', {
      policyOverride: blogOverrides['blog.gems.writer'],
    }), speedLookup),
    formatSelectorBlock('Blog Social Summarize', describeLLMSelector('blog.social.summarize', {
      policyOverride: blogOverrides['blog.social.summarize'],
    }), speedLookup),
    formatSelectorBlock('Blog Social Caption', describeLLMSelector('blog.social.caption', {
      policyOverride: blogOverrides['blog.social.caption'],
    }), speedLookup),
    formatSelectorBlock('Blog STAR Summarize', describeLLMSelector('blog.star.summarize', {
      policyOverride: blogOverrides['blog.star.summarize'],
    }), speedLookup),
    formatSelectorBlock('Blog STAR Caption', describeLLMSelector('blog.star.caption', {
      policyOverride: blogOverrides['blog.star.caption'],
    }), speedLookup),
    formatSelectorBlock('Blog Curriculum Recommend', describeLLMSelector('blog.curriculum.recommend', {
      policyOverride: blogOverrides['blog.curriculum.recommend'],
    }), speedLookup),
    formatSelectorBlock('Blog Curriculum Generate', describeLLMSelector('blog.curriculum.generate', {
      policyOverride: blogOverrides['blog.curriculum.generate'],
    }), speedLookup),
  ];

  const investmentAgents = ['luna', 'nemesis', 'oracle', 'hermes', 'sophia', 'zeus', 'athena', 'argos'];
  const investmentBlocks = investmentAgents.map((agentName) =>
    formatSelectorBlock(`Investment ${agentName}`, describeLLMSelector('investment.agent_policy', {
      agentName,
      policyOverride: investmentPolicyOverride,
    }), speedLookup));

  return [...blocks, ...investmentBlocks].join('\n');
}

async function main() {
  const asJson = process.argv.includes('--json');
  const report = await buildReport();
  if (!asJson) {
    console.log(report);
    return;
  }

  const investmentPolicyOverride = await getInvestmentPolicyOverrideSafe();
  const speedSnapshot = loadLatestSpeedSnapshot();
  const speedLookup = buildSpeedLookup(speedSnapshot);
  const payload = {
    speedTest: speedSnapshot,
    jay: {
      intent: describeLLMSelector('orchestrator.jay.intent', {
        policyOverride: orchestratorRuntime.getLLMSelectorOverrides()['orchestrator.jay.intent'],
      }),
      chatFallback: describeLLMSelector('orchestrator.jay.chat_fallback', {
        policyOverride: orchestratorRuntime.getLLMSelectorOverrides()['orchestrator.jay.chat_fallback'],
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
        policyOverride: claudeConfig.RUNTIME?.llmSelectorOverrides?.['claude.dexter.ai_analyst'] || null,
      }),
      dexterCritical: describeLLMSelector('claude.dexter.ai_analyst', {
        level: 4,
        policyOverride: claudeConfig.RUNTIME?.llmSelectorOverrides?.['claude.dexter.ai_analyst'] || null,
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
  payload.advice = {
    jay: {
      intent: buildSelectorAdvice(payload.jay.intent, speedLookup),
      chatFallback: buildSelectorAdvice(payload.jay.chatFallback, speedLookup),
    },
    claude: {
      archer: buildSelectorAdvice(payload.claude.archer, speedLookup),
      lead: buildSelectorAdvice(payload.claude.lead, speedLookup),
      dexterWarn: buildSelectorAdvice(payload.claude.dexterWarn, speedLookup),
      dexterCritical: buildSelectorAdvice(payload.claude.dexterCritical, speedLookup),
    },
    blog: {
      pos: buildSelectorAdvice(payload.blog.pos, speedLookup),
      gems: buildSelectorAdvice(payload.blog.gems, speedLookup),
      socialSummarize: buildSelectorAdvice(payload.blog.socialSummarize, speedLookup),
      socialCaption: buildSelectorAdvice(payload.blog.socialCaption, speedLookup),
      starSummarize: buildSelectorAdvice(payload.blog.starSummarize, speedLookup),
      starCaption: buildSelectorAdvice(payload.blog.starCaption, speedLookup),
      curriculumRecommend: buildSelectorAdvice(payload.blog.curriculumRecommend, speedLookup),
      curriculumGenerate: buildSelectorAdvice(payload.blog.curriculumGenerate, speedLookup),
    },
    investment: Object.fromEntries(
      Object.entries(payload.investment).map(([agent, description]) => [agent, buildSelectorAdvice(description, speedLookup)])
    ),
  };
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error('[llm-selector-report] 실패:', error.message);
  process.exit(1);
});
