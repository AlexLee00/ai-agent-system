'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadConfig } = require('../src/index');
const { indexVideo } = require('../lib/scene-indexer');
const { analyzeNarration, buildOfflineNarrationFixture } = require('../lib/narration-analyzer');
const { buildSyncMap, syncMapToEDL } = require('../lib/sync-matcher');
const { processIntroOutro } = require('../lib/intro-outro-handler');
const { renderPreview, renderFinal, saveEDL } = require('../lib/edl-builder');
const { normalizeAudio } = require('../lib/ffmpeg-preprocess');

function parseArgs(argv) {
  const parsed = {
    sourceVideo: null,
    sourceAudio: null,
    edited: null,
    renderPreview: false,
    renderFinal: false,
    allowOfflineFixture: true,
  };
  for (const arg of argv) {
    if (arg.startsWith('--source-video=')) parsed.sourceVideo = arg.slice('--source-video='.length);
    if (arg.startsWith('--source-audio=')) parsed.sourceAudio = arg.slice('--source-audio='.length);
    if (arg.startsWith('--edited=')) parsed.edited = arg.slice('--edited='.length);
    if (arg === '--render-preview') parsed.renderPreview = true;
    if (arg === '--render-final') parsed.renderFinal = true;
    if (arg === '--no-offline-fixture') parsed.allowOfflineFixture = false;
  }
  return parsed;
}

async function runPipelineValidation(rawArgs) {
  const args = {
    sourceVideo: rawArgs?.sourceVideo || null,
    sourceAudio: rawArgs?.sourceAudio || null,
    edited: rawArgs?.edited || null,
    renderPreview: Boolean(rawArgs?.renderPreview),
    renderFinal: Boolean(rawArgs?.renderFinal),
    allowOfflineFixture: rawArgs?.allowOfflineFixture !== false,
  };

  if (!args.sourceVideo || !args.sourceAudio) {
    throw new Error('--source-video와 --source-audio는 필수입니다.');
  }

  const config = loadConfig();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-sync-pipeline-'));
  const normalizedAudioPath = path.join(tempDir, 'narration_norm.m4a');
  await normalizeAudio(path.resolve(args.sourceAudio), normalizedAudioPath, config);
  const sceneIndex = await indexVideo(path.resolve(args.sourceVideo), config, { tempDir, ocrEngine: 'cli' });
  let narration;
  try {
    narration = await analyzeNarration(normalizedAudioPath, config, { tempDir, correct: true });
  } catch (error) {
    if (!args.allowOfflineFixture) throw error;
    console.warn('[video] test-full-sync-pipeline 오프라인 narration fixture fallback:', error.message);
    narration = await buildOfflineNarrationFixture(normalizedAudioPath);
  }
  const syncMap = await buildSyncMap(sceneIndex, narration, config, { tempDir });
  const introOutro = await processIntroOutro(config, {
    intro: {
      mode: 'prompt',
      prompt: '테스트 인트로 3초',
      durationSec: 3,
      title: '테스트 인트로',
    },
    outro: { mode: 'none' },
    targetWidth: Number(config.ffmpeg.render_width || 2560),
    targetHeight: Number(config.ffmpeg.render_height || 1440),
    targetFps: Number(config.ffmpeg.render_fps || 60),
    tempDir,
  });
  const edl = syncMapToEDL(syncMap, path.resolve(args.sourceVideo), normalizedAudioPath, introOutro.introClip, introOutro.outroClip);
  const edlPath = path.join(tempDir, 'edit_decision_list.json');
  saveEDL(edl, edlPath);

  let previewPath = null;
  let previewRender = null;
  if (args.renderPreview) {
    previewPath = path.join(tempDir, 'preview.mp4');
    previewRender = await renderPreview(edl, previewPath, config);
  }

  let finalPath = null;
  let finalRender = null;
  if (args.renderFinal) {
    finalPath = path.join(tempDir, 'final.mp4');
    finalRender = await renderFinal(edl, finalPath, config);
  }

  const editedExists = args.edited ? fs.existsSync(path.resolve(args.edited)) : false;
  return {
    temp_dir: tempDir,
    scene_count: sceneIndex.scenes?.length || 0,
    segment_count: narration.total_segments || 0,
    sync_confidence: syncMap.overall_confidence,
    match_breakdown: {
      keyword: syncMap.matched_keyword,
      embedding: syncMap.matched_embedding,
      hold: syncMap.matched_hold,
      unmatched: syncMap.unmatched,
    },
    intro_clip: introOutro.introClip?.clipPath || null,
    outro_clip: introOutro.outroClip?.clipPath || null,
    offline_narration_fixture: Boolean(narration.offline_fixture),
    edl_path: edlPath,
    preview_path: previewPath,
    preview_render: previewRender ? {
      duration_ms: previewRender.duration_ms,
      file_size: previewRender.fileSize,
      validation: previewRender.validation,
    } : null,
    final_path: finalPath,
    final_render: finalRender ? {
      duration_ms: finalRender.duration_ms,
      file_size: finalRender.fileSize,
      validation: finalRender.validation,
    } : null,
    reference_edited_exists: editedExists,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPipelineValidation(args);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[video] test-full-sync-pipeline 실패:', error.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runPipelineValidation,
  main,
};
