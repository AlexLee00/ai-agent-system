// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { compareVideos } = require('../lib/reference-quality');
const { SAMPLE_MAP } = require('./test-reference-quality');

const ROOT = path.join(__dirname, '..');
const DEFAULT_VALIDATION_REPORT = path.join(ROOT, 'temp', 'validation_report.json');

const TITLE_TO_SAMPLE = {
  파라미터: '파라미터',
  컴포넌트스테이트: '컴포넌트스테이트',
  동적데이터: '동적데이터',
  서버인증: '서버인증',
  DB생성: 'db생성',
};

function parseArgs(argv) {
  const parsed = {
    validationReport: DEFAULT_VALIDATION_REPORT,
    json: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--validation-report=')) parsed.validationReport = arg.slice('--validation-report='.length);
    if (arg === '--json') parsed.json = true;
  }

  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function average(list, selector) {
  if (!list.length) return 0;
  return Number((list.reduce((sum, item) => sum + Number(selector(item) || 0), 0) / list.length).toFixed(2));
}

function resolveReferenceFromTitle(title) {
  const key = TITLE_TO_SAMPLE[String(title || '').trim()];
  return key ? SAMPLE_MAP[key]?.reference || null : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = path.resolve(args.validationReport);
  assert(fs.existsSync(reportPath), `validation report가 없습니다: ${reportPath}`);

  const validationReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const sets = Array.isArray(validationReport.sets) ? validationReport.sets : [];
  const results = [];

  for (const set of sets) {
    const previewPath = path.join(set.run_dir, 'preview.mp4');
    const referencePath = resolveReferenceFromTitle(set.title);
    if (!referencePath || !fs.existsSync(previewPath) || !fs.existsSync(referencePath)) {
      results.push({
        index: set.index,
        title: set.title,
        status: 'skipped',
        previewPath,
        referencePath,
      });
      continue;
    }

    const comparison = await compareVideos(previewPath, referencePath);
    results.push({
      index: set.index,
      title: set.title,
      status: 'ok',
      previewPath,
      referencePath,
      scores: comparison.scores,
      deltas: comparison.deltas,
      generated: comparison.generated,
      reference: comparison.reference,
      visualSamples: comparison.visualSamples,
    });
  }

  const okResults = results.filter((item) => item.status === 'ok');
  const summary = {
    totalSets: results.length,
    comparedSets: okResults.length,
    averageOverall: average(okResults, (item) => item.scores.overall),
    averageDuration: average(okResults, (item) => item.scores.duration),
    averageResolution: average(okResults, (item) => item.scores.resolution),
    averageVisualSimilarity: average(okResults, (item) => item.scores.visual_similarity),
  };

  const payload = {
    validationReport: reportPath,
    summary,
    results,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[reference-quality-batch] compared=${summary.comparedSets}/${summary.totalSets}`);
  console.log(`[reference-quality-batch] avg overall=${summary.averageOverall} duration=${summary.averageDuration} resolution=${summary.averageResolution} visual=${summary.averageVisualSimilarity}`);
  for (const item of results) {
    if (item.status !== 'ok') {
      console.log(`[reference-quality-batch] ${item.title}: skipped`);
      continue;
    }
    console.log(`[reference-quality-batch] ${item.title}: overall=${item.scores.overall} duration=${item.scores.duration} resolution=${item.scores.resolution} visual=${item.scores.visual_similarity}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[reference-quality-batch] 실패:', error.message);
    process.exit(1);
  });
}

module.exports = {
  TITLE_TO_SAMPLE,
  parseArgs,
  resolveReferenceFromTitle,
  main,
};
