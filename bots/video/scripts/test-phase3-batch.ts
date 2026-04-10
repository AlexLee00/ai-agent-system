// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { loadConfig } = require('../src/index');
const { indexVideo } = require('../lib/scene-indexer');
const { analyzeNarration, buildOfflineNarrationFixture } = require('../lib/narration-analyzer');
const { buildSyncMap, syncMapToEDL } = require('../lib/sync-matcher');
const { renderPreview, saveEDL } = require('../lib/edl-builder');
const { compareVideos } = require('../lib/reference-quality');
const { normalizeAudio } = require('../lib/ffmpeg-preprocess');
const {
  generateSteps,
  attachRedEvaluation,
  attachBlueAlternative,
  applyUserAction,
  stepsToSyncMap,
  saveSteps,
} = require('../lib/step-proposal-engine');
const { SAMPLE_MAP } = require('./test-reference-quality');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const TEMP_ROOT = path.join(ROOT, 'temp');
const DEFAULT_REPORT_PATH = path.join(TEMP_ROOT, 'phase3_batch_report.json');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PHASE2_BASELINE = {
  averageOverall: 79.0,
  averageVisualSimilarity: 80.41,
};

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
    runSet: null,
  };

  for (const arg of argv) {
    if (arg === '--json') parsed.json = true;
    if (arg.startsWith('--limit=')) parsed.limit = Number.parseInt(arg.slice('--limit='.length), 10) || null;
    if (arg.startsWith('--title=')) parsed.title = arg.slice('--title='.length);
    if (arg.startsWith('--timeout-ms=')) parsed.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10) || DEFAULT_TIMEOUT_MS;
    if (arg.startsWith('--output=')) parsed.output = arg.slice('--output='.length) || DEFAULT_REPORT_PATH;
    if (arg.startsWith('--run-set=')) parsed.runSet = arg.slice('--run-set='.length) || null;
  }

  return parsed;
}

function average(list, selector, digits = 2) {
  if (!list.length) return 0;
  return Number((list.reduce((sum, item) => sum + Number(selector(item) || 0), 0) / list.length).toFixed(digits));
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

function findSampleByTitle(title) {
  return SAMPLE_SETS.find((sample) => sample.title === title) || null;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [
    raw.match(/\{[\s\S]*\}\s*$/)?.[0],
    raw,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // 다음 후보 시도
    }
  }
  return null;
}

function durationRatioFromComparison(comparison) {
  const generated = Number(comparison?.generated?.durationSec || 0);
  const reference = Number(comparison?.reference?.durationSec || 0);
  if (!reference) return null;
  return Number((generated / reference).toFixed(4));
}

function safeQualitySummary(comparison) {
  if (!comparison || comparison.error) return comparison || {};
  return {
    overall: Number(comparison?.scores?.overall || 0),
    duration_ratio: durationRatioFromComparison(comparison),
    resolution: Number(comparison?.scores?.resolution || 0),
    visual_similarity: Number(comparison?.scores?.visual_similarity || 0),
  };
}

async function runSingleSet(sample) {
  const config = loadConfig();
  const traceId = `phase3-batch-${sample.title}-${Date.now()}`;
  const workDir = path.join(TEMP_ROOT, `run-${traceId}`);
  fs.mkdirSync(workDir, { recursive: true });

  const startTime = Date.now();
  const mark = (label) => {
    console.error(`[phase3-batch] [${sample.title}] ${label} (${Date.now() - startTime}ms)`);
  };

  mark('start');
  const normalizedAudioPath = path.join(workDir, 'narration_norm.m4a');
  await normalizeAudio(path.resolve(sample.sourceAudio), normalizedAudioPath, config);
  mark('normalizeAudio done');

  const sceneIndex = await indexVideo(path.resolve(sample.sourceVideo), config, {
    tempDir: workDir,
    ocrEngine: 'cli',
  });
  mark('indexVideo done');

  let narrationAnalysis = null;
  let offlineNarrationFixture = false;
  try {
    narrationAnalysis = await analyzeNarration(normalizedAudioPath, config, {
      tempDir: workDir,
      correct: true,
    });
    mark('analyzeNarration done');
  } catch (error) {
    narrationAnalysis = await buildOfflineNarrationFixture(normalizedAudioPath, config, {
      sampleLabel: sample.sourceAudio,
    });
    offlineNarrationFixture = true;
    mark('offline narration fixture done');
  }

  const syncMap = await buildSyncMap(sceneIndex, narrationAnalysis, config, { tempDir: workDir });
  mark('buildSyncMap done');

  let steps = generateSteps(syncMap, config, {});
  steps = await attachRedEvaluation(steps, config);
  steps = await attachBlueAlternative(steps, sceneIndex, config);
  mark('generate steps done');

  for (const step of steps) {
    if (!step.user_action) {
      applyUserAction(steps, step.step_index, 'confirm');
    }
  }
  const stepsPath = saveSteps(steps, workDir);

  const confirmedSyncMap = stepsToSyncMap(steps);
  const edl = syncMapToEDL(
    confirmedSyncMap,
    path.resolve(sample.sourceVideo),
    normalizedAudioPath,
    null,
    null,
    config
  );
  const edlPath = path.join(workDir, 'edit_decision_list.phase3.json');
  saveEDL(edl, edlPath);
  mark('saveEDL done');

  const previewPath = path.join(workDir, 'preview.phase3.mp4');
  const previewRender = await renderPreview(edl, previewPath, config);
  mark('renderPreview done');

  let quality = null;
  try {
    quality = await compareVideos(previewPath, path.resolve(sample.reference));
    mark('compareVideos done');
  } catch (error) {
    quality = { error: error.message };
    mark(`compareVideos failed: ${error.message}`);
  }

  const autoConfirmedCount = steps.filter((step) => step.auto_confirm).length;
  const redEvaluatedCount = steps.filter((step) => step.red !== null).length;
  const blueSuggestedCount = steps.filter((step) => step.blue !== null).length;
  const totalSteps = steps.length;

  return {
    title: sample.title,
    status: 'ok',
    totalSteps,
    autoConfirmedCount,
    manualRequiredCount: Math.max(0, totalSteps - autoConfirmedCount),
    autoConfirmRate: totalSteps > 0 ? Number((autoConfirmedCount / totalSteps).toFixed(4)) : 0,
    redEvaluatedCount,
    blueSuggestedCount,
    quality: safeQualitySummary(quality),
    processing_time_ms: Date.now() - startTime,
    totalTimeMs: Date.now() - startTime,
    preview_render_ms: previewRender?.duration_ms || null,
    workDir,
    syncMapPath: syncMap.output_path || path.join(workDir, 'sync_map.json'),
    stepsPath,
    edlPath,
    previewPath,
    offlineNarrationFixture,
  };
}

async function runSingleSetMode(title) {
  const sample = findSampleByTitle(title);
  if (!sample) {
    throw new Error(`샘플 세트를 찾을 수 없습니다: ${title}`);
  }
  const result = await runSingleSet(sample);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runSetViaChildProcess(sample, timeoutMs) {
  const startedAt = Date.now();
  const scriptPath = path.join(__dirname, 'test-phase3-batch.js');
  try {
    const { stdout, stderr } = await execFileAsync('node', [scriptPath, `--run-set=${sample.title}`], {
      cwd: ROOT,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    return {
      status: 'ok',
      elapsedMs: Date.now() - startedAt,
      result: extractJsonObject(stdout),
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
        error: `timeout after ${timeoutMs}ms`,
      };
    }

    const stderr = error.stderr
      ? String(error.stderr).split('\n').map((line) => line.trim()).filter(Boolean)
      : [];
    return {
      status: 'error',
      elapsedMs,
      error: error.message,
      stderr,
    };
  }
}

function buildSetResult(sample, runResult) {
  if (runResult.status === 'ok' && !runResult.result) {
    return {
      title: sample.title,
      status: 'failed',
      totalSteps: null,
      autoConfirmedCount: null,
      manualRequiredCount: null,
      autoConfirmRate: 0,
      redEvaluatedCount: null,
      blueSuggestedCount: null,
      quality: {},
      totalTimeMs: runResult.elapsedMs,
      processing_time_ms: runResult.elapsedMs,
      error: 'single-run JSON parse failed',
      warnings: runResult.warnings || [],
    };
  }
  if (runResult.status !== 'ok') {
    return {
      title: sample.title,
      status: runResult.status === 'timeout' ? 'skipped_timeout' : 'failed',
      totalSteps: null,
      autoConfirmedCount: null,
      manualRequiredCount: null,
      autoConfirmRate: 0,
      redEvaluatedCount: null,
      blueSuggestedCount: null,
      quality: {},
      totalTimeMs: runResult.elapsedMs,
      processing_time_ms: runResult.elapsedMs,
      error: runResult.error || null,
      warnings: runResult.stderr || [],
    };
  }

  return {
    ...runResult.result,
    warnings: runResult.warnings || [],
    totalTimeMs: runResult.result.totalTimeMs || runResult.elapsedMs,
    processing_time_ms: runResult.result.processing_time_ms || runResult.elapsedMs,
    error: null,
  };
}

function buildSummary(results, timeoutMs, outputPath) {
  const successful = results.filter((item) => item.status === 'ok');
  const failed = results.filter((item) => item.status === 'failed').length;
  const skipped = results.filter((item) => item.status === 'skipped_timeout').length;
  const qualityResults = successful.filter((item) => !item.quality?.error);

  return {
    generatedAt: new Date().toISOString(),
    reportPath: path.resolve(outputPath),
    phase2Baseline: PHASE2_BASELINE,
    summary: {
      totalSets: results.length,
      successfulSets: successful.length,
      failedSets: failed,
      skippedSets: skipped,
      timeoutMs: timeoutMs,
      averageAutoConfirmRate: average(successful, (item) => item.autoConfirmRate, 4),
      averageOverall: qualityResults.length ? average(qualityResults, (item) => item.quality?.overall) : null,
      averageVisualSimilarity: qualityResults.length ? average(qualityResults, (item) => item.quality?.visual_similarity) : null,
      averageDurationRatio: qualityResults.length ? average(qualityResults, (item) => item.quality?.duration_ratio, 4) : null,
      totalRedEvaluations: successful.reduce((sum, item) => sum + Number(item.redEvaluatedCount || 0), 0),
      totalBlueSuggestions: successful.reduce((sum, item) => sum + Number(item.blueSuggestedCount || 0), 0),
      averageProcessingMs: average(successful, (item) => item.processing_time_ms || 0),
    },
    results,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.runSet) {
    await runSingleSetMode(args.runSet);
    return;
  }

  const sets = selectSets(args);
  if (!sets.length) {
    throw new Error('실행할 샘플 세트가 없습니다.');
  }

  const results = [];
  for (const sample of sets) {
    const runResult = await runSetViaChildProcess(sample, args.timeoutMs);
    results.push(buildSetResult(sample, runResult));
  }

  const payload = buildSummary(results, args.timeoutMs, args.output);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const summary = payload.summary;
  console.log('=== Phase 3 vs Phase 2 비교 ===');
  console.log(`Phase 2 baseline: averageOverall=${PHASE2_BASELINE.averageOverall.toFixed(2)}, averageVisualSimilarity=${PHASE2_BASELINE.averageVisualSimilarity.toFixed(2)}`);
  console.log(`Phase 3 결과:     averageOverall=${summary.averageOverall ?? 'N/A'}, averageVisualSimilarity=${summary.averageVisualSimilarity ?? 'N/A'}`);
  console.log(`자동화율:         ${(Number(summary.averageAutoConfirmRate || 0) * 100).toFixed(1)}%`);
  console.log(`RED 평가:         총 ${summary.totalRedEvaluations}회`);
  console.log(`BLUE 대안:        총 ${summary.totalBlueSuggestions}회`);
  console.log(`리포트 저장:      ${path.resolve(args.output)}`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('[video] test-phase3-batch 실패:', error.message);
    process.exit(1);
  });
