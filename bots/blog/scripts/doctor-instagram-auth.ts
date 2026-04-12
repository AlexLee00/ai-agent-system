'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { getInstagramConfig, buildHostedVideoUrl, verifyPublicMediaUrl } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const { findLatestReelPath } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    video: readOption(argv, '--video'),
  };
}

function readOption(argv = [], flag = '') {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function buildActions({ config, media, reelPath }) {
  const actions = [];

  if (!config.accessToken) actions.push('허브 저장소에 instagram.access_token 등록');
  if (!config.igUserId) actions.push('허브 저장소에 instagram.ig_user_id 등록');
  if (!config.appId) actions.push('허브 저장소에 instagram.app_id 등록');
  if (!config.appSecret) actions.push('허브 저장소에 instagram.app_secret 등록');
  if (!config.tokenHealth?.tokenExpiresAt) actions.push('새 토큰 반영 후 token_expires_at 저장');
  if (config.tokenHealth?.hasAccessToken && config.tokenHealth?.hasAppId && config.tokenHealth?.hasAppSecret && !config.tokenHealth?.tokenExpiresAt) {
    actions.push('refresh:instagram-token 또는 단기→장기 교환으로 만료일 확정');
  }
  if (!reelPath) actions.push('릴스 렌더 후 prepare:instagram-media 실행');
  if (reelPath && !media?.ok) actions.push('GitHub Pages 공개 URL 200 확인 후 publish-instagram-reel 재시도');

  if (actions.length === 0) {
    actions.push('publish-instagram-reel 실업로드 테스트');
  }

  return actions;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await getInstagramConfig();
  const reelPath = args.video ? path.resolve(args.video) : findLatestReelPath();
  let media = null;

  if (reelPath) {
    try {
      const publicUrl = buildHostedVideoUrl(reelPath);
      media = {
        reelPath,
        publicUrl,
        ...(await verifyPublicMediaUrl(publicUrl)),
      };
    } catch (error) {
      media = {
        reelPath,
        ok: false,
        status: 0,
        method: 'build',
        error: error?.message || String(error),
      };
    }
  }

  const payload = {
    ready: Boolean(
      config.accessToken
      && config.igUserId
      && config.appId
      && config.appSecret
      && media?.ok,
    ),
    source: config.credentialSource || 'unknown',
    token: {
      hasAccessToken: Boolean(config.accessToken),
      hasIgUserId: Boolean(config.igUserId),
      hasAppId: Boolean(config.appId),
      hasAppSecret: Boolean(config.appSecret),
      expiresAt: config.tokenHealth?.tokenExpiresAt || null,
      daysLeft: config.tokenHealth?.daysLeft ?? null,
    },
    media,
    actions: buildActions({ config, media, reelPath }),
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 doctor] ready=${payload.ready ? 'yes' : 'no'} source=${payload.source}`);
  console.log(`[인스타 doctor] token expires=${payload.token.expiresAt || 'unknown'} daysLeft=${payload.token.daysLeft ?? 'n/a'}`);
  console.log(`[인스타 doctor] media=${payload.media?.ok ? 'ready' : 'not-ready'} ${payload.media?.publicUrl || payload.media?.error || ''}`.trim());
  for (const action of payload.actions) {
    console.log(`- ${action}`);
  }
}

main().catch((error) => {
  console.error('[인스타 doctor] 실패:', error?.message || error);
  process.exit(1);
});
