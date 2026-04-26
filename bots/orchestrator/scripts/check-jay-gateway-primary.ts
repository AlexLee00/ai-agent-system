// @ts-nocheck
'use strict';

const {
  getGatewayPrimaryModel,
  buildIntentParsePolicy,
  buildJayChatFallbackChain,
} = require('../lib/jay-model-policy');

function formatSelectorEntry(entry = {}) {
  const provider = String(entry.provider || entry.route || '').trim();
  const model = String(entry.model || '').trim();
  if (provider && model && model.startsWith(`${provider}/`)) return model;
  if (provider && model) return `${provider}/${model}`;
  return provider || model || 'unknown';
}

function buildCandidateProfiles(chain) {
  const chainRoutes = new Set(chain.map(formatSelectorEntry));
  const candidates = [
    {
      key: 'hub_selector_current',
      model: getGatewayPrimaryModel(),
      label: '현재 Hub selector primary 유지',
      pros: ['Hub → team selector → agent 표준 경로와 일치', 'retired gateway 설정 동기화가 필요 없음'],
      cons: ['전환 전후 비교 지표는 Hub selector 로그 기준으로 다시 축적 필요'],
    },
    {
      key: 'groq_speed',
      model: 'groq/openai/gpt-oss-20b',
      label: 'Groq speed lane 관찰',
      pros: ['저지연 후보', 'fallback burst 관찰에 적합'],
      cons: ['provider cooldown이 누적되면 자동 우회 필요'],
    },
    {
      key: 'openai_oauth',
      model: 'openai-oauth/gpt-4o-mini',
      label: 'OpenAI OAuth lane 관찰',
      pros: ['Hub OAuth 직접 호출 검증 대상', '운영 요약/분류에 안정적'],
      cons: ['계정 scope와 budget 상태를 별도 health로 확인해야 함'],
    },
    {
      key: 'claude_code_oauth',
      model: 'claude-code/sonnet',
      label: 'Claude Code OAuth lane 관찰',
      pros: ['코드/운영 분석 quality lane', 'Hub 직접 OAuth 전환 목표와 일치'],
      cons: ['CLI/OAuth store 상태와 cooldown을 함께 관찰해야 함'],
    },
  ];

  return candidates.map((candidate) => {
    const configured = chainRoutes.has(candidate.model) || candidate.model === getGatewayPrimaryModel();
    return {
      ...candidate,
      configured,
      authReady: configured,
    };
  });
}

function buildPayload() {
  const runtimePrimary = getGatewayPrimaryModel();
  const intentPolicy = buildIntentParsePolicy();
  const chatFallbackChain = buildJayChatFallbackChain();
  const selectorRoutes = chatFallbackChain.map(formatSelectorEntry);
  const candidateProfiles = buildCandidateProfiles(chatFallbackChain);
  const readyFallbacks = selectorRoutes.filter(Boolean);

  return {
    retiredGateway: true,
    runtimePrimary,
    selectorPrimary: runtimePrimary,
    selectorKey: 'orchestrator.jay.chat_fallback',
    intentSelectorKey: 'orchestrator.jay.intent',
    intentPolicy,
    chatFallbackChain,
    selectorRoutes,
    fallbackCount: selectorRoutes.length,
    readyFallbackCount: readyFallbacks.length,
    unreadyFallbackCount: 0,
    readyFallbacks,
    unreadyFallbacks: [],
    availableProviders: Array.from(new Set(chatFallbackChain.map((entry) => entry.provider).filter(Boolean))),
    readyProviders: Array.from(new Set(chatFallbackChain.map((entry) => entry.provider).filter(Boolean))),
    aligned: true,
    recommendation: {
      action: 'use_hub_selector',
      reason: 'Jay 모델 경로는 Hub → team selector → agent 표준 경로로 고정합니다. retired gateway 설정 파일과 동기화하지 않습니다.',
    },
    candidateProfiles,
    experimentCriteria: [
      {
        stage: 'hold',
        when: 'Hub selector chain이 정상 응답하고 provider cooldown이 짧은 시간 내 복구될 때',
        focus: '현재 selector 유지, 팀별 LLM 호출 성공률과 cooldown 재발 여부 관찰',
      },
      {
        stage: 'compare',
        when: 'fallback 의존이 늘거나 특정 provider cooldown이 반복될 때',
        focus: 'Hub selector override 후보를 비교한다. 핵심 지표는 latency, cooldown 빈도, fallback 진입률, 비용이다.',
      },
      {
        stage: 'switch',
        when: '대체 후보가 더 안정적인 성공률과 낮은 cooldown을 보이고 회귀 스모크가 통과할 때',
        focus: 'runtime_config/selector override 변경 → Hub LLM smoke → 팀별 호출 테스트 순서로 전환한다.',
      },
    ],
    error: null,
  };
}

function printHuman(payload) {
  const lines = [
    '🤖 제이 Hub selector primary 점검',
    '',
    `runtime_config 기준: ${payload.runtimePrimary || '-'}`,
    `selector key: ${payload.selectorKey}`,
    `fallback 개수: ${payload.fallbackCount}`,
    `ready fallback 개수: ${payload.readyFallbackCount}`,
    `정합성: ${payload.aligned ? '표준 경로 사용' : '확인 필요'}`,
    `사용 가능 provider: ${payload.availableProviders.length ? payload.availableProviders.join(', ') : '없음'}`,
    '',
    `권장 판단: ${payload.recommendation.action}`,
    `- ${payload.recommendation.reason}`,
    '',
    '현재 selector chain:',
  ];
  for (const route of payload.selectorRoutes) {
    lines.push(`- ${route}`);
  }
  lines.push('');
  lines.push('후보 프로필:');
  for (const profile of payload.candidateProfiles) {
    lines.push(`- ${profile.label} (${profile.model})`);
    lines.push(`  configured: ${profile.configured ? 'yes' : 'no'}`);
    lines.push(`  authReady: ${profile.authReady ? 'yes' : 'no'}`);
    lines.push(`  pros: ${profile.pros.join(' / ')}`);
    lines.push(`  cons: ${profile.cons.join(' / ')}`);
  }
  lines.push('');
  lines.push('전환 실험 기준:');
  for (const criterion of payload.experimentCriteria) {
    lines.push(`- ${criterion.stage}`);
    lines.push(`  when: ${criterion.when}`);
    lines.push(`  focus: ${criterion.focus}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--apply')) {
    throw new Error('retired gateway 설정 동기화는 비활성화되었습니다. Hub selector override 경로를 사용하세요.');
  }

  const payload = buildPayload();
  if (args.has('--json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(printHuman(payload));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ check-jay-gateway-primary 실패: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildPayload,
  printHuman,
};
