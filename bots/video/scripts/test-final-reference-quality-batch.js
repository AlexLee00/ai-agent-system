'use strict';

const path = require('path');

const { compareVideos } = require('../lib/reference-quality');
const { runPipelineValidation } = require('./test-full-sync-pipeline');
const { SAMPLE_MAP } = require('./test-reference-quality');

const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');

const SAMPLE_SETS = [
  {
    title: '파라미터',
    sourceVideo: path.join(SAMPLES_DIR, 'raw', '원본_파라미터.mp4'),
    sourceAudio: path.join(SAMPLES_DIR, 'narration', '원본_나레이션_파라미터.m4a'),
    reference: SAMPLE_MAP.파라미터.reference,
  },
  {
    title: '컴포넌트스테이트',
    sourceVideo: path.join(SAMPLES_DIR, 'raw', '원본_컴포넌트스테이트.mp4'),
    sourceAudio: path.join(SAMPLES_DIR, 'narration', '원본_나레이션_컴포넌트스테이트.m4a'),
    reference: SAMPLE_MAP.컴포넌트스테이트.reference,
  },
  {
    title: '동적데이터',
    sourceVideo: path.join(SAMPLES_DIR, 'raw', '원본_동적데이터.mp4'),
    sourceAudio: path.join(SAMPLES_DIR, 'narration', '원본_나레이션_동적데이터.m4a'),
    reference: SAMPLE_MAP.동적데이터.reference,
  },
  {
    title: '서버인증',
    sourceVideo: path.join(SAMPLES_DIR, 'raw', '원본_서버인증.mp4'),
    sourceAudio: path.join(SAMPLES_DIR, 'narration', '원본_나레이션_서버인증.m4a'),
    reference: SAMPLE_MAP.서버인증.reference,
  },
  {
    title: 'DB생성',
    sourceVideo: path.join(SAMPLES_DIR, 'raw', '원본_DB생성.mp4'),
    sourceAudio: path.join(SAMPLES_DIR, 'narration', '원본_나레이션_DB생성.m4a'),
    reference: SAMPLE_MAP.db생성.reference,
  },
];

function parseArgs(argv) {
  const parsed = {
    json: false,
    limit: null,
    title: null,
  };

  for (const arg of argv) {
    if (arg === '--json') parsed.json = true;
    if (arg.startsWith('--limit=')) parsed.limit = Number.parseInt(arg.slice('--limit='.length), 10) || null;
    if (arg.startsWith('--title=')) parsed.title = arg.slice('--title='.length);
  }

  return parsed;
}

function average(list, selector) {
  if (!list.length) return 0;
  return Number((list.reduce((sum, item) => sum + Number(selector(item) || 0), 0) / list.length).toFixed(2));
}

function selectSets(args) {
  let sets = SAMPLE_SETS.slice();
  if (args.title) {
    sets = sets.filter((set) => set.title === args.title);
  }
  if (args.limit && args.limit > 0) {
    sets = sets.slice(0, args.limit);
  }
  return sets;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sets = selectSets(args);
  if (!sets.length) {
    throw new Error('실행할 샘플 세트가 없습니다.');
  }

  const results = [];
  for (const set of sets) {
    const pipeline = await runPipelineValidation({
      sourceVideo: set.sourceVideo,
      sourceAudio: set.sourceAudio,
      edited: set.reference,
      renderFinal: true,
      allowOfflineFixture: true,
    });

    const comparison = await compareVideos(pipeline.final_path, set.reference);
    results.push({
      title: set.title,
      sourceVideo: set.sourceVideo,
      sourceAudio: set.sourceAudio,
      reference: set.reference,
      pipeline,
      scores: comparison.scores,
      deltas: comparison.deltas,
      generated: comparison.generated,
      referenceMeta: comparison.reference,
      visualSamples: comparison.visualSamples,
    });
  }

  const summary = {
    totalSets: results.length,
    averageOverall: average(results, (item) => item.scores.overall),
    averageDuration: average(results, (item) => item.scores.duration),
    averageResolution: average(results, (item) => item.scores.resolution),
    averageVisualSimilarity: average(results, (item) => item.scores.visual_similarity),
    averageFinalRenderMs: average(results, (item) => item.pipeline.final_render?.duration_ms || 0),
  };

  const payload = { summary, results };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[final-reference-batch] compared=${summary.totalSets}`);
  console.log(`[final-reference-batch] avg overall=${summary.averageOverall} duration=${summary.averageDuration} resolution=${summary.averageResolution} visual=${summary.averageVisualSimilarity} render_ms=${summary.averageFinalRenderMs}`);
  for (const item of results) {
    console.log(`[final-reference-batch] ${item.title}: overall=${item.scores.overall} duration=${item.scores.duration} resolution=${item.scores.resolution} visual=${item.scores.visual_similarity} render_ms=${item.pipeline.final_render?.duration_ms || 0}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[final-reference-batch] 실패:', error.message);
    process.exit(1);
  });
}

module.exports = {
  SAMPLE_SETS,
  parseArgs,
  selectSets,
  main,
};
