#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WIKI_DIR = path.join(os.homedir(), 'project-docs/ai-agent-system/wiki');

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readPages(wikiDir = DEFAULT_WIKI_DIR) {
  if (!fs.existsSync(wikiDir)) return [];
  return fs.readdirSync(wikiDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({
      topic: path.basename(name, '.md'),
      file: path.join(wikiDir, name),
      content: fs.readFileSync(path.join(wikiDir, name), 'utf8'),
    }));
}

export function detectContradictions(pages) {
  const assertions = new Map();
  const pattern = /\b([A-Za-z0-9_.-]{3,})\s+(?:is|=)\s+(enabled|disabled|true|false|on|off)\b/gi;
  for (const page of pages) {
    for (const match of page.content.matchAll(pattern)) {
      const subject = match[1].toLowerCase();
      const value = match[2].toLowerCase();
      const polarity = ['enabled', 'true', 'on'].includes(value) ? 'positive' : 'negative';
      const list = assertions.get(subject) || [];
      list.push({ topic: page.topic, value, polarity });
      assertions.set(subject, list);
    }
  }
  return [...assertions.entries()]
    .filter(([, list]) => new Set(list.map((item) => item.polarity)).size > 1)
    .map(([subject, list]) => ({ subject, evidence: list.slice(0, 6) }));
}

export function detectOrphanLinks(pages) {
  const topics = new Set(pages.map((page) => page.topic));
  const orphans = [];
  for (const page of pages) {
    for (const match of page.content.matchAll(/\[\[([^\]]+)\]\]|\[[^\]]+\]\(([^)]+\.md)\)/g)) {
      const target = (match[1] || path.basename(match[2], '.md')).replace(/\.md$/i, '').trim();
      if (target && !topics.has(target)) {
        orphans.push({ from: page.topic, target });
      }
    }
  }
  return orphans;
}

export function detectMissingFrequentConcepts(pages, minCount = 3) {
  const topics = new Set(pages.map((page) => page.topic.toLowerCase()));
  const counts = new Map();
  const stop = new Set(['source', 'coords', 'wiki', 'library', 'compiled', 'entry', 'from', 'with', 'true', 'false']);
  for (const page of pages) {
    const words = page.content.match(/\b[A-Za-z][A-Za-z0-9_-]{3,}\b/g) || [];
    for (const word of words) {
      const key = word.toLowerCase();
      if (stop.has(key) || topics.has(key)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([concept, count]) => ({ concept, count }));
}

export function buildWikiHealthReport({ wikiDir = DEFAULT_WIKI_DIR, pages = null, minConceptCount = 3 } = {}) {
  const loadedPages = pages || readPages(wikiDir);
  const contradictions = detectContradictions(loadedPages);
  const orphanLinks = detectOrphanLinks(loadedPages);
  const missingFrequentConcepts = detectMissingFrequentConcepts(loadedPages, minConceptCount);
  const warnings = [
    ...contradictions.map((item) => `contradiction:${item.subject}`),
    ...orphanLinks.map((item) => `orphan_link:${item.from}->${item.target}`),
    ...missingFrequentConcepts.map((item) => `missing_concept:${item.concept}`),
  ];
  return {
    ok: true,
    source: 'sigma_wiki_health_check',
    advisoryOnly: true,
    liveMutation: false,
    checkedAt: new Date().toISOString(),
    wikiDir,
    counts: {
      pages: loadedPages.length,
      contradictions: contradictions.length,
      orphanLinks: orphanLinks.length,
      missingFrequentConcepts: missingFrequentConcepts.length,
      warnings: warnings.length,
    },
    contradictions,
    orphanLinks,
    missingFrequentConcepts,
    warnings,
  };
}

function main() {
  const report = buildWikiHealthReport({
    wikiDir: argValue('dir', DEFAULT_WIKI_DIR),
    minConceptCount: Number(argValue('min-concept-count', 3)) || 3,
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`[wiki-health] pages=${report.counts.pages} warnings=${report.counts.warnings}`);
  if (process.argv.includes('--strict') && report.counts.contradictions > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
