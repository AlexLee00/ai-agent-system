// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { config } = require('../src/index');
const {
  removeAudio,
  normalizeAudio,
  syncVideoAudio,
  preprocess,
} = require('../lib/ffmpeg-preprocess');

const SAMPLE_VIDEO = path.join(__dirname, '..', 'samples', 'raw', '원본_파라미터.mp4');
const SAMPLE_AUDIO = path.join(__dirname, '..', 'samples', 'narration', '원본_나레이션_파라미터.m4a');
const TEMP_DIR = path.join(__dirname, '..', 'temp');
const VIDEO_NO_AUDIO = path.join(TEMP_DIR, 'video_noaudio.mp4');
const NARR_NORM = path.join(TEMP_DIR, 'narr_norm.m4a');
const SYNCED = path.join(TEMP_DIR, 'synced.mp4');

function formatMs(ms) {
  return `${ms}ms`;
}

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

async function measureLufs(filePath) {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-i', filePath,
    '-af', `loudnorm=I=${config.ffmpeg.audio_lufs}:TP=${config.ffmpeg.audio_tp}:LRA=${config.ffmpeg.audio_lra}:print_format=json`,
    '-f', 'null',
    '-',
  ], {
    maxBuffer: 20 * 1024 * 1024,
  });

  const match = stderr.match(/\{\s*"input_i".*?\}/s);
  if (!match) {
    throw new Error('LUFS 측정 JSON을 찾을 수 없습니다.');
  }

  const parsed = JSON.parse(match[0]);
  return Number.parseFloat(parsed.input_i);
}

function cleanupOutputs() {
  for (const filePath of [VIDEO_NO_AUDIO, NARR_NORM, SYNCED]) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

async function main() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  cleanupOutputs();

  const removeStartedAt = Date.now();
  const removeResult = await removeAudio(SAMPLE_VIDEO, VIDEO_NO_AUDIO);
  assert(fs.existsSync(VIDEO_NO_AUDIO), 'video_noaudio.mp4가 생성되지 않았습니다.');
  const noAudioProbe = await probeJson(VIDEO_NO_AUDIO);
  const noAudioVideoStream = noAudioProbe.streams.find(stream => stream.codec_type === 'video');
  const noAudioAudioStream = noAudioProbe.streams.find(stream => stream.codec_type === 'audio');
  assert(noAudioVideoStream, 'video_noaudio.mp4에 video stream이 없습니다.');
  assert(!noAudioAudioStream, 'video_noaudio.mp4에 audio stream이 남아 있습니다.');
  console.log(`[test] removeAudio: ✅ (${formatMs(removeResult.duration_ms || (Date.now() - removeStartedAt))})`);

  const normalizeStartedAt = Date.now();
  const normalizeResult = await normalizeAudio(SAMPLE_AUDIO, NARR_NORM, config);
  assert(fs.existsSync(NARR_NORM), 'narr_norm.m4a가 생성되지 않았습니다.');
  const normProbe = await probeJson(NARR_NORM);
  const normAudioStream = normProbe.streams.find(stream => stream.codec_type === 'audio');
  assert(normAudioStream, 'narr_norm.m4a에 audio stream이 없습니다.');
  assert(Number(normAudioStream.sample_rate) === 48000, `sample_rate 기대값 48000, 실제 ${normAudioStream.sample_rate}`);
  assert(Number(normAudioStream.channels) === 2, `channels 기대값 2, 실제 ${normAudioStream.channels}`);
  assert(normAudioStream.codec_name === 'aac', `codec 기대값 aac, 실제 ${normAudioStream.codec_name}`);
  console.log(`[test] normalizeAudio: ✅ (${formatMs(normalizeResult.duration_ms || (Date.now() - normalizeStartedAt))}) → 48000Hz stereo AAC`);

  const syncStartedAt = Date.now();
  const syncResult = await syncVideoAudio(VIDEO_NO_AUDIO, NARR_NORM, SYNCED);
  assert(fs.existsSync(SYNCED), 'synced.mp4가 생성되지 않았습니다.');
  const syncedProbe = await probeJson(SYNCED);
  const syncedVideo = syncedProbe.streams.find(stream => stream.codec_type === 'video');
  const syncedAudio = syncedProbe.streams.find(stream => stream.codec_type === 'audio');
  assert(syncedVideo, 'synced.mp4에 video stream이 없습니다.');
  assert(syncedAudio, 'synced.mp4에 audio stream이 없습니다.');
  assert(Number(syncedVideo.width) === 1920 && Number(syncedVideo.height) === 1080, `video 해상도 기대값 1920x1080, 실제 ${syncedVideo.width}x${syncedVideo.height}`);
  assert(Number(syncedAudio.sample_rate) === 48000, `synced sample_rate 기대값 48000, 실제 ${syncedAudio.sample_rate}`);
  assert(Number(syncedAudio.channels) === 2, `synced channels 기대값 2, 실제 ${syncedAudio.channels}`);
  const fpsValue = eval(syncedVideo.r_frame_rate); // eslint-disable-line no-eval
  assert(Math.abs(fpsValue - 60) < 0.1, `fps 기대값 60, 실제 ${syncedVideo.r_frame_rate}`);
  console.log(`[test] syncVideoAudio: ✅ (${formatMs(syncResult.elapsed_ms || (Date.now() - syncStartedAt))}) → 1920x1080 + 48kHz stereo`);

  cleanupOutputs();
  const preprocessResult = await preprocess(path.join(__dirname, '..', 'samples'), TEMP_DIR, config);
  assert(fs.existsSync(preprocessResult.syncedPath), 'preprocess 통합 실행 결과 synced.mp4가 없습니다.');
  console.log(`[test] preprocess 통합: ✅ (${formatMs(preprocessResult.preprocess_ms)})`);

  const lufs = await measureLufs(preprocessResult.normalizedAudioPath);
  assert(Number.isFinite(lufs), 'LUFS 측정값이 숫자가 아닙니다.');
  assert(Math.abs(lufs - config.ffmpeg.audio_lufs) <= 2, `LUFS 기대 범위 -14 ± 2, 실제 ${lufs}`);
  console.log(`[test] LUFS 측정: ${lufs.toFixed(1)} (목표 -14 ± 2) ✅`);
  console.log('[test] 과제 2 전체 통과!');
}

main().catch(err => {
  console.error('[test] 과제 2 실패:', err.message);
  process.exit(1);
});
