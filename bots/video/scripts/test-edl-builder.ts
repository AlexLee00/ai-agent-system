// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { config } = require('../src/index');
const {
  buildInitialEDL,
  saveEDL,
  loadEDL,
  buildPreviewCommand,
  buildFinalRenderCommand,
  renderPreview,
  renderFinal,
  convertSrtToVtt,
} = require('../lib/edl-builder');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const EXPORTS_DIR = path.join(__dirname, '..', 'exports');
const ANALYSIS_PATH = path.join(TEMP_DIR, 'analysis.json');
const VIDEO_PATH = path.join(TEMP_DIR, 'synced.mp4');
const SRT_PATH = path.join(TEMP_DIR, 'subtitle_corrected.srt');
const EDL_PATH = path.join(TEMP_DIR, 'edit_decision_list.json');
const PREVIEW_PATH = path.join(TEMP_DIR, 'preview.mp4');
const FINAL_PATH = path.join(EXPORTS_DIR, '편집_DB생성.mp4');
const VTT_PATH = path.join(TEMP_DIR, 'subtitle.vtt');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function probeJson(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    filePath,
  ], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function hasFastStart(filePath) {
  const buffer = fs.readFileSync(filePath);
  const moovIndex = buffer.indexOf(Buffer.from('moov'));
  const mdatIndex = buffer.indexOf(Buffer.from('mdat'));
  return moovIndex !== -1 && mdatIndex !== -1 && moovIndex < mdatIndex;
}

function formatCommand(command) {
  return command.join(' ');
}

async function main() {
  const skipRender = process.argv.includes('--skip-render');
  const skipPreview = process.argv.includes('--skip-preview');

  assert(fs.existsSync(ANALYSIS_PATH), 'analysis.json이 없습니다. 먼저 node bots/video/scripts/test-video-analyzer.js를 실행하세요.');
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const analysis = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));
  const edl = await buildInitialEDL(VIDEO_PATH, SRT_PATH, analysis, {
    title: 'FlutterFlow DB 생성',
    config,
  });
  saveEDL(edl, EDL_PATH);

  const loaded = loadEDL(EDL_PATH);
  const counts = loaded.edits.reduce((acc, edit) => {
    acc[edit.type] = (acc[edit.type] || 0) + 1;
    return acc;
  }, {});

  console.log(`[test] EDL 생성: ✅ edits=${loaded.edits.length}`);
  console.log('[test] 타입 분포:', counts);

  const previewCommand = buildPreviewCommand(loaded, PREVIEW_PATH, config);
  console.log('[test] preview 명령어:');
  console.log(formatCommand(previewCommand));

  if (!skipPreview) {
    if (fs.existsSync(PREVIEW_PATH)) fs.unlinkSync(PREVIEW_PATH);
    const previewResult = await renderPreview(loaded, PREVIEW_PATH, config);
    assert(previewResult.success, 'preview 렌더링 실패');
    assert(fs.existsSync(PREVIEW_PATH), 'preview.mp4가 생성되지 않았습니다.');
    const previewProbe = await probeJson(PREVIEW_PATH);
    const previewVideo = previewProbe.streams.find(stream => stream.codec_type === 'video');
    assert(previewVideo, 'preview.mp4 video stream 없음');
    assert(Number(previewVideo.width) === 1280 && Number(previewVideo.height) === 720, `preview 해상도 기대값 1280x720, 실제 ${previewVideo.width}x${previewVideo.height}`);
    console.log('[test] renderPreview: ✅ 1280x720 확인');
  }

  const finalCommand = buildFinalRenderCommand(loaded, FINAL_PATH, config);
  console.log('[test] final 명령어:');
  console.log(formatCommand(finalCommand));

  if (!skipRender) {
    if (fs.existsSync(FINAL_PATH)) fs.unlinkSync(FINAL_PATH);
    const finalResult = await renderFinal(loaded, FINAL_PATH, config);
    assert(finalResult.success, '최종 렌더링 실패');
    assert(fs.existsSync(FINAL_PATH), '최종 출력 파일이 생성되지 않았습니다.');

    const finalProbe = await probeJson(FINAL_PATH);
    const finalVideo = finalProbe.streams.find(stream => stream.codec_type === 'video');
    const finalAudio = finalProbe.streams.find(stream => stream.codec_type === 'audio');
    assert(finalVideo, '최종 출력 video stream 없음');
    assert(finalAudio, '최종 출력 audio stream 없음');
    assert(Number(finalVideo.width) === 2560 && Number(finalVideo.height) === 1440, `최종 해상도 기대값 2560x1440, 실제 ${finalVideo.width}x${finalVideo.height}`);
    assert(finalVideo.codec_name === 'h264', `최종 codec 기대값 h264, 실제 ${finalVideo.codec_name}`);
    assert(String(finalVideo.profile || '').toLowerCase() === 'high', `최종 profile 기대값 High, 실제 ${finalVideo.profile}`);
    assert(Number(finalAudio.sample_rate) === 48000, `최종 audio sample rate 기대값 48000, 실제 ${finalAudio.sample_rate}`);
    assert(Number(finalAudio.channels) === 2, `최종 audio channels 기대값 2, 실제 ${finalAudio.channels}`);
    assert(hasFastStart(FINAL_PATH), '최종 출력 파일에서 moov atom이 앞쪽에 없습니다 (faststart 미확인)');
    console.log('[test] renderFinal: ✅ 2560x1440 / H.264 High / 48kHz stereo / faststart 확인');
  } else {
    console.log('[test] --skip-render 옵션으로 최종 렌더링은 건너뜀');
  }

  convertSrtToVtt(SRT_PATH, VTT_PATH);
  assert(fs.existsSync(VTT_PATH), 'subtitle.vtt가 생성되지 않았습니다.');
  console.log(`[test] VTT 변환: ✅ ${VTT_PATH}`);
  console.log('[test] 과제 6 edl-builder 통과!');
}

main().catch(err => {
  console.error('[test] edl-builder 실패:', err.message);
  process.exit(1);
});
