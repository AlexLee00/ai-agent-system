// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { compareVideos } = require('../lib/reference-quality');
const { SAMPLE_MAP } = require('./test-reference-quality');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const DEFAULT_REPORT_PATH = path.join(ROOT, 'temp', 'final_batch_report.json');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: DEFAULT_REPORT_PATH,
  };

  for (const arg of argv) {
    if (arg === '--json') parsed.json = true;
    if (arg.startsWith('--limit=')) parsed.limit = Number.parseInt(arg.slice('--limit='.length), 10) || null;
    if (arg.startsWith('--title=')) parsed.title = arg.slice('--title='.length);
    if (arg.startsWith('--timeout-ms=')) parsed.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10) || DEFAULT_TIMEOUT_MS;
    if (arg.startsWith('--output=')) parsed.output = arg.slice('--output='.length) || DEFAULT_REPORT_PATH;
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

async function runPipelineValidationViaScript(set, timeoutMs) {
  const startedAt = Date.now();
  const scriptPath = path.join(__dirname, 'test-full-sync-pipeline.js');
  const args = [
    scriptPath,
    `--source-video=${set.sourceVideo}`,
    `--source-audio=${set.sourceAudio}`,
    `--edited=${set.reference}`,
    '--render-final',
  ];

  try {
    const { stdout, stderr } = await execFileAsync('node', args, {
      cwd: ROOT,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const pipeline = JSON.parse(stdout);
    return {
      status: 'ok',
      elapsedMs: Date.now() - startedAt,
      pipeline,
      warnings: stderr
        ? stderr.split('\n').map((line) => line.trim()).filter(Boolean)
        : [],
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (error.killed || error.signal === 'SIGKILL' || error.code === 'ETIMEDOUT') {
      return {
        status: 'timeout',
        elapsedMs,
        pipeline: null,
        error: `timeout after ${timeoutMs}ms`,
      };
    }

    const stderr = error.stderr
      ? String(error.stderr).split('\n').map((line) => line.trim()).filter(Boolean)
      : [];
    return {
      status: 'error',
      elapsedMs,
      pipeline: null,
      error: error.message,
      stderr,
    };
  }
}

function buildSetResult(set, runResult, comparison) {
  if (runResult.status !== 'ok') {
    return {
      title: set.title,
      sourceVideo: set.sourceVideo,
      sourceAudio: set.sourceAudio,
      reference: set.reference,
      status: runResult.status === 'timeout' ? 'skipped_timeout' : 'failed',
      overall: null,
      duration_ratio: null,
      visual_similarity: null,
      match_type_distribution: null,
      processing_time_ms: runResult.elapsedMs,
      error: runResult.error || null,
      warnings: runResult.stderr || runResult.warnings || [],
    };
  }

  const pipeline = runResult.pipeline;
  const durationRatio = comparison.reference.durationSec
    ? Number((comparison.generated.durationSec / comparison.reference.durationSec).toFixed(4))
    : null;
  return {
    title: set.title,
    sourceVideo: set.sourceVideo,
    sourceAudio: set.sourceAudio,
    reference: set.reference,
    status: 'ok',
    overall: comparison.scores.overall,
    duration_ratio: durationRatio,
    visual_similarity: comparison.scores.visual_similarity,
    match_type_distribution: {
      keyword: pipeline.match_breakdown?.keyword || 0,
      embedding: pipeline.match_breakdown?.embedding || 0,
      hold: pipeline.match_breakdown?.hold || 0,
      unmatched: pipeline.match_breakdown?.unmatched || 0,
    },
    processing_time_ms: runResult.elapsedMs,
    final_render_ms: pipeline.final_render?.duration_ms || null,
    error: null,
    warnings: runResult.warnings || [],
    pipeline,
    scores: comparison.scores,
    deltas: {
      ...comparison.deltas,
      duration_ratio: durationRatio,
    },
    generated: comparison.generated,
    referenceMeta: comparison.reference,
    visualSamples: comparison.visualSamples,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sets = selectSets(args);
  if (!sets.length) {
    throw new Error('실행할 샘플 세트가 없습니다.');
  }

  const results = [];
  for (const set of sets) {
    const runResult = await runPipelineValidationViaScript(set, args.timeoutMs);
    if (runResult.status !== 'ok') {
      results.push(buildSetResult(set, runResult, null));
      continue;
    }

    try {
      const comparison = await compareVideos(runResult.pipeline.final_path, set.reference);
      results.push(buildSetResult(set, runResult, comparison));
    } catch (error) {
      results.push({
        title: set.title,
        sourceVideo: set.sourceVideo,
        sourceAudio: set.sourceAudio,
        reference: set.reference,
        status: 'failed',
        overall: null,
        duration_ratio: null,
        visual_similarity: null,
        match_type_distribution: {
          keyword: runResult.pipeline.match_breakdown?.keyword || 0,
          embedding: runResult.pipeline.match_breakdown?.embedding || 0,
          hold: runResult.pipeline.match_breakdown?.hold || 0,
          unmatched: runResult.pipeline.match_breakdown?.unmatched || 0,
        },
        processing_time_ms: runResult.elapsedMs,
        error: `reference compare failed: ${error.message}`,
        warnings: runResult.warnings || [],
        pipeline: runResult.pipeline,
      });
    }
  }

  const completed = results.filter((item) => item.status === 'ok');
  const skipped = results.filter((item) => item.status === 'skipped_timeout').length;
  const failed = results.filter((item) => item.status === 'failed').length;

  const summary = {
    totalSets: results.length,
    completedSets: completed.length,
    skippedSets: skipped,
    failedSets: failed,
    timeoutMs: args.timeoutMs,
    averageOverall: average(completed, (item) => item.overall),
    averageDuration: average(completed, (item) => item.scores.duration),
    averageResolution: average(completed, (item) => item.scores.resolution),
    averageVisualSimilarity: average(completed, (item) => item.visual_similarity),
    averageDurationRatio: average(completed, (item) => item.duration_ratio),
    averageFinalRenderMs: average(completed, (item) => item.final_render_ms || 0),
    averageProcessingMs: average(completed, (item) => item.processing_time_ms || 0),
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    reportPath: path.resolve(args.output),
    summary,
    results,
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`);

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[final-reference-batch] compared=${summary.totalSets}`);
  console.log(`[final-reference-batch] avg overall=${summary.averageOverall} duration=${summary.averageDuration} resolution=${summary.averageResolution} visual=${summary.averageVisualSimilarity} duration_ratio=${summary.averageDurationRatio} render_ms=${summary.averageFinalRenderMs}`);
  for (const item of results) {
    if (item.status !== 'ok') {
      console.log(`[final-reference-batch] ${item.title}: status=${item.status} error=${item.error}`);
      continue;
    }
    console.log(`[final-reference-batch] ${item.title}: overall=${item.scores.overall} duration=${item.scores.duration} resolution=${item.scores.resolution} visual=${item.scores.visual_similarity} duration_ratio=${item.duration_ratio} render_ms=${item.final_render_ms || 0}`);
  }
  console.log(`[final-reference-batch] report=${path.resolve(args.output)}`);
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
