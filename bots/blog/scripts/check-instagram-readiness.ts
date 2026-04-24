'use strict';

/**
 * bots/blog/scripts/check-instagram-readiness.ts
 *
 * Instagram 발행 readiness를 3단계로 분리해 확인.
 *   credentialReady  — 인증 토큰/igUserId 확인
 *   assetReady       — 릴스 파일 + 공개 URL 확인
 *   publishReady     — credentialReady && assetReady
 *
 * L5 기준:
 *  - hostedRecovery=true는 clear가 아니라 'recoverable'로 분류
 *  - stagedReady=false && github_pages 모드 → assetReady=false
 */

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const {
  resolveInstagramHostedMediaUrl,
  getInstagramHostedAssetLocalPath,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts'));
const {
  findLatestReelPath,
  findLatestReelCoverPath,
  findLatestReelQaSheetPath,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function buildInstagramReadinessFallback(payload = {}) {
  const { credentialReady, assetReady, publishReady } = payload;
  if (!credentialReady) {
    return '인스타 인증 토큰 또는 igUserId가 없어 credential 재발급이 먼저입니다.';
  }
  if (!assetReady) {
    return '릴스 파일 또는 공개 URL이 준비되지 않아 prepare:instagram-media 실행이 필요합니다.';
  }
  if (publishReady) {
    return '인스타 readiness 3단계 모두 충족 — 발행 가능 상태입니다.';
  }
  return '인스타 readiness 일부 미충족 항목이 있습니다. 세부 항목을 확인하세요.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await getInstagramConfig();
  const reelPath = findLatestReelPath();
  const coverPath = findLatestReelCoverPath();
  const qaSheetPath = findLatestReelQaSheetPath();

  // ── 1. credentialReady ────────────────────────────────────────────────────
  const credentialMissing = [];
  if (!config.accessToken) credentialMissing.push('instagram.access_token');
  if (!config.igUserId) credentialMissing.push('instagram.ig_user_id');
  const credentialReady = credentialMissing.length === 0;

  // ── 2. assetReady ─────────────────────────────────────────────────────────
  const assetMissing = [];
  const hosted = reelPath ? resolveInstagramHostedMediaUrl(reelPath, { kind: 'reels' }) : null;
  const localTarget = reelPath ? getInstagramHostedAssetLocalPath(reelPath, { kind: 'reels' }) : null;
  const staged = localTarget ? fs.existsSync(localTarget.targetPath) : false;
  const qaHosted = qaSheetPath ? resolveInstagramHostedMediaUrl(qaSheetPath, { kind: 'thumbs' }) : null;
  const qaTarget = qaSheetPath ? getInstagramHostedAssetLocalPath(qaSheetPath, { kind: 'thumbs' }) : null;
  const qaStaged = qaTarget ? fs.existsSync(qaTarget.targetPath) : false;

  if (!reelPath) assetMissing.push('latest_reel_mp4');
  if (reelPath && !hosted?.ready) assetMissing.push('instagram.public_media_url');
  // GitHub Pages 모드에서 staged가 false면 assetReady=false (hostedRecovery로 숨기지 않음)
  if (reelPath && hosted?.mode === 'github_pages' && !staged) {
    assetMissing.push('instagram.staged_media');
  }

  const assetReady = assetMissing.length === 0;

  // ── 3. publishReady ───────────────────────────────────────────────────────
  const publishReady = credentialReady && assetReady;

  // ── hostedRecovery: 자동 복구 가능 여부 (분류 기준, clear 아님) ────────────
  const hostedRecovery = Boolean(
    reelPath
    && hosted?.ready === true
    && !staged
    && hosted?.mode === 'github_pages'
  );
  // hostedRecovery=true이면 'recoverable' 상태 — 자동으로 prepare:instagram-media 실행 필요

  const missing = [...credentialMissing, ...assetMissing];

  const payload = {
    ready: publishReady,
    publishReady,
    credentialReady,
    assetReady,
    missing,
    // hostedRecovery를 'clear'로 숨기지 않고 'recoverable' 상태로 명시
    recoveryStatus: hostedRecovery ? 'recoverable' : (publishReady ? 'clear' : 'needs_action'),
    note: 'Instagram Graph credentials are resolved from hub secrets first, then hub-managed secrets-store/env fallback.',
    source: {
      credentialSource: config.credentialSource || 'unknown',
      apiVersion: config.apiVersion || 'v21.0',
      baseUrl: config.baseUrl || 'https://graph.facebook.com',
      hasAccessToken: Boolean(config.accessToken),
      hasIgUserId: Boolean(config.igUserId),
      tokenHealth: config.tokenHealth || null,
    },
    reel: reelPath
      ? {
          path: reelPath,
          sizeBytes: fs.statSync(reelPath).size,
          hostedUrl: hosted?.publicUrl || null,
          hostedReady: hosted?.ready === true,
          hostMode: hosted?.mode || null,
          stagedPath: localTarget?.targetPath || null,
          stagedReady: staged,
          // staged=false && github_pages → assetReady=false (L5 엄격 분류)
          assetReadyContribution: !(hosted?.mode === 'github_pages' && !staged),
        }
      : null,
    cover: coverPath
      ? {
          path: coverPath,
          sizeBytes: fs.statSync(coverPath).size,
        }
      : null,
    qaSheet: qaSheetPath
      ? {
          path: qaSheetPath,
          sizeBytes: fs.statSync(qaSheetPath).size,
          hostedUrl: qaHosted?.publicUrl || null,
          hostedReady: qaHosted?.ready === true,
          hostMode: qaHosted?.mode || null,
          stagedPath: qaTarget?.targetPath || null,
          stagedReady: qaStaged,
        }
      : null,
  };

  const aiSummary = await buildBlogCliInsight({
    bot: 'check-instagram-readiness',
    requestType: 'check-instagram-readiness',
    title: '블로그 인스타그램 readiness 요약',
    data: {
      publishReady: payload.publishReady,
      credentialReady: payload.credentialReady,
      assetReady: payload.assetReady,
      recoveryStatus: payload.recoveryStatus,
      missing: payload.missing,
      source: payload.source,
      reel: payload.reel,
    },
    fallback: buildInstagramReadinessFallback(payload),
  });

  /** @type {any} */
  const typedPayload = /** @type {any} */ (payload);
  typedPayload.aiSummary = aiSummary;

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 readiness] publishReady=${payload.publishReady ? 'yes' : 'no'} credentialReady=${payload.credentialReady ? 'yes' : 'no'} assetReady=${payload.assetReady ? 'yes' : 'no'}`);
  console.log(`[인스타 readiness] recoveryStatus=${payload.recoveryStatus}`);
  console.log(`🔍 AI: ${typedPayload.aiSummary}`);
  console.log(`[인스타 readiness] token=${payload.source.hasAccessToken ? 'yes' : 'no'} igUserId=${payload.source.hasIgUserId ? 'yes' : 'no'}`);
  console.log(`[인스타 readiness] reel=${payload.reel ? payload.reel.path : 'missing'}`);
  console.log(`[인스타 readiness] cover=${payload.cover ? payload.cover.path : 'missing'}`);
  console.log(`[인스타 readiness] qa=${payload.qaSheet ? payload.qaSheet.path : 'missing'}`);
  if (missing.length) {
    console.log(`[인스타 readiness] missing=${missing.join(', ')}`);
  }
}

main().catch((error) => {
  console.error('[인스타 readiness] 실패:', error?.message || error);
  process.exit(1);
});
