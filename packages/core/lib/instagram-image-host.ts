'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('./env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

function readStoreInstagramConfig() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return store?.instagram || {};
  } catch {
    return {};
  }
}

function trimTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function trimLeadingSlash(value = '') {
  return String(value || '').replace(/^\/+/, '');
}

function slugifySegment(value = '') {
  const normalized = String(value || '')
    .trim()
    .normalize('NFKD')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (normalized && /[A-Za-z0-9]/.test(normalized)) {
    return normalized;
  }

  const digest = crypto
    .createHash('sha1')
    .update(String(value || 'asset'))
    .digest('hex')
    .slice(0, 12);

  return `asset-${digest}`;
}

function getInstagramImageHostConfig() {
  const storeData = readStoreInstagramConfig();
  const mode = String(
    storeData?.host_mode
    || process.env.INSTAGRAM_HOST_MODE
    || (storeData?.github_pages_base_url ? 'github_pages' : '')
    || (storeData?.public_base_url ? 'public_base_url' : '')
    || ''
  ).trim().toLowerCase();

  const githubPagesBaseUrl = trimTrailingSlash(
    storeData?.github_pages_base_url || process.env.INSTAGRAM_GITHUB_PAGES_BASE_URL || '',
  );
  const publicBaseUrl = trimTrailingSlash(
    storeData?.public_base_url || process.env.INSTAGRAM_PUBLIC_BASE_URL || '',
  );
  const opsStaticBaseUrl = trimTrailingSlash(
    storeData?.ops_static_base_url || process.env.INSTAGRAM_OPS_STATIC_BASE_URL || '',
  );
  const relativePrefix = trimLeadingSlash(
    storeData?.public_relative_prefix || process.env.INSTAGRAM_PUBLIC_RELATIVE_PREFIX || 'blog-assets/instagram',
  );

  return {
    mode,
    githubPagesBaseUrl,
    publicBaseUrl,
    opsStaticBaseUrl,
    relativePrefix,
  };
}

function buildHostedAssetPath(filePath = '', kind = 'asset') {
  const absolutePath = path.resolve(String(filePath || ''));
  const ext = path.extname(absolutePath);
  const basename = path.basename(absolutePath, ext);
  const safeName = `${slugifySegment(basename)}${ext}`;
  return `${kind}/${safeName}`;
}

function getInstagramHostedAssetLocalPath(filePath = '', { kind = 'asset' } = {}) {
  if (!filePath) {
    throw new Error('공개 배치할 파일 경로가 필요합니다.');
  }

  const config = getInstagramImageHostConfig();
  const relativePath = buildHostedAssetPath(filePath, kind);
  const baseDir = path.join(env.PROJECT_ROOT, 'docs', trimLeadingSlash(config.relativePrefix));
  return {
    baseDir,
    relativePath,
    targetPath: path.join(baseDir, relativePath),
  };
}

function resolveInstagramHostedMediaUrl(filePath = '', { kind = 'asset' } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`공개 호스팅할 파일을 찾을 수 없습니다: ${filePath}`);
  }

  const config = getInstagramImageHostConfig();
  const relativePath = buildHostedAssetPath(filePath, kind);

  let baseUrl = '';
  if (config.mode === 'github_pages' && config.githubPagesBaseUrl) {
    baseUrl = config.githubPagesBaseUrl;
  } else if (config.mode === 'ops_static' && config.opsStaticBaseUrl) {
    baseUrl = config.opsStaticBaseUrl;
  } else if (config.publicBaseUrl) {
    baseUrl = config.publicBaseUrl;
  } else if (config.githubPagesBaseUrl) {
    baseUrl = config.githubPagesBaseUrl;
  } else if (config.opsStaticBaseUrl) {
    baseUrl = config.opsStaticBaseUrl;
  }

  return {
    ready: Boolean(baseUrl),
    mode: config.mode || (baseUrl ? 'public_base_url' : 'unconfigured'),
    relativePath,
    publicUrl: baseUrl
      ? `${baseUrl}/${trimLeadingSlash(config.relativePrefix)}/${relativePath}`
      : '',
    note: baseUrl
      ? '공개 호스팅 기준 URL이 준비되어 있습니다.'
      : '공개 호스팅 기준 URL이 아직 없습니다. GitHub Pages 또는 public_base_url 설정이 필요합니다.',
  };
}

module.exports = {
  getInstagramImageHostConfig,
  resolveInstagramHostedMediaUrl,
  buildHostedAssetPath,
  getInstagramHostedAssetLocalPath,
};
