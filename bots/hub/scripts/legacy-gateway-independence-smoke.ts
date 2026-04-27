import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ownership = require('../../../packages/core/lib/service-ownership.js');

const RETIRED_GATEWAY_ID = 'open' + 'claw';
const RETIRED_GATEWAY_WORD = 'Open' + 'Claw';
const RETIRED_GATEWAY_LABEL = ['ai', RETIRED_GATEWAY_ID, 'gateway'].join('.');
const RETIRED_MODEL_SYNC_LABEL = ['ai', RETIRED_GATEWAY_ID, 'model-sync'].join('.');
const HUB_RESOURCE_API_LABEL = 'ai.hub.resource-api';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HUB_NATIVE_RUNTIME_SURFACES = [
  'bots/orchestrator/lib/intent-parser.ts',
  'scripts/sync-openai-oauth.ts',
  'scripts/reviews/lib/jay-usage.ts',
  'scripts/reviews/llm-selector-speed-review.ts',
  'scripts/reviews/error-log-daily-review.ts',
  'scripts/reviews/jay-gateway-experiment-review.ts',
  'scripts/reviews/jay-gateway-change-compare.ts',
  'bots/orchestrator/scripts/enqueue-ska-reservation.ts',
  'bots/orchestrator/scripts/experience-store-cli.ts',
  'bots/reservation/scripts/log-rotate.ts',
  'bots/reservation/auto/monitors/start-ops.sh',
  'bots/reservation/scripts/e2e-test.ts',
  'scripts/setup-dev.sh',
  'scripts/disaster-recovery.sh',
  'scripts/migrate/01-push.sh',
  'scripts/migrate/02-setup.sh',
  'scripts/migrate/03-verify.sh',
  'scripts/migrate/README.md',
  'scripts/migration/backup-verify.ts',
  'scripts/migration/mac-mini-checklist.sh',
  'scripts/chaos/test-emergency-mode.sh',
  'scripts/build-ts-phase1.mjs',
  'scripts/lib/deployer.ts',
  'scripts/weekly-team-report.ts',
  'scripts/llm-usage-unified-report.ts',
  'packages/core/lib/telegram-sender.ts',
  'bots/investment/shared/alert-publisher.ts',
  'bots/investment/shared/report.ts',
  'bots/orchestrator/src/router.ts',
];

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function main() {
  const coreLabels = ownership.getHubCoreServiceLabels();
  const hubLabels = ownership.getHubServiceLabels();
  const gateway = ownership.getServiceOwnership(RETIRED_GATEWAY_LABEL);
  const hub = ownership.getServiceOwnership(HUB_RESOURCE_API_LABEL);
  const postReboot = readRepoFile('scripts/post-reboot.sh');
  const preReboot = readRepoFile('scripts/pre-reboot.sh');
  const registryText = readRepoFile('bots/registry.json');
  const registry = JSON.parse(registryText);
  const autoCommit = readRepoFile('scripts/auto-commit.sh');
  const autoCommitPlist = readRepoFile('scripts/launchd/ai.agent.auto-commit.plist');
  const secretsRoute = readRepoFile('bots/hub/lib/routes/secrets.ts');

  assert(!coreLabels.includes(RETIRED_GATEWAY_LABEL), 'retired gateway must not be a Hub core service');
  assert(!hubLabels.includes(RETIRED_GATEWAY_LABEL), 'retired gateway must not be part of Hub service readiness labels');
  assert.equal(gateway?.retired, true, `${RETIRED_GATEWAY_WORD} gateway catalog entry must be retired`);
  assert.equal(gateway?.optional, true, `${RETIRED_GATEWAY_WORD} gateway catalog entry must be optional`);
  assert.equal(gateway?.expectedIdle, true, `${RETIRED_GATEWAY_WORD} gateway catalog entry must be expected-idle`);
  assert(coreLabels.includes(HUB_RESOURCE_API_LABEL), `Hub resource API must replace ${RETIRED_GATEWAY_WORD} as a core service`);
  assert(hubLabels.includes(HUB_RESOURCE_API_LABEL), 'Hub resource API must be part of Hub service readiness labels');
  assert.equal(hub?.core, true, 'Hub resource API catalog entry must be core');
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, `scripts/launchd/${RETIRED_GATEWAY_LABEL}.plist`)),
    false,
    'retired gateway launchd template must not remain in the repository',
  );
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, `scripts/launchd/${RETIRED_MODEL_SYNC_LABEL}.plist`)),
    false,
    'retired model-sync launchd template must not remain in the repository',
  );
  assert(!postReboot.includes(RETIRED_GATEWAY_LABEL), 'post-reboot must not check retired gateway');
  assert(!postReboot.includes(RETIRED_MODEL_SYNC_LABEL), 'post-reboot must not check retired model-sync');
  assert(!preReboot.includes(RETIRED_GATEWAY_LABEL), 'pre-reboot must not stop retired gateway');
  assert(!preReboot.includes(RETIRED_MODEL_SYNC_LABEL), 'pre-reboot must not stop retired model-sync');
  assert(!registryText.includes(`~/.${RETIRED_GATEWAY_ID}`), `bot registry must not point runtime state/deploy targets at ~/.${RETIRED_GATEWAY_ID}`);
  for (const [botId, bot] of Object.entries(registry.bots || {})) {
    const deployTargets = Array.isArray((bot as any).deployTargets) ? (bot as any).deployTargets : [];
    assert(
      !deployTargets.some((target: any) => target?.type === RETIRED_GATEWAY_ID),
      `bot registry must not keep active ${RETIRED_GATEWAY_WORD} deploy target: ${botId}`,
    );
  }
  assert(!autoCommit.includes(`.${RETIRED_GATEWAY_ID}`), 'auto-commit script must write logs under Hub-native AI_AGENT_LOGS');
  assert(!autoCommitPlist.includes(`.${RETIRED_GATEWAY_ID}`), 'auto-commit launchd plist must write logs under Hub-native path');
  assert(!secretsRoute.includes('legacy_gateway'), 'Hub secrets route must not expose retired gateway category');
  assert(!secretsRoute.includes('retiredGatewaySecrets'), 'Hub secrets route must not keep retired gateway handler');
  assert(!secretsRoute.includes("open${'claw'}"), `Hub secrets route must not expose retired ${RETIRED_GATEWAY_WORD} category alias`);
  assert(!secretsRoute.includes(`store?.${RETIRED_GATEWAY_ID}`), `Hub secrets route must not load retired ${RETIRED_GATEWAY_WORD} token store`);
  assert(!secretsRoute.includes('d.gateway_token'), `Hub secrets route must not expose retired ${RETIRED_GATEWAY_WORD} gateway token`);
  for (const relPath of HUB_NATIVE_RUNTIME_SURFACES) {
    const content = readRepoFile(relPath);
    const retiredGatewayRuntimePattern = new RegExp(`\\.${RETIRED_GATEWAY_LABEL}|${'OPEN' + 'CLAW_'}|${RETIRED_GATEWAY_LABEL}`, 'i');
    assert(!retiredGatewayRuntimePattern.test(content), `${relPath} must not depend on retired gateway runtime names`);
    assert(!new RegExp('오픈' + '클로').test(content), `${relPath} must not expose ${RETIRED_GATEWAY_WORD} Korean command aliases`);
  }

  console.log(JSON.stringify({
    ok: true,
    legacy_gateway_core: false,
    legacy_gateway_hub_label: false,
    legacy_gateway_retired: true,
    legacy_gateway_launchd_templates_removed: true,
    reboot_scripts_legacy_gateway_free: true,
    registry_legacy_gateway_free: true,
    auto_commit_legacy_gateway_free: true,
    legacy_gateway_secret_tokens_retired: true,
    hub_native_runtime_surfaces: HUB_NATIVE_RUNTIME_SURFACES.length,
    hub_resource_api_core: true,
  }));
}

main();
