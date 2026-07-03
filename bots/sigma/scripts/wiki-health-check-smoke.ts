#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildWikiHealthReport,
  detectContradictions,
  detectMissingFrequentConcepts,
  detectOrphanLinks,
} from './wiki-health-check.ts';

const pages = [
  {
    topic: 'hub',
    content: [
      '# hub',
      'routing is enabled',
      'cycle is enabled',
      '[[missing-page]]',
      'trace trace trace',
    ].join('\n'),
  },
  {
    topic: 'platform',
    content: [
      '# platform',
      'routing is disabled',
      'trace trace',
    ].join('\n'),
  },
];

const contradictions = detectContradictions(pages);
assert.equal(contradictions.some((item) => item.subject === 'routing'), true);
const orphans = detectOrphanLinks(pages);
assert.deepEqual(orphans, [{ from: 'hub', target: 'missing-page' }]);
const missing = detectMissingFrequentConcepts(pages, 3);
assert.equal(missing.some((item) => item.concept === 'trace'), true);

const report = buildWikiHealthReport({ pages, minConceptCount: 3 });
assert.equal(report.ok, true);
assert.equal(report.advisoryOnly, true);
assert.equal(report.liveMutation, false);
assert.equal(report.counts.contradictions, 1);
assert.equal(report.counts.orphanLinks, 1);
assert.ok(report.counts.warnings >= 3);

console.log(JSON.stringify({ ok: true, smoke: 'wiki-health-check', checks: 10 }, null, 2));
