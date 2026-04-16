// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

const CODEX_DIR = path.join(env.PROJECT_ROOT, 'docs', 'codex');
const ARCHIVE_DIR = path.join(CODEX_DIR, 'archive');

function listActive() {
  if (!fs.existsSync(CODEX_DIR)) return [];
  return fs.readdirSync(CODEX_DIR)
    .filter((file) => file.startsWith('CODEX_') && file.endsWith('.md'))
    .map((file) => ({ name: file, path: path.join(CODEX_DIR, file) }));
}

function isCompleted(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  const checkboxes = content.match(/\[[ x]\]/g) || [];
  if (checkboxes.length === 0) return false;
  return !checkboxes.includes('[ ]');
}

function archiveCompleted() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const moved = [];
  for (const codex of listActive()) {
    if (!isCompleted(codex.path)) continue;
    const destination = path.join(ARCHIVE_DIR, codex.name);
    fs.renameSync(codex.path, destination);
    moved.push(codex.name);
  }
  return moved;
}

function summarize() {
  const active = listActive();
  const archived = fs.existsSync(ARCHIVE_DIR)
    ? fs.readdirSync(ARCHIVE_DIR).filter((file) => file.endsWith('.md')).length
    : 0;
  return {
    active: active.length,
    names: active.map((item) => item.name),
    archived,
  };
}

module.exports = {
  listActive,
  isCompleted,
  archiveCompleted,
  summarize,
};
