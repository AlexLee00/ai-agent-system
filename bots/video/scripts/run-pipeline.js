'use strict';

const fs = require('fs');
const path = require('path');

const pgPool = require('../../../packages/core/lib/pg-pool');
const telegramSender = require('../../../packages/core/lib/telegram-sender');
const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { startTrace, withTrace } = require('../../../packages/core/lib/trace');

const { loadConfig } = require('../src/index');
const {
  removeAudio,
  normalizeAudio,
  syncVideoAudio,
  probeDurationMs,
} = require('../lib/ffmpeg-preprocess');
const { generateSubtitle } = require('../lib/whisper-client');
const { correctFile } = require('../lib/subtitle-corrector');
const { buildDraft } = require('../lib/capcut-draft-builder');
const {
  analyzeVideo,
  saveAnalysis,
} = require('../lib/video-analyzer');
const {
  buildInitialEDL,
  saveEDL,
  renderPreview,
  renderFinal,
  convertSrtToVtt,
} = require('../lib/edl-builder');

const BOT_NAME = 'video';
const TEAM_NAME = 'video';
const PROJECT_ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(PROJECT_ROOT, 'samples');
const RAW_DIR = path.join(SAMPLES_DIR, 'raw');
const NARRATION_DIR = path.join(SAMPLES_DIR, 'narration');
const TEMP_ROOT = path.join(PROJECT_ROOT, 'temp');
const EXPORTS_DIR = path.join(PROJECT_ROOT, 'exports');
const PIPELINE_LOCK_PATH = path.join(TEMP_ROOT, '.run-pipeline.lock.json');

function parseArgs(argv) {
  const parsed = {
    source: null,
    sourceVideo: null,
    sourceAudio: null,
    skipRender: false,
    withCapcut: false,
  };

  for (const arg of argv) {
    if (arg === '--skip-render') {
      parsed.skipRender = true;
      continue;
    }
    if (arg === '--with-capcut') {
      parsed.withCapcut = true;
      continue;
    }
    if (arg.startsWith('--source=')) {
      parsed.source = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--source-video=')) {
      parsed.sourceVideo = arg.slice('--source-video='.length);
      continue;
    }
    if (arg.startsWith('--source-audio=')) {
      parsed.sourceAudio = arg.slice('--source-audio='.length);
      continue;
    }
  }

  return parsed;
}

function toErrorMessage(error) {
  if (!error) return '알 수 없는 오류';
  if (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors.map(inner => inner.message || String(inner)).join(' | ');
  }
  return error.stderr || error.stdout || error.message || String(error);
}

function sanitizeTitle(title) {
  return String(title || 'video')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function printBanner(title) {
  console.log('[video] ══════════════════════════════════');
  console.log(`[video] 파이프라인 시작: ${title}`);
  console.log('[video] ══════════════════════════════════');
}

function printDone(totalMs, outputPath) {
  console.log('[video] ══════════════════════════════════');
  console.log(`[video] 파이프라인 완료! 총 ${totalMs}ms`);
  console.log(`[video] 출력: ${outputPath}`);
  console.log('[video] ══════════════════════════════════');
}

function readLockFile(lockPath = PIPELINE_LOCK_PATH) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function acquirePipelineLock(lockPayload, lockPath = PIPELINE_LOCK_PATH) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify(lockPayload, null, 2), 'utf8');
    fs.closeSync(fd);
    return lockPath;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = readLockFile(lockPath);
    if (existing && !isProcessAlive(Number(existing.pid))) {
      fs.unlinkSync(lockPath);
      return acquirePipelineLock(lockPayload, lockPath);
    }
    const detail = existing
      ? `pid=${existing.pid}, trace_id=${existing.trace_id}, title=${existing.title}, started_at=${existing.started_at}`
      : '기존 lock 상세를 읽을 수 없음';
    throw new Error(`다른 video pipeline 실행이 이미 진행 중입니다. (${detail})`);
  }
}

function releasePipelineLock(lockPath = PIPELINE_LOCK_PATH, traceId = null) {
  if (!fs.existsSync(lockPath)) return;
  const current = readLockFile(lockPath);
  if (traceId && current && current.trace_id && current.trace_id !== traceId) {
    return;
  }
  fs.unlinkSync(lockPath);
}

function collectSamplePairs() {
  const normalizeName = name => name.normalize('NFC');
  const rawEntries = fs.readdirSync(RAW_DIR)
    .filter(name => normalizeName(name).startsWith('원본_') && normalizeName(name).endsWith('.mp4'))
    .map(name => ({
      rawName: name,
      stem: normalizeName(name).replace(/^원본_/, '').replace(/\.mp4$/, ''),
      rawPath: path.join(RAW_DIR, name),
    }));

  const preferredOrder = ['파라미터', 'DB생성', '동적데이터', '서버인증', '컴포넌트스테이트'];

  rawEntries.sort((a, b) => {
    const aIndex = preferredOrder.indexOf(a.stem);
    const bIndex = preferredOrder.indexOf(b.stem);
    if (aIndex !== -1 || bIndex !== -1) {
      return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex)
        - (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
    }
    return a.stem.localeCompare(b.stem, 'ko');
  });

  return rawEntries.map(entry => {
    const narrationFile = fs.readdirSync(NARRATION_DIR)
      .find(name => normalizeName(name) === `원본_나레이션_${entry.stem}.m4a`);

    if (!narrationFile) {
      throw new Error(`샘플 나레이션을 찾을 수 없습니다: ${entry.stem}`);
    }

    return {
      index: 0,
      title: entry.stem,
      sourceDir: SAMPLES_DIR,
      rawVideoPath: entry.rawPath,
      rawAudioPath: path.join(NARRATION_DIR, narrationFile),
    };
  }).map((entry, index) => ({ ...entry, index: index + 1 }));
}

function resolveSources(options) {
  if (options.sourceVideo || options.sourceAudio) {
    if (!options.sourceVideo || !options.sourceAudio) {
      throw new Error('--source-video와 --source-audio는 함께 지정해야 합니다.');
    }

    const videoPath = path.resolve(options.sourceVideo);
    const audioPath = path.resolve(options.sourceAudio);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`원본 영상 파일을 찾을 수 없습니다: ${videoPath}`);
    }
    if (!fs.existsSync(audioPath)) {
      throw new Error(`원본 오디오 파일을 찾을 수 없습니다: ${audioPath}`);
    }

    const videoBase = path.basename(videoPath, path.extname(videoPath)).normalize('NFC');
    const derivedTitle = videoBase.replace(/^원본_/, '');

    return {
      sourceDir: path.dirname(videoPath),
      rawVideoPath: videoPath,
      rawAudioPath: audioPath,
      title: derivedTitle,
      sourceLabel: derivedTitle,
    };
  }

  const sampleIndex = Number.parseInt(options.source || '1', 10);
  if (!Number.isInteger(sampleIndex) || sampleIndex <= 0) {
    throw new Error('--source는 1 이상의 정수여야 합니다.');
  }

  const samples = collectSamplePairs();
  const selected = samples.find(sample => sample.index === sampleIndex);
  if (!selected) {
    throw new Error(`--source=${sampleIndex} 에 해당하는 샘플이 없습니다.`);
  }

  return {
    sourceDir: selected.sourceDir,
    rawVideoPath: selected.rawVideoPath,
    rawAudioPath: selected.rawAudioPath,
    title: selected.title,
    sourceLabel: selected.title,
  };
}

async function updateVideoEdit(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const setClauses = keys.map((key, index) => `${key} = $${index + 1}`);
  const params = keys.map(key => fields[key]);
  params.push(id);

  await pgPool.run(
    'public',
    `UPDATE video_edits
        SET ${setClauses.join(', ')},
            updated_at = NOW()
      WHERE id = $${params.length}`,
    params
  );
}

async function insertVideoEdit(payload) {
  const rows = await pgPool.query(
    'public',
    `INSERT INTO video_edits (
      source_dir,
      title,
      raw_video_path,
      raw_audio_path,
      raw_duration_ms,
      status,
      trace_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id`,
    [
      payload.source_dir,
      payload.title,
      payload.raw_video_path,
      payload.raw_audio_path,
      payload.raw_duration_ms,
      payload.status,
      payload.trace_id,
    ]
  );
  return rows[0]?.id;
}

function summarizeAnalysis(analysis) {
  return `무음 ${analysis.silences.length}건, 정지 ${analysis.freezes.length}건, 씬전환 ${analysis.scenes.length}건`;
}

function summarizeEdl(edl) {
  const counts = (edl.edits || []).reduce((acc, edit) => {
    acc[edit.type] = (acc[edit.type] || 0) + 1;
    return acc;
  }, {});
  return {
    count: edl.edits.length,
    counts,
  };
}

async function notifyFailure(step, title, error) {
  const message = [
    '[비디오] 실패',
    `제목: ${title}`,
    `단계: ${step}`,
    `사유: ${toErrorMessage(error)}`,
  ].join('\n');
  await telegramSender.send(TEAM_NAME, message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const traceContext = startTrace({ bot: BOT_NAME, action: 'run_pipeline' });

  return withTrace(traceContext, async () => {
    const startedAt = Date.now();
    const traceId = traceContext.trace_id;
    const source = resolveSources(args);
    const title = sanitizeTitle(source.title);
    const titleForMessage = source.title;
    const sessionDir = path.join(TEMP_ROOT, `run-${traceId.slice(0, 8)}`);
    const outputName = `편집_${title}.mp4`;
    let currentStep = 'initializing';
    let lockAcquired = false;

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    acquirePipelineLock({
      pid: process.pid,
      trace_id: traceId,
      title,
      started_at: new Date().toISOString(),
      source_video_path: source.rawVideoPath,
      source_audio_path: source.rawAudioPath,
    });
    lockAcquired = true;
    const releaseCurrentLock = () => {
      if (lockAcquired) {
        releasePipelineLock(PIPELINE_LOCK_PATH, traceId);
        lockAcquired = false;
      }
    };
    process.once('SIGINT', () => {
      releaseCurrentLock();
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      releaseCurrentLock();
      process.exit(143);
    });

    const rawDurationMs = await probeDurationMs(source.rawVideoPath);
    const recordId = await insertVideoEdit({
      source_dir: source.sourceDir,
      title,
      raw_video_path: source.rawVideoPath,
      raw_audio_path: source.rawAudioPath,
      raw_duration_ms: rawDurationMs,
      status: 'processing',
      trace_id: traceId,
    });

    const analysisPath = path.join(sessionDir, 'analysis.json');
    const correctedSrtPath = path.join(sessionDir, 'subtitle_corrected.srt');
    const edlPath = path.join(sessionDir, 'edit_decision_list.json');
    const previewPath = path.join(sessionDir, 'preview.mp4');
    const vttPath = path.join(sessionDir, 'subtitle.vtt');
    const exportPath = path.join(EXPORTS_DIR, outputName);

    let syncedPath = null;
    let normalizedAudioPath = null;
    let rawSrtPath = null;
    let draftPath = null;

    printBanner(titleForMessage);

    try {
      currentStep = 'preprocess';
      console.log('[video] [1/7] 전처리 중...');
      const preprocessStartedAt = Date.now();
      const videoNoAudioPath = path.join(sessionDir, 'video_noaudio.mp4');
      normalizedAudioPath = path.join(sessionDir, 'narr_norm.m4a');
      syncedPath = path.join(sessionDir, 'synced.mp4');

      await removeAudio(source.rawVideoPath, videoNoAudioPath);
      await normalizeAudio(source.rawAudioPath, normalizedAudioPath, config);
      const syncResult = await syncVideoAudio(videoNoAudioPath, normalizedAudioPath, syncedPath);
      const preprocessMs = Date.now() - preprocessStartedAt;
      console.log(`[video] [1/7] 전처리 완료 (${preprocessMs}ms)`);

      await updateVideoEdit(recordId, {
        preprocess_ms: preprocessMs,
        status: 'preprocessing_done',
      });

      currentStep = 'stt';
      console.log('[video] [2/7] STT 중...');
      const sttStartedAt = Date.now();
      rawSrtPath = path.join(sessionDir, 'subtitle_raw.srt');
      const subtitleResult = await generateSubtitle(normalizedAudioPath, rawSrtPath, config);
      const sttMs = Date.now() - sttStartedAt;
      console.log(`[video] [2/7] STT 완료 (${sttMs}ms)`);

      await updateVideoEdit(recordId, {
        srt_raw_path: subtitleResult.srtPath,
        whisper_cost: subtitleResult.cost,
        stt_ms: sttMs,
        status: 'stt_done',
      });

      currentStep = 'correction';
      console.log('[video] [3/7] 자막 교정 중...');
      const correctionStartedAt = Date.now();
      const correctionResult = await correctFile(rawSrtPath, correctedSrtPath, config);
      const correctionMs = Date.now() - correctionStartedAt;
      const correctionCost = correctionResult.stats?.cost || 0;
      console.log(`[video] [3/7] 자막 교정 완료 (${correctionMs}ms)`);

      await updateVideoEdit(recordId, {
        srt_corrected_path: correctionResult.outputPath,
        correction_cost: correctionCost,
        correction_ms: correctionMs,
        status: 'correction_done',
      });

      currentStep = 'analysis';
      console.log('[video] [4/7] 영상 분석 중...');
      const analysis = await analyzeVideo(syncedPath, config);
      saveAnalysis(analysis, analysisPath);
      console.log(`[video] [4/7] 영상 분석 완료 (${summarizeAnalysis(analysis)})`);

      currentStep = 'edl';
      console.log('[video] [5/7] EDL 생성 중...');
      const edl = buildInitialEDL(syncedPath, correctedSrtPath, analysis, { title });
      saveEDL(edl, edlPath);
      const edlSummary = summarizeEdl(edl);
      console.log(`[video] [5/7] EDL 생성 완료 (edits ${edlSummary.count}건)`, edlSummary.counts);

      currentStep = 'preview';
      console.log('[video] [6/7] 프리뷰 렌더링 중...');
      const previewResult = await renderPreview(edl, previewPath, config);
      const previewStats = fs.statSync(previewPath);
      convertSrtToVtt(correctedSrtPath, vttPath);
      console.log(
        `[video] [6/7] 프리뷰 완료 (${previewResult.duration_ms}ms, ${(previewStats.size / 1024 / 1024).toFixed(2)}MB)`
      );
      console.log(`[video] 프리뷰: ${previewPath}`);

      await updateVideoEdit(recordId, {
        status: 'preview_ready',
      });

      if (args.skipRender) {
        const totalMs = Date.now() - startedAt;
        console.log(`[video] 프리뷰 렌더링 완료. 프리뷰를 확인하세요: ${previewPath}`);
        await updateVideoEdit(recordId, {
          total_ms: totalMs,
          status: 'preview_ready',
        });
        printDone(totalMs, previewPath);
        return;
      }

      if (args.withCapcut) {
        currentStep = 'capcut';
        console.log('[video] [옵션] CapCut 드래프트 생성 중...');
        const draftStartedAt = Date.now();
        const draftResult = await buildDraft(config, syncedPath, normalizedAudioPath, correctedSrtPath, title);
        draftPath = draftResult.capCutPath || draftResult.draftPath;
        const draftMs = Date.now() - draftStartedAt;
        console.log(`[video] [옵션] CapCut 드래프트 완료 (${draftMs}ms)`);
        await updateVideoEdit(recordId, {
          draft_path: draftPath,
          draft_ms: draftMs,
        });
      }

      currentStep = 'render_final';
      console.log('[video] [7/7] 최종 렌더링 중...');
      const renderStartedAt = Date.now();
      const renderResult = await renderFinal(edl, exportPath, config);
      const renderMs = Date.now() - renderStartedAt;
      const totalMs = Date.now() - startedAt;
      const outputDurationMs = await probeDurationMs(renderResult.outputPath);
      const outputSizeMb = Number((renderResult.fileSize / 1024 / 1024).toFixed(2));

      await updateVideoEdit(recordId, {
        output_path: renderResult.outputPath,
        output_size_mb: outputSizeMb,
        output_duration_ms: outputDurationMs,
        render_ms: renderMs,
        total_ms: totalMs,
        draft_path: draftPath,
        status: 'completed',
      });

      await telegramSender.send(TEAM_NAME, [
        '[비디오] 렌더링 완료',
        `제목: ${titleForMessage}`,
        `파일: ${renderResult.outputPath}`,
        `총 시간: ${totalMs}ms`,
      ].join('\n'));

      printDone(totalMs, renderResult.outputPath);
    } catch (error) {
      const message = toErrorMessage(error);
      const totalMs = Date.now() - startedAt;
      await updateVideoEdit(recordId, {
        total_ms: totalMs,
        draft_path: draftPath,
        status: 'failed',
        error_message: message,
      });
      await notifyFailure('run-pipeline', titleForMessage, error);
      await logToolCall('video_pipeline', 'run_pipeline', {
        bot: BOT_NAME,
        success: false,
        duration_ms: totalMs,
        error: message,
        metadata: {
          title,
          traceId,
          currentStep,
          sourceVideoPath: source.rawVideoPath,
          sourceAudioPath: source.rawAudioPath,
        },
      });
      console.error(`[video] 파이프라인 실패: ${message}`);
      process.exitCode = 1;
    } finally {
      releaseCurrentLock();
    }
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error('[video] 파이프라인 예외:', toErrorMessage(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveSources,
  main,
};
