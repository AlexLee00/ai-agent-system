// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SIGMA_VAULT_ROOT = path.resolve(process.cwd(), 'vault');

export const PARA_CATEGORIES = Object.freeze({
  inbox: '00-inbox',
  projects: '10-projects',
  areas: '20-areas',
  resources: '30-resources',
  archives: '40-archives',
});

const DEFAULT_SUBDIRECTORIES = Object.freeze([
  '10-projects/luna-phase-a',
  '10-projects/edu-x-integration',
  '10-projects/hub-llm-enhancement',
  '20-areas/luna',
  '20-areas/blo',
  '20-areas/ska',
  '20-areas/claude',
  '20-areas/darwin',
  '20-areas/sigma',
  '30-resources/patterns',
  '30-resources/research',
  '30-resources/external-inspiration',
  '40-archives/retired-teams',
  '40-archives/completed-projects',
]);

function slugify(value = 'untitled') {
  const slug = String(value || 'untitled')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

function nowIso() {
  return new Date().toISOString();
}

function vaultPath(root, relativePath = '') {
  const resolvedRoot = path.resolve(root || DEFAULT_SIGMA_VAULT_ROOT);
  const resolved = path.resolve(resolvedRoot, relativePath || '');
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`vault path escapes root: ${relativePath}`);
  }
  return resolved;
}

export function ensureSigmaVaultStructure(root = DEFAULT_SIGMA_VAULT_ROOT) {
  const resolvedRoot = vaultPath(root);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  for (const dir of Object.values(PARA_CATEGORIES)) fs.mkdirSync(vaultPath(resolvedRoot, dir), { recursive: true });
  for (const dir of DEFAULT_SUBDIRECTORIES) fs.mkdirSync(vaultPath(resolvedRoot, dir), { recursive: true });
  return { ok: true, root: resolvedRoot, directories: Object.values(PARA_CATEGORIES).length + DEFAULT_SUBDIRECTORIES.length };
}

export function buildFrontmatter(meta = {}) {
  const entries = {
    title: meta.title || 'Untitled',
    category: meta.category || 'inbox',
    status: meta.status || 'captured',
    source: meta.source || 'sigma-vault',
    created_at: meta.createdAt || nowIso(),
    updated_at: meta.updatedAt || nowIso(),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    related: Array.isArray(meta.related) ? meta.related : [],
  };
  const lines = ['---'];
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => JSON.stringify(String(item))).join(', ')}]`);
    } else {
      lines.push(`${key}: ${JSON.stringify(String(value))}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n\n`;
}

function categoryDirectory(category = 'inbox') {
  const key = String(category || 'inbox').trim();
  return PARA_CATEGORIES[key] || key;
}

export function writeSigmaVaultNote({
  root = DEFAULT_SIGMA_VAULT_ROOT,
  category = 'inbox',
  file = null,
  title = 'Untitled',
  content = '',
  meta = {},
} = {}) {
  ensureSigmaVaultStructure(root);
  const categoryPath = categoryDirectory(category);
  const fileName = file || `${slugify(title)}.md`;
  const relativePath = path.join(categoryPath, fileName);
  const target = vaultPath(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = String(content || '').startsWith('---\n')
    ? String(content || '')
    : `${buildFrontmatter({ ...meta, title, category })}${String(content || '').trim()}\n`;
  fs.writeFileSync(target, body, 'utf8');
  return { ok: true, path: target, relativePath };
}

export function readSigmaVaultNote({ root = DEFAULT_SIGMA_VAULT_ROOT, file } = {}) {
  if (!file) throw new Error('file is required');
  const target = vaultPath(root, file);
  return { ok: true, path: target, content: fs.readFileSync(target, 'utf8') };
}

export function scanSigmaVault({ root = DEFAULT_SIGMA_VAULT_ROOT, category = null } = {}) {
  ensureSigmaVaultStructure(root);
  const start = category ? vaultPath(root, categoryDirectory(category)) : vaultPath(root);
  const rows = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        rows.push({
          path: absolute,
          relativePath: path.relative(vaultPath(root), absolute),
          bytes: fs.statSync(absolute).size,
        });
      }
    }
  };
  if (fs.existsSync(start)) visit(start);
  return rows.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function searchSigmaVault({ root = DEFAULT_SIGMA_VAULT_ROOT, query = '', limit = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  return scanSigmaVault({ root })
    .map((row) => ({ ...row, content: fs.readFileSync(row.path, 'utf8') }))
    .filter((row) => row.relativePath.toLowerCase().includes(needle) || row.content.toLowerCase().includes(needle))
    .slice(0, Math.max(1, Number(limit || 20)));
}

export function classifyParaCategory({ title = '', content = '' } = {}) {
  const text = `${title} ${content}`.toLowerCase();
  if (/완료|retired|archive|종료|closed/u.test(text)) return 'archives';
  if (/구현|프로젝트|milestone|phase|task|launchd|integration/u.test(text)) return 'projects';
  if (/팀|운영|area|luna|blo|ska|darwin|sigma|claude/u.test(text)) return 'areas';
  if (/논문|research|자료|reference|pattern|resource|커뮤니티/u.test(text)) return 'resources';
  return 'inbox';
}

export function moveSigmaVaultNote({ root = DEFAULT_SIGMA_VAULT_ROOT, file, category, dryRun = true } = {}) {
  if (!file) throw new Error('file is required');
  const source = vaultPath(root, file);
  const targetCategory = categoryDirectory(category || 'inbox');
  const targetRelative = path.join(targetCategory, path.basename(file));
  const target = vaultPath(root, targetRelative);
  if (!fs.existsSync(source)) return { ok: false, moved: false, reason: 'source_missing', source, target };
  if (dryRun) return { ok: true, moved: false, dryRun: true, source, target, relativePath: targetRelative };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  return { ok: true, moved: true, source, target, relativePath: targetRelative };
}

export default {
  DEFAULT_SIGMA_VAULT_ROOT,
  PARA_CATEGORIES,
  ensureSigmaVaultStructure,
  buildFrontmatter,
  writeSigmaVaultNote,
  readSigmaVaultNote,
  scanSigmaVault,
  searchSigmaVault,
  classifyParaCategory,
  moveSigmaVaultNote,
};
