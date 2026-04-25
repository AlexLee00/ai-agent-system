import assert from 'node:assert/strict';

const ownership = require('../../../packages/core/lib/service-ownership.js');

const OPENCLAW_GATEWAY_LABEL = 'ai.openclaw.gateway';
const HUB_RESOURCE_API_LABEL = 'ai.hub.resource-api';

function main() {
  const coreLabels = ownership.getHubCoreServiceLabels();
  const hubLabels = ownership.getHubServiceLabels();
  const gateway = ownership.getServiceOwnership(OPENCLAW_GATEWAY_LABEL);
  const hub = ownership.getServiceOwnership(HUB_RESOURCE_API_LABEL);

  assert(!coreLabels.includes(OPENCLAW_GATEWAY_LABEL), 'OpenClaw gateway must not be a Hub core service');
  assert(!hubLabels.includes(OPENCLAW_GATEWAY_LABEL), 'OpenClaw gateway must not be part of Hub service readiness labels');
  assert.equal(gateway?.retired, true, 'OpenClaw gateway catalog entry must be retired');
  assert.equal(gateway?.optional, true, 'OpenClaw gateway catalog entry must be optional');
  assert.equal(gateway?.expectedIdle, true, 'OpenClaw gateway catalog entry must be expected-idle');
  assert(coreLabels.includes(HUB_RESOURCE_API_LABEL), 'Hub resource API must replace OpenClaw as a core service');
  assert(hubLabels.includes(HUB_RESOURCE_API_LABEL), 'Hub resource API must be part of Hub service readiness labels');
  assert.equal(hub?.core, true, 'Hub resource API catalog entry must be core');

  console.log(JSON.stringify({
    ok: true,
    openclaw_gateway_core: false,
    openclaw_gateway_hub_label: false,
    openclaw_gateway_retired: true,
    hub_resource_api_core: true,
  }));
}

main();
