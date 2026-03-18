'use strict';

const { getGatewayPrimaryModel } = require('../lib/jay-model-policy');
const {
  getOpenClawGatewayModelState,
  updateOpenClawGatewayPrimary,
} = require('../lib/openclaw-config');

function buildPayload() {
  const runtimePrimary = getGatewayPrimaryModel();
  const gatewayState = getOpenClawGatewayModelState();
  const candidateProfiles = [
    {
      key: 'gemini_stable',
      model: 'google-gemini-cli/gemini-2.5-flash',
      label: 'Gemini Flash 유지',
      pros: ['무료 OAuth 기반', '현재 운영 primary와 동일', '현재 정합성 점검 결과와 잘 맞음'],
      cons: ['rate limit burst 이력 존재', '제이 intent 모델과 공급자 축이 다름'],
      configured: gatewayState.availableProviders.includes('google-gemini-cli'),
    },
    {
      key: 'groq_speed',
      model: 'groq/openai/gpt-oss-20b',
      label: 'Groq GPT-OSS 전환',
      pros: ['자유대화 fallback 체인과 축이 맞음', '응답속도 개선 가능성'],
      cons: ['gateway 전역 primary 변경 영향 범위 큼', '명령형 GPT 분리 구조와는 별도 검증 필요'],
      configured: gatewayState.availableProviders.includes('groq'),
    },
    {
      key: 'anthropic_safe',
      model: 'anthropic/claude-haiku-4-5',
      label: 'Anthropic Haiku 전환',
      pros: ['짧은 운영 질의에 안정적', '비상용 품질 안전판 역할 가능'],
      cons: ['유료 호출', '현재 primary/fallback 체계와 비용 구조가 달라짐'],
      configured: gatewayState.availableProviders.includes('anthropic'),
    },
  ];
  const aligned = gatewayState.ok ? gatewayState.primary === runtimePrimary : false;
  const recommendation = aligned
    ? {
        action: 'hold',
        reason: '현재 runtime_config와 openclaw.json이 일치하고, 오케스트레이터 헬스도 안정 구간입니다. primary 변경보다 비교 기준을 더 쌓는 것이 우선입니다.',
      }
    : {
        action: 'sync_first',
        reason: '현재 기준값과 실제 OpenClaw primary가 다릅니다. 모델 변경 실험 전에 먼저 정합성을 맞춰야 합니다.',
      };
  const experimentCriteria = [
    {
      stage: 'hold',
      when: 'runtime_config와 openclaw.json이 일치하고, 오케스트레이터 health-report가 hold 구간일 때',
      focus: '현재 primary 유지, 제이 일일 LLM 리뷰와 gateway rate limit 재발 여부 관찰',
    },
    {
      stage: 'compare',
      when: 'gateway rate limit이 반복되거나, fallback 의존이 늘거나, 체감 응답속도 불만이 누적될 때',
      focus: 'Gemini 유지안과 Groq/Anthropic 후보를 비교한다. 핵심 지표는 응답시간, rate limit 빈도, fallback 진입률, 운영비용이다.',
    },
    {
      stage: 'switch',
      when: '비교 로그에서 대체 후보가 더 낮은 rate limit, 더 나은 응답시간 또는 더 안정적인 성공률을 보이고, 정합성 점검이 완료됐을 때',
      focus: 'runtime_config 변경 → openclaw.json 동기화(--apply) → 헬스/리뷰 재관찰 순서로 전환한다.',
    },
  ];
  return {
    runtimePrimary,
    openclawConfigReadable: gatewayState.ok,
    openclawPath: gatewayState.filePath,
    openclawPrimary: gatewayState.primary,
    openclawFallbackCount: gatewayState.fallbacks.length,
    availableProviders: gatewayState.availableProviders,
    aligned,
    recommendation,
    candidateProfiles,
    experimentCriteria,
    error: gatewayState.error || null,
  };
}

function printHuman(payload) {
  const lines = [
    '🤖 제이 gateway primary 점검',
    '',
    `runtime_config 기준: ${payload.runtimePrimary || '-'}`,
    `openclaw.json 기준: ${payload.openclawPrimary || '확인 불가'}`,
    `fallback 개수: ${payload.openclawFallbackCount}`,
    `정합성: ${payload.aligned ? '일치' : '불일치'}`,
    `사용 가능 provider: ${payload.availableProviders.length ? payload.availableProviders.join(', ') : '확인 불가'}`,
    `설정 파일: ${payload.openclawPath}`,
  ];
  if (payload.error) {
    lines.push(`오류: ${payload.error}`);
  }
  lines.push('');
  lines.push(`권장 판단: ${payload.recommendation.action}`);
  lines.push(`- ${payload.recommendation.reason}`);
  lines.push('');
  lines.push('후보 프로필:');
  for (const profile of payload.candidateProfiles) {
    lines.push(`- ${profile.label} (${profile.model})`);
    lines.push(`  configured: ${profile.configured ? 'yes' : 'no'}`);
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
  if (!payload.aligned) {
    lines.push('');
    lines.push('권장: runtime_config.jayModels.gatewayPrimary와 openclaw.json primary를 먼저 맞춘 뒤 운영 비교를 진행합니다.');
    lines.push('필요하면 --apply 로 openclaw.json primary를 runtime_config 기준으로 동기화할 수 있습니다.');
  }
  return lines.join('\n');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--apply')) {
    const runtimePrimary = getGatewayPrimaryModel();
    const result = updateOpenClawGatewayPrimary(runtimePrimary);
    console.log(`동기화 완료: ${result.primary}`);
    console.log(`설정 파일: ${result.filePath}`);
    return;
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
