'use strict';

const { getGatewayPrimaryModel } = require('../lib/jay-model-policy');
const {
  getOpenClawGatewayModelState,
  updateOpenClawGatewayPrimary,
} = require('../lib/openclaw-config');

function buildPayload() {
  const runtimePrimary = getGatewayPrimaryModel();
  const gatewayState = getOpenClawGatewayModelState();
  return {
    runtimePrimary,
    openclawConfigReadable: gatewayState.ok,
    openclawPath: gatewayState.filePath,
    openclawPrimary: gatewayState.primary,
    openclawFallbackCount: gatewayState.fallbacks.length,
    aligned: gatewayState.ok ? gatewayState.primary === runtimePrimary : false,
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
    `설정 파일: ${payload.openclawPath}`,
  ];
  if (payload.error) {
    lines.push(`오류: ${payload.error}`);
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
