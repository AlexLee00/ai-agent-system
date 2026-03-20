'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { logToolCall } = require('../../../packages/core/lib/tool-logger');

const BOT_NAME = 'video';

function ensureConfig(config) {
  if (!config || !config.ffmpeg) {
    throw new Error('비디오 config.ffmpeg가 필요합니다.');
  }
}

function toErrorMessage(err) {
  if (!err) return '알 수 없는 오류';
  if (err.code === 'ENOENT') {
    return 'FFmpeg 또는 ffprobe가 설치되어 있지 않거나 PATH에서 찾을 수 없습니다.';
  }
  return err.stderr || err.stdout || err.message || String(err);
}

async function runCommand(bin, args, action, metadata = {}) {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(bin, args, {
      maxBuffer: 20 * 1024 * 1024,
    });
    await logToolCall(bin, action, {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata,
    });
    return result;
  } catch (err) {
    await logToolCall(bin, action, {
      bot: BOT_NAME,
      success: false,
      duration_ms: Date.now() - startedAt,
      error: toErrorMessage(err),
      metadata,
    });
    const wrapped = new Error(`${bin} ${action} 실패: ${toErrorMessage(err)}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

async function probeDurationMs(filePath) {
  const { stdout } = await runCommand(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    'probe_duration',
    { filePath }
  );

  const durationSeconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(durationSeconds)) {
    throw new Error(`ffprobe duration 파싱 실패: ${filePath}`);
  }
  return Math.round(durationSeconds * 1000);
}

function findMediaPair(sourceDir) {
  const rawDir = path.join(sourceDir, 'raw');
  const narrationDir = path.join(sourceDir, 'narration');

  const rawBase = fs.existsSync(rawDir) ? rawDir : sourceDir;
  const narrationBase = fs.existsSync(narrationDir) ? narrationDir : sourceDir;

  const normalizeName = name => name.normalize('NFC');
  const rawFiles = fs.readdirSync(rawBase)
    .filter(name => {
      const normalized = normalizeName(name);
      return normalized.startsWith('원본_') && normalized.endsWith('.mp4');
    })
    .sort();
  const narrationFiles = fs.readdirSync(narrationBase)
    .filter(name => {
      const normalized = normalizeName(name);
      return normalized.startsWith('원본_나레이션_') && normalized.endsWith('.m4a');
    })
    .sort();

  if (rawFiles.length === 0) {
    throw new Error(`원본 영상 파일을 찾을 수 없습니다: ${rawBase}`);
  }
  if (narrationFiles.length === 0) {
    throw new Error(`나레이션 파일을 찾을 수 없습니다: ${narrationBase}`);
  }

  const rawName = rawFiles[0];
  const rawStem = normalizeName(rawName).replace(/^원본_/, '').replace(/\.mp4$/, '');
  const narrationEntry = narrationFiles.find(name => {
    const normalized = normalizeName(name);
    return normalized === `원본_나레이션_${rawStem}.m4a`;
  });

  if (!narrationEntry) {
    throw new Error(`매칭되는 나레이션 파일을 찾을 수 없습니다: 원본_나레이션_${rawStem}.m4a`);
  }

  return {
    rawPath: path.join(rawBase, rawName),
    narrationPath: path.join(narrationBase, narrationEntry),
    stem: rawStem,
  };
}

async function removeAudio(inputPath, outputPath) {
  const startedAt = Date.now();
  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i', inputPath,
      '-an',
      '-c:v', 'copy',
      outputPath,
    ],
    'remove_audio',
    { inputPath, outputPath }
  );

  return {
    outputPath,
    duration_ms: Date.now() - startedAt,
  };
}

async function normalizeAudio(inputPath, outputPath, config) {
  ensureConfig(config);

  const startedAt = Date.now();
  const {
    audio_lufs,
    audio_tp,
    audio_lra,
    audio_sample_rate,
    audio_channels,
    audio_bitrate,
  } = config.ffmpeg;

  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i', inputPath,
      '-af', `loudnorm=I=${audio_lufs}:TP=${audio_tp}:LRA=${audio_lra}`,
      '-ar', String(audio_sample_rate),
      '-ac', String(audio_channels),
      '-c:a', 'aac',
      '-b:a', String(audio_bitrate),
      outputPath,
    ],
    'normalize_audio',
    {
      inputPath,
      outputPath,
      audio_lufs,
      audio_tp,
      audio_lra,
      audio_sample_rate,
      audio_channels,
      audio_bitrate,
    }
  );

  return {
    outputPath,
    duration_ms: Date.now() - startedAt,
  };
}

async function syncVideoAudio(videoPath, audioPath, outputPath) {
  const startedAt = Date.now();
  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-map', '0:v:0',
      '-map', '1:a:0',
      outputPath,
    ],
    'sync_video_audio',
    { videoPath, audioPath, outputPath }
  );

  const duration_ms = await probeDurationMs(outputPath);
  return {
    outputPath,
    duration_ms,
    elapsed_ms: Date.now() - startedAt,
  };
}

async function preprocess(sourceDir, tempDir, config) {
  ensureConfig(config);
  fs.mkdirSync(tempDir, { recursive: true });

  const startedAt = Date.now();
  const { rawPath, narrationPath, stem } = findMediaPair(sourceDir);
  const videoNoAudioPath = path.join(tempDir, 'video_noaudio.mp4');
  const normalizedAudioPath = path.join(tempDir, 'narr_norm.m4a');
  const syncedPath = path.join(tempDir, 'synced.mp4');

  const removeAudioResult = await removeAudio(rawPath, videoNoAudioPath);
  const normalizeAudioResult = await normalizeAudio(narrationPath, normalizedAudioPath, config);
  const syncResult = await syncVideoAudio(videoNoAudioPath, normalizedAudioPath, syncedPath);

  return {
    stem,
    rawPath,
    narrationPath,
    videoNoAudioPath,
    normalizedAudioPath,
    syncedPath,
    duration_ms: syncResult.duration_ms,
    preprocess_ms: Date.now() - startedAt,
    removeAudio_ms: removeAudioResult.duration_ms,
    normalizeAudio_ms: normalizeAudioResult.duration_ms,
    sync_ms: syncResult.elapsed_ms,
  };
}

module.exports = {
  removeAudio,
  normalizeAudio,
  syncVideoAudio,
  preprocess,
  probeDurationMs,
  findMediaPair,
};
