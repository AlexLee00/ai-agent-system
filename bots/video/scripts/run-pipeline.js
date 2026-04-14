'use strict';

const fs = require('fs');
const path = require('path');
const { applyMediaBinaryEnv } = require('../lib/media-binary-env');

applyMediaBinaryEnv(process.env);

const pgPool = require('../../../packages/core/lib/pg-pool');
const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub');
const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { startTrace, withTrace } = require('../../../packages/core/lib/trace');

const { loadConfig } = require('../src/index');
const {
  normalizeAudio,
  probeDurationMs,
} = require('../lib/ffmpeg-preprocess');
const { generateSubtitle } = require('../lib/whisper-client');
const { correctFile } = require('../lib/subtitle-corrector');
const { buildDraft } = require('../lib/capcut-draft-builder');
const {
  saveEDL,
  renderPreview,
  renderFinal,
  convertSrtToVtt,
} = require('../lib/edl-builder');
const { storeEditResult } = require('../lib/video-rag');
const { indexVideo } = require('../lib/scene-indexer');
const { parseSrt, analyzeSegments } = require('../lib/narration-analyzer');
const { buildSyncMap, syncMapToEDL } = require('../lib/sync-matcher');
const { processIntroOutro } = require('../lib/intro-outro-handler');

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
    sessionId: null,
    pairIndex: null,
    title: null,
    editNotes: null,
    skipRender: false,
    withCapcut: false,
    introMode: 'none',
    introFile: null,
    introPrompt: null,
    introDuration: null,
    introLogo: null,
    outroMode: 'none',
    outroFile: null,
    outroPrompt: null,
    outroDuration: null,
    outroLogo: null,
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
    if (arg.startsWith('--session-id=')) {
      parsed.sessionId = Number.parseInt(arg.slice('--session-id='.length), 10) || null;
      continue;
    }
    if (arg.startsWith('--pair-index=')) {
      parsed.pairIndex = Number.parseInt(arg.slice('--pair-index='.length), 10) || null;
      continue;
    }
    if (arg.startsWith('--title=')) {
      parsed.title = arg.slice('--title='.length);
      continue;
    }
    if (arg.startsWith('--edit-notes=')) {
      parsed.editNotes = arg.slice('--edit-notes='.length);
      continue;
    }
    if (arg.startsWith('--intro-mode=')) {
      parsed.introMode = arg.slice('--intro-mode='.length) || 'none';
      continue;
    }
    if (arg.startsWith('--intro-file=')) {
      parsed.introFile = arg.slice('--intro-file='.length) || null;
      continue;
    }
    if (arg.startsWith('--intro-prompt=')) {
      parsed.introPrompt = arg.slice('--intro-prompt='.length) || null;
      continue;
    }
    if (arg.startsWith('--intro-duration=')) {
      parsed.introDuration = Number.parseFloat(arg.slice('--intro-duration='.length)) || null;
      continue;
    }
    if (arg.startsWith('--intro-logo=')) {
      parsed.introLogo = arg.slice('--intro-logo='.length) || null;
      continue;
    }
    if (arg.startsWith('--outro-mode=')) {
      parsed.outroMode = arg.slice('--outro-mode='.length) || 'none';
      continue;
    }
    if (arg.startsWith('--outro-file=')) {
      parsed.outroFile = arg.slice('--outro-file='.length) || null;
      continue;
    }
    if (arg.startsWith('--outro-prompt=')) {
      parsed.outroPrompt = arg.slice('--outro-prompt='.length) || null;
      continue;
    }
    if (arg.startsWith('--outro-duration=')) {
      parsed.outroDuration = Number.parseFloat(arg.slice('--outro-duration='.length)) || null;
      continue;
    }
    if (arg.startsWith('--outro-logo=')) {
      parsed.outroLogo = arg.slice('--outro-logo='.length) || null;
      continue;
    }
  }

  return parsed;
}

function shiftSrtTimecode(timecode, offsetSec) {
  const match = String(timecode || '').match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return timecode;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = Number(match[3]);
  const ms = Number(match[4]);
  const totalMs = Math.max(0, (((hh * 60) + mm) * 60 + ss) * 1000 + ms + Math.round(offsetSec * 1000));
  const nextH = String(Math.floor(totalMs / 3600000)).padStart(2, '0');
  const nextM = String(Math.floor((totalMs % 3600000) / 60000)).padStart(2, '0');
  const nextS = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, '0');
  const nextMs = String(totalMs % 1000).padStart(3, '0');
  return `${nextH}:${nextM}:${nextS},${nextMs}`;
}

function shiftSrtFile(inputPath, outputPath, offsetSec) {
  if (!offsetSec) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  const text = fs.readFileSync(inputPath, 'utf8');
  const shifted = text.replace(
    /(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g,
    (_match, start, end) => `${shiftSrtTimecode(start, offsetSec)} --> ${shiftSrtTimecode(end, offsetSec)}`
  );
  fs.writeFileSync(outputPath, shifted, 'utf8');
  return outputPath;
}

function summarizeSyncMap(syncMap) {
  return `keyword ${syncMap.matched_keyword}, embedding ${syncMap.matched_embedding}, hold ${syncMap.matched_hold}, unmatched ${syncMap.unmatched}`;
}

function buildIntroOutroOptions(args, config, sessionDir, title) {
  return {
    intro: {
      mode: args.introMode || 'none',
      filePath: args.introFile ? path.resolve(args.introFile) : null,
      prompt: args.introPrompt || null,
      logoPath: args.introLogo ? path.resolve(args.introLogo) : null,
      durationSec: args.introDuration || config?.intro_outro?.default_intro_duration_sec || 3,
      title,
    },
    outro: {
      mode: args.outroMode || 'none',
      filePath: args.outroFile ? path.resolve(args.outroFile) : null,
      prompt: args.outroPrompt || null,
      logoPath: args.outroLogo ? path.resolve(args.outroLogo) : null,
      durationSec: args.outroDuration || config?.intro_outro?.default_outro_duration_sec || 5,
      title,
    },
    targetWidth: Number(config?.ffmpeg?.render_width || 2560),
    targetHeight: Number(config?.ffmpeg?.render_height || 1440),
    targetFps: Number(config?.ffmpeg?.render_fps || 60),
    tempDir: sessionDir,
  };
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
      session_id,
      pair_index,
      source_dir,
      title,
      raw_video_path,
      raw_audio_path,
      raw_duration_ms,
      status,
      trace_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id`,
    [
      payload.session_id,
      payload.pair_index,
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

function summarizeEdl(edl) {
  const clips = Array.isArray(edl.clips) ? edl.clips : [];
  if (clips.length) {
    const counts = clips.reduce((acc, clip) => {
      acc[clip.clip_type] = (acc[clip.clip_type] || 0) + 1;
      return acc;
    }, {});
    return { count: clips.length, counts };
  }

  const counts = (edl.edits || []).reduce((acc, edit) => {
    acc[edit.type] = (acc[edit.type] || 0) + 1;
    return acc;
  }, {});
  return {
    count: edl.edits.length,
    counts,
  };
}

function countSubtitleEntries(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .trim()
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .length;
}

async function notifyFailure(step, title, error) {
  const message = [
    '[비디오] 실패',
    `제목: ${title}`,
    `단계: ${step}`,
    `사유: ${toErrorMessage(error)}`,
  ].join('\n');
  await publishToWebhook({
    event: {
      from_bot: 'run-pipeline',
      team: TEAM_NAME,
      event_type: 'video_pipeline_failed',
      alert_level: 2,
      message,
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const traceContext = startTrace({ bot: BOT_NAME, action: 'run_pipeline' });

  return withTrace(traceContext, async () => {
    const startedAt = Date.now();
    const traceId = traceContext.trace_id;
    const source = resolveSources(args);
    const titleSource = sanitizeTitle(args.title || source.title);
    const title = titleSource;
    const titleForMessage = args.title || source.title;
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
      session_id: args.sessionId,
      pair_index: args.pairIndex,
      source_dir: source.sourceDir,
      title,
      raw_video_path: source.rawVideoPath,
      raw_audio_path: source.rawAudioPath,
      raw_duration_ms: rawDurationMs,
      status: 'processing',
      trace_id: traceId,
    });

    const sceneIndexPath = path.join(sessionDir, 'scene_index.json');
    const narrationSegmentsPath = path.join(sessionDir, 'narration_segments.json');
    const syncMapPath = path.join(sessionDir, 'sync_map.json');
    const correctedSrtPath = path.join(sessionDir, 'subtitle_corrected.srt');
    const shiftedSrtPath = path.join(sessionDir, 'subtitle_timeline.srt');
    const edlPath = path.join(sessionDir, 'edit_decision_list.json');
    const previewPath = path.join(sessionDir, 'preview.mp4');
    const vttPath = path.join(sessionDir, 'subtitle.vtt');
    const exportPath = path.join(EXPORTS_DIR, outputName);

    let normalizedAudioPath = null;
    let rawSrtPath = null;
    let draftPath = null;
    let sceneIndex = null;
    let narrationAnalysis = null;
    let syncMap = null;
    let introOutro = { introClip: null, outroClip: null };
    let edl = null;

    printBanner(titleForMessage);

    try {
      currentStep = 'preprocess';
      console.log('[video] [1/10] 나레이션 정규화 중...');
      const preprocessStartedAt = Date.now();
      normalizedAudioPath = path.join(sessionDir, 'narr_norm.m4a');
      await normalizeAudio(source.rawAudioPath, normalizedAudioPath, config);
      const preprocessMs = Date.now() - preprocessStartedAt;
      console.log(`[video] [1/10] 나레이션 정규화 완료 (${preprocessMs}ms)`);

      await updateVideoEdit(recordId, {
        preprocess_ms: preprocessMs,
        status: 'preprocessing_done',
      });

      currentStep = 'stt';
      console.log('[video] [2/10] 나레이션 STT 중...');
      const sttStartedAt = Date.now();
      rawSrtPath = path.join(sessionDir, 'subtitle_raw.srt');
      const subtitleResult = await generateSubtitle(normalizedAudioPath, rawSrtPath, config);
      const sttMs = Date.now() - sttStartedAt;
      console.log(`[video] [2/10] 나레이션 STT 완료 (${sttMs}ms)`);

      await updateVideoEdit(recordId, {
        srt_raw_path: subtitleResult.srtPath,
        whisper_cost: subtitleResult.cost,
        stt_ms: sttMs,
        status: 'stt_done',
      });

      currentStep = 'correction';
      console.log('[video] [3/10] 자막 교정 중...');
      const correctionStartedAt = Date.now();
      const correctionResult = await correctFile(rawSrtPath, correctedSrtPath, config);
      const correctionMs = Date.now() - correctionStartedAt;
      const correctionCost = correctionResult.stats?.cost || 0;
      console.log(`[video] [3/10] 자막 교정 완료 (${correctionMs}ms)`);

      await updateVideoEdit(recordId, {
        srt_corrected_path: correctionResult.outputPath,
        correction_cost: correctionCost,
        correction_ms: correctionMs,
        status: 'correction_done',
      });

      currentStep = 'scene_index';
      console.log('[video] [4/10] 원본 장면 인덱싱 중...');
      sceneIndex = await indexVideo(source.rawVideoPath, config, { tempDir: sessionDir });
      fs.copyFileSync(sceneIndex.output_path, sceneIndexPath);
      console.log(`[video] [4/10] 원본 장면 인덱싱 완료 (unique ${sceneIndex.unique_frames})`);

      currentStep = 'narration_analysis';
      console.log('[video] [5/10] 나레이션 구간 분석 중...');
      const correctedSrtText = fs.readFileSync(correctedSrtPath, 'utf8');
      const narrationEntries = parseSrt(correctedSrtText);
      const narrationSegments = await analyzeSegments(narrationEntries, config);
      narrationAnalysis = {
        source_audio: path.basename(normalizedAudioPath),
        source_audio_path: normalizedAudioPath,
        duration_s: Number((await probeDurationMs(normalizedAudioPath) / 1000).toFixed(3)),
        total_entries: narrationEntries.length,
        total_segments: narrationSegments.length,
        segments: narrationSegments,
        srt_path: rawSrtPath,
        corrected_srt_path: correctedSrtPath,
      };
      fs.writeFileSync(narrationSegmentsPath, JSON.stringify(narrationAnalysis, null, 2), 'utf8');
      console.log(`[video] [5/10] 나레이션 구간 분석 완료 (segments ${narrationAnalysis.total_segments})`);

      currentStep = 'sync_match';
      console.log('[video] [6/10] AI 싱크 매칭 중...');
      syncMap = await buildSyncMap(sceneIndex, narrationAnalysis, config, { tempDir: sessionDir });
      fs.copyFileSync(syncMap.output_path, syncMapPath);
      console.log(`[video] [6/10] AI 싱크 매칭 완료 (${summarizeSyncMap(syncMap)})`);

      currentStep = 'intro_outro';
      console.log('[video] [7/10] 인트로/아웃트로 처리 중...');
      introOutro = await processIntroOutro(
        config,
        buildIntroOutroOptions(args, config, sessionDir, titleForMessage)
      );
      shiftSrtFile(correctedSrtPath, shiftedSrtPath, Number(introOutro?.introClip?.durationSec || 0));
      convertSrtToVtt(shiftedSrtPath, vttPath);
      console.log('[video] [7/10] 인트로/아웃트로 처리 완료');

      currentStep = 'edl';
      console.log('[video] [8/10] EDL 생성 중...');
      edl = syncMapToEDL(
        syncMap,
        source.rawVideoPath,
        normalizedAudioPath,
        introOutro?.introClip,
        introOutro?.outroClip,
        config
      );
      edl.title = titleForMessage;
      edl.subtitle = shiftedSrtPath;
      saveEDL(edl, edlPath);
      const edlSummary = summarizeEdl(edl);
      console.log(`[video] [8/10] EDL 생성 완료 (clips ${edlSummary.count}건)`, edlSummary.counts);

      currentStep = 'preview';
      console.log('[video] [9/10] 프리뷰 렌더링 중...');
      const previewResult = await renderPreview(edl, previewPath, config);
      const previewStats = fs.statSync(previewPath);
      console.log(
        `[video] [9/10] 프리뷰 완료 (${previewResult.duration_ms}ms, ${(previewStats.size / 1024 / 1024).toFixed(2)}MB)`
      );
      console.log(`[video] 프리뷰: ${previewPath}`);

      await updateVideoEdit(recordId, {
        preview_ms: previewResult.duration_ms,
        status: 'preview_ready',
      });

      if (args.skipRender) {
        const totalMs = Date.now() - startedAt;
        console.log(`[video] 프리뷰 렌더링 완료. 프리뷰를 확인하세요: ${previewPath}`);
        await updateVideoEdit(recordId, {
          total_ms: totalMs,
          status: 'preview_ready',
        });
        try {
          const transitionCount = (edl?.edits || []).filter((item) => item.type === 'transition').length;
          const cutCount = Array.isArray(edl?.clips) ? edl.clips.length : (edl?.edits || []).filter((item) => item.type === 'cut').length;
          await storeEditResult({
            editId: recordId,
            sessionId: args.sessionId,
            pairIndex: args.pairIndex,
            title,
            duration: edl?.duration || narrationAnalysis?.duration_s || 0,
            subtitleCount: countSubtitleEntries(shiftedSrtPath),
            qualityScore: 0,
            qualityPass: false,
            cutCount,
            transitionCount,
            silenceCount: 0,
            freezeCount: 0,
            subtitleIssuesCount: 0,
            audioIssuesCount: 0,
            edlEditTypes: Array.isArray(edl?.clips)
              ? edl.clips.map((item) => item.clip_type)
              : (edl?.edits || []).map((item) => item.type),
            totalMs,
            totalCostUsd: 0,
            videoWidth: config?.ffmpeg?.render_width || 0,
            videoHeight: config?.ffmpeg?.render_height || 0,
            videoFps: config?.ffmpeg?.render_fps || 0,
          }, config);
        } catch (error) {
          console.warn('[video] RAG 저장 실패 (무시):', toErrorMessage(error));
        }
        printDone(totalMs, previewPath);
        return;
      }

      if (args.withCapcut) {
        currentStep = 'capcut';
        console.log('[video] [옵션] CapCut 드래프트 생성 중...');
        const draftStartedAt = Date.now();
        const draftResult = await buildDraft(config, source.rawVideoPath, normalizedAudioPath, shiftedSrtPath, title);
        draftPath = draftResult.capCutPath || draftResult.draftPath;
        const draftMs = Date.now() - draftStartedAt;
        console.log(`[video] [옵션] CapCut 드래프트 완료 (${draftMs}ms)`);
        await updateVideoEdit(recordId, {
          draft_path: draftPath,
          draft_ms: draftMs,
        });
      }

      currentStep = 'render_final';
      console.log('[video] [10/10] 최종 렌더링 중...');
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

      await publishToWebhook({
        event: {
          from_bot: 'run-pipeline',
          team: TEAM_NAME,
          event_type: 'video_pipeline_completed',
          alert_level: 2,
          message: [
            '[비디오] 렌더링 완료',
            `제목: ${titleForMessage}`,
            `파일: ${renderResult.outputPath}`,
            `총 시간: ${totalMs}ms`,
          ].join('\n'),
        },
      });

      try {
        const transitionCount = (edl?.edits || []).filter((item) => item.type === 'transition').length;
        const cutCount = Array.isArray(edl?.clips) ? edl.clips.length : (edl?.edits || []).filter((item) => item.type === 'cut').length;
        await storeEditResult({
          editId: recordId,
          sessionId: args.sessionId,
          pairIndex: args.pairIndex,
          title,
          duration: edl?.duration || narrationAnalysis?.duration_s || 0,
          subtitleCount: countSubtitleEntries(shiftedSrtPath),
          qualityScore: 0,
          qualityPass: false,
          cutCount,
          transitionCount,
          silenceCount: 0,
          freezeCount: 0,
          subtitleIssuesCount: 0,
          audioIssuesCount: 0,
          edlEditTypes: Array.isArray(edl?.clips)
            ? edl.clips.map((item) => item.clip_type)
            : (edl?.edits || []).map((item) => item.type),
          totalMs,
          totalCostUsd: 0,
          videoWidth: config?.ffmpeg?.render_width || 0,
          videoHeight: config?.ffmpeg?.render_height || 0,
          videoFps: config?.ffmpeg?.render_fps || 0,
        }, config);
      } catch (error) {
        console.warn('[video] RAG 저장 실패 (무시):', toErrorMessage(error));
      }

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
