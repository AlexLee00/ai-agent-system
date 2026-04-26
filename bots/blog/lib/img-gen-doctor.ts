'use strict';

/**
 * bots/blog/lib/img-gen-doctor.ts — Draw Things 이미지 생성 진단 + 알람
 *
 * 이미지 생성 실패 시 자동으로 원인 진단 후 Telegram으로 보고.
 * Silent fail 방지 — 모든 이미지 실패는 반드시 마스터에게 보고.
 */

const { execSync } = require('child_process');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');

const DRAW_THINGS_URL = process.env.BLOG_IMAGE_BASE_URL || 'http://127.0.0.1:7860';
const DISK_WARN_BYTES = 5_000_000_000; // 5GB

function _checkDrawThingsRunning() {
  try {
    execSync('pgrep -f "Draw Things"', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function _pingApi(url) {
  try {
    const res = await fetch(`${url}/sdapi/v1/options`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function _getFreeDiskBytes() {
  try {
    const output = execSync('df -k /').toString();
    const parts = output.trim().split('\n')[1].trim().split(/\s+/);
    return parseInt(parts[3], 10) * 1024;
  } catch {
    return -1;
  }
}

async function _recentImgFailures(hours) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*)::int AS cnt
      FROM blog.posts
      WHERE created_at >= NOW() - ($1 || ' hours')::interval
        AND thumbnail_path IS NULL
        AND post_type = 'general'
        AND dry_run = false
    `, [String(hours)]);
    return rows?.[0]?.cnt ?? 0;
  } catch {
    return -1;
  }
}

/**
 * Draw Things 이미지 생성 환경 종합 진단
 * @returns {{ healthy: boolean, issues: string[], checks: object }}
 */
async function diagnoseImageGeneration() {
  const [appRunning, apiOk, diskBytes, recentFails] = await Promise.all([
    Promise.resolve(_checkDrawThingsRunning()),
    _pingApi(DRAW_THINGS_URL),
    Promise.resolve(_getFreeDiskBytes()),
    _recentImgFailures(24),
  ]);

  const issues = [];
  if (!appRunning) issues.push('Draw Things 앱 미구동 (pgrep 확인 필요)');
  if (!apiOk) issues.push(`API 응답 없음 (${DRAW_THINGS_URL}/sdapi/v1/options)`);
  if (diskBytes >= 0 && diskBytes < DISK_WARN_BYTES) {
    issues.push(`디스크 여유 공간 부족: ${Math.round(diskBytes / 1_000_000)}MB (5GB 미만)`);
  }
  if (recentFails > 3) {
    issues.push(`최근 24h 이미지 없이 발행된 일반 글: ${recentFails}건`);
  }

  return {
    healthy: issues.length === 0,
    issues,
    checks: { appRunning, apiOk, diskBytes, recentFails },
  };
}

/**
 * 이미지 생성 실패 Telegram 보고 (긴급)
 */
async function reportImageGenFailure(title, errorMessage) {
  const message = `🔴 [블로팀] 이미지 생성 실패\n글: ${title}\n원인: ${errorMessage}`;
  await postAlarm(message, { team: 'blog', bot: 'img-gen-doctor', level: 'critical' }).catch(() => {});
}

/**
 * 이미지 생성 진단 결과 Telegram 보고
 */
async function reportImageDiagnosis(issues) {
  if (!issues?.length) return;
  const message = `🔴 [블로팀] 이미지 생성 진단 결과\n${issues.join('\n')}`;
  await postAlarm(message, { team: 'blog', bot: 'img-gen-doctor', level: 'critical' }).catch(() => {});
}

/**
 * Fallback 썸네일 반환 (Draw Things 실패 시)
 * 카테고리별 미리 준비된 기본 썸네일 경로 반환
 */
async function useFallbackThumbnail(category) {
  try {
    const env = require('../../../packages/core/lib/env');
    const path = require('path');
    const fs = require('fs');
    const fallbackDir = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'assets', 'fallback-thumbs');
    if (!fs.existsSync(fallbackDir)) return null;
    const files = fs.readdirSync(fallbackDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
    if (!files.length) return null;
    // 카테고리 매칭 또는 첫 번째 파일 사용
    const matched = files.find(f => f.includes(category)) || files[0];
    return path.join(fallbackDir, matched);
  } catch {
    return null;
  }
}

module.exports = {
  diagnoseImageGeneration,
  reportImageGenFailure,
  reportImageDiagnosis,
  useFallbackThumbnail,
};
