// @ts-nocheck
'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { logToolCall } = require('../../../packages/core/lib/tool-logger');

const BOT_NAME = 'video';

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
      maxBuffer: 50 * 1024 * 1024,
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
    throw err;
  }
}

function safeParseFloat(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFps(value) {
  if (!value) return 0;
  const [numerator, denominator] = String(value).split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
    return numerator / denominator;
  }
  return safeParseFloat(value, 0);
}

async function getMediaInfo(videoPath) {
  const { stdout } = await runCommand(
    'ffprobe',
    [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath,
    ],
    'get_media_info',
    { videoPath }
  );

  const payload = JSON.parse(stdout);
  const streams = payload.streams || [];
  const format = payload.format || {};
  const videoStream = streams.find(stream => stream.codec_type === 'video') || {};
  const audioStream = streams.find(stream => stream.codec_type === 'audio') || {};

  return {
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    fps: parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    codec: videoStream.codec_name || '',
    audio_sample_rate: Number(audioStream.sample_rate || 0),
    audio_channels: Number(audioStream.channels || 0),
    duration: safeParseFloat(format.duration || videoStream.duration || audioStream.duration, 0),
  };
}

async function detectSilences(videoPath, config = {}) {
  const threshold = config?.analysis?.silence_noise ?? -30;
  const minDuration = config?.analysis?.silence_duration ?? 3;

  try {
    const { stderr } = await runCommand(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-i', videoPath,
        '-vn',
        '-af', `silencedetect=noise=${threshold}dB:d=${minDuration}`,
        '-f', 'null',
        '-',
      ],
      'detect_silences',
      { videoPath, threshold, minDuration }
    );

    const silences = [];
    let currentStart = null;
    for (const line of stderr.split('\n')) {
      const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
      if (startMatch) {
        currentStart = safeParseFloat(startMatch[1], null);
      }

      const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
      if (endMatch && currentStart !== null) {
        const from = currentStart;
        const to = safeParseFloat(endMatch[1]);
        const duration = safeParseFloat(endMatch[2], Math.max(0, to - from));
        if (duration >= minDuration) {
          silences.push({ from, to, duration });
        }
        currentStart = null;
      }
    }
    return silences;
  } catch (err) {
    return [];
  }
}

async function detectFreezes(videoPath, config = {}) {
  const noise = config?.analysis?.freeze_noise ?? 0.003;
  const minDuration = config?.analysis?.freeze_duration ?? 5;

  try {
    const { stderr } = await runCommand(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-i', videoPath,
        '-an',
        '-vf', `freezedetect=n=${noise}:d=${minDuration}`,
        '-f', 'null',
        '-',
      ],
      'detect_freezes',
      { videoPath, noise, minDuration }
    );

    const freezes = [];
    let currentStart = null;
    for (const line of stderr.split('\n')) {
      const startMatch = line.match(/freeze_start:\s*([0-9.]+)/);
      if (startMatch) {
        currentStart = safeParseFloat(startMatch[1], null);
      }

      const endMatch = line.match(/freeze_end:\s*([0-9.]+)\s*\|\s*freeze_duration:\s*([0-9.]+)/);
      if (endMatch && currentStart !== null) {
        const from = currentStart;
        const to = safeParseFloat(endMatch[1]);
        const duration = safeParseFloat(endMatch[2], Math.max(0, to - from));
        if (duration >= minDuration) {
          freezes.push({ from, to, duration });
        }
        currentStart = null;
      }
    }
    return freezes;
  } catch (err) {
    return [];
  }
}

async function detectScenes(videoPath, config = {}) {
  const threshold = config?.analysis?.scene_threshold ?? 0.3;

  try {
    const { stderr } = await runCommand(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-i', videoPath,
        '-an',
        '-filter:v', `select='gt(scene,${threshold})',showinfo`,
        '-f', 'null',
        '-',
      ],
      'detect_scenes',
      { videoPath, threshold }
    );

    const scenes = [];
    for (const line of stderr.split('\n')) {
      const ptsMatch = line.match(/pts_time:([0-9.]+)/);
      if (!ptsMatch) continue;

      const scoreMatch = line.match(/scene:([0-9.]+)/);
      const at = safeParseFloat(ptsMatch[1]);
      const score = scoreMatch ? safeParseFloat(scoreMatch[1], threshold) : threshold;
      if (score >= threshold) {
        scenes.push({ at, score });
      }
    }
    return scenes;
  } catch (err) {
    return [];
  }
}

async function analyzeVideo(videoPath, config = {}) {
  const [metadata, silences, freezes, scenes] = await Promise.all([
    getMediaInfo(videoPath),
    detectSilences(videoPath, config),
    detectFreezes(videoPath, config),
    detectScenes(videoPath, config),
  ]);

  return {
    duration: metadata.duration,
    silences,
    freezes,
    scenes,
    metadata: {
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      codec: metadata.codec,
      audio_sample_rate: metadata.audio_sample_rate,
      audio_channels: metadata.audio_channels,
    },
  };
}

function saveAnalysis(analysis, outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2), 'utf8');
  return outputPath;
}

module.exports = {
  analyzeVideo,
  detectSilences,
  detectFreezes,
  detectScenes,
  getMediaInfo,
  saveAnalysis,
};
