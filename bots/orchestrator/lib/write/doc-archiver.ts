// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const env = require('../../../../packages/core/lib/env');

const ROOT = env.PROJECT_ROOT;
const DOCS_DIR = path.join(ROOT, 'docs');
const TRACKER_PATH = path.join(DOCS_DIR, 'PLATFORM_IMPLEMENTATION_TRACKER.md');
const MAX_TRACKER_ADDS = 5;
const CODEX_AUTOMATION_DISABLED_REASON =
  'docs/codex automation is decommissioned; use docs/auto_dev for auto implementation';

const TRACKER_SECTION_BY_PREFIX = [
  { prefix: 'packages/core/lib/', heading: '### 공용 계층' },
  { prefix: 'bots/investment/', heading: '### 루나팀' },
  { prefix: 'bots/blog/', heading: '### 블로팀' },
  { prefix: 'bots/claude/', heading: '### 클로드팀' },
  { prefix: 'bots/reservation/', heading: '### 스카/워커/오케스트레이터' },
  { prefix: 'bots/orchestrator/', heading: '### 스카/워커/오케스트레이터' },
];

function safeExec(command) {
  return execSync(command, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function listMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function scanCompletedCodex() {
  return [];
}

function archiveCompletedCodex(completedFiles) {
  return {
    moved: [],
    commitHash: null,
    disabled: true,
    ignored: Array.isArray(completedFiles) ? completedFiles.length : 0,
    reason: CODEX_AUTOMATION_DISABLED_REASON,
  };
}

function scanStaleRootDocs() {
  const rootDocs = listMarkdownFiles(DOCS_DIR);
  const allDocs = safeExec('find docs -type f -name "*.md"').split('\n').filter(Boolean);
  return rootDocs
    .map((file) => {
      const refs = allDocs.reduce((count, relativePath) => {
        if (relativePath === path.join('docs', file)) return count;
        try {
          const text = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
          return count + (text.includes(file) ? 1 : 0);
        } catch {
          return count;
        }
      }, 0);
      if (refs > 0) return null;
      return {
        file,
        refCount: 0,
        suggestion: `docs/archive/ 검토 후보 — ${file}`,
      };
    })
    .filter(Boolean);
}

function findTrackedCodeBlock(text, heading) {
  const headingIndex = text.indexOf(heading);
  if (headingIndex < 0) return null;
  const blockStart = text.indexOf('```', headingIndex);
  if (blockStart < 0) return null;
  const contentStart = text.indexOf('\n', blockStart);
  if (contentStart < 0) return null;
  const blockEnd = text.indexOf('```', contentStart + 1);
  if (blockEnd < 0) return null;
  return { blockStart, contentStart: contentStart + 1, blockEnd };
}

function relativeFilesFromGit() {
  const output = safeExec(`git log --name-status --diff-filter=A --since='30 days ago' --pretty=format:`);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function isTrackedInTracker(trackerText, relativePath) {
  return trackerText.includes(relativePath);
}

function findUntrackedInTracker() {
  const trackerText = fs.readFileSync(TRACKER_PATH, 'utf8');
  return relativeFilesFromGit()
    .map((line) => line.replace(/^[A-Z]\s+/, ''))
    .filter((file) => /^(bots\/|packages\/core\/lib\/)/.test(file))
    .filter((file) => !/\/node_modules\/|\.json$|\.yaml$|\.yml$|\.pyc$/.test(file))
    .filter((file) => !isTrackedInTracker(trackerText, file))
    .sort();
}

function resolveTrackerHeading(relativePath) {
  const match = TRACKER_SECTION_BY_PREFIX.find((item) => relativePath.startsWith(item.prefix));
  return match?.heading || null;
}

function findUntrackedFiles(newFiles) {
  const trackerText = fs.readFileSync(TRACKER_PATH, 'utf8');
  const files = Array.isArray(newFiles) ? newFiles.filter(Boolean) : [];
  return files
    .filter((file) => /^(bots\/|packages\/core\/lib\/)/.test(file))
    .filter((file) => !isTrackedInTracker(trackerText, file))
    .sort();
}

function updateTracker(newFiles) {
  const uniqueFiles = [...new Set((Array.isArray(newFiles) ? newFiles : []).filter(Boolean))].slice(0, MAX_TRACKER_ADDS);
  if (!uniqueFiles.length) return { added: [], commitHash: null };

  let trackerText = fs.readFileSync(TRACKER_PATH, 'utf8');
  const added = [];

  uniqueFiles.forEach((file) => {
    const heading = resolveTrackerHeading(file);
    if (!heading || isTrackedInTracker(trackerText, file)) return;
    const block = findTrackedCodeBlock(trackerText, heading);
    if (!block) return;
    const insertion = `${file}\n`;
    trackerText = `${trackerText.slice(0, block.blockEnd)}${insertion}${trackerText.slice(block.blockEnd)}`;
    added.push(file);
  });

  if (!added.length) return { added: [], commitHash: null };

  fs.writeFileSync(TRACKER_PATH, trackerText);
  safeExec(`git add ${JSON.stringify(path.join('docs', 'PLATFORM_IMPLEMENTATION_TRACKER.md'))}`);
  safeExec(`git commit -m ${JSON.stringify(`docs(write): TRACKER 자동 갱신 — ${added.length}건 추가`)}`);
  const commitHash = safeExec('git rev-parse --short HEAD');
  return { added, commitHash };
}

module.exports = {
  scanCompletedCodex,
  archiveCompletedCodex,
  scanStaleRootDocs,
  updateTracker,
  findUntrackedInTracker,
  findUntrackedFiles,
};
