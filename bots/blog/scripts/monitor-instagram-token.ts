'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const {
  getInstagramTokenConfig,
  getTokenHealth,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-token-manager.ts'));
const {
  getInstagramImageHostConfig,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts'));
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));

/**
 * @typedef {{
 *   tokenHealth: {
 *     tokenExpiresAt?: string | null,
 *     daysLeft?: number | null,
 *     critical?: boolean,
 *     needsRefresh?: boolean,
 *   },
 *   host: {
 *     mode?: string,
 *     ready: boolean,
 *     relativePrefix?: string,
 *   }
 * }} InstagramMonitorPayload
 */

/**
 * @typedef {{
 *   dryRun: boolean,
 *   json: boolean,
 * }} MonitorArgs
 */

/**
 * @param {string[]} [argv]
 * @returns {MonitorArgs}
 */
function parseArgs(argv = []) {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

/** @returns {InstagramMonitorPayload} */
function buildStatusPayload() {
  const tokenConfig = getInstagramTokenConfig();
  const tokenHealth = getTokenHealth(tokenConfig);
  const hostConfig = getInstagramImageHostConfig();
  const hostReady = Boolean(
    hostConfig.publicBaseUrl
    || hostConfig.githubPagesBaseUrl
    || hostConfig.opsStaticBaseUrl
  );

  return {
    tokenHealth,
    host: {
      mode: hostConfig.mode || 'unconfigured',
      ready: hostReady,
      relativePrefix: hostConfig.relativePrefix || 'blog-assets/instagram',
    },
  };
}

/**
 * @param {InstagramMonitorPayload} payload
 * @returns {string}
 */
function buildAlertMessage(payload) {
  const lines = [
    `토큰 만료일: ${payload.tokenHealth.tokenExpiresAt || '미설정'}`,
    `남은 일수: ${payload.tokenHealth.daysLeft ?? '알 수 없음'}`,
    `공개 미디어 호스팅: ${payload.host.ready ? `준비됨 (${payload.host.mode})` : '미준비'}`,
  ];
  return lines.join('\n');
}

/**
 * @param {InstagramMonitorPayload} payload
 * @param {MonitorArgs} options
 */
async function maybeSendAlert(payload, options) {
  const { tokenHealth, host } = payload;
  const shouldAlert = tokenHealth.critical || !host.ready;
  const alertLevel = tokenHealth.critical ? 3 : 2;
  const message = tokenHealth.critical
    ? `인스타 토큰 만료 임박\n${buildAlertMessage(payload)}`
    : `인스타 업로드 준비 확인 필요\n${buildAlertMessage(payload)}`;

  if (!shouldAlert || options.dryRun) {
    return { shouldAlert, alertLevel, message, sent: false };
  }

  await postAlarm({
    message,
    team: 'blog',
    alertLevel,
    fromBot: 'blog-instagram-monitor',
  });
  return { shouldAlert, alertLevel, message, sent: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await getInstagramConfig();
  const payload = buildStatusPayload();
  const alert = await maybeSendAlert(payload, args);
  const result = {
    ready: Boolean(config.accessToken && config.igUserId && payload.host.ready),
    payload,
    alert,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[인스타 모니터] ready=${result.ready ? 'yes' : 'no'}`);
  console.log(`[인스타 모니터] tokenDaysLeft=${payload.tokenHealth.daysLeft ?? 'n/a'} host=${payload.host.ready ? payload.host.mode : 'missing'}`);
  if (alert.shouldAlert) {
    console.log(`[인스타 모니터] alert=${alert.sent ? 'sent' : 'pending'} level=${alert.alertLevel}`);
  }
}

main().catch((error) => {
  console.error('[인스타 모니터] 실패:', error?.message || error);
  process.exit(1);
});
