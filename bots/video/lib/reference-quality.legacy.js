'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function getMediaInfo(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ], {
    maxBuffer: 20 * 1024 * 1024,
  });

  const parsed = JSON.parse(stdout);
  const streams = parsed.streams || [];
  const format = parsed.format || {};
  const video = streams.find((stream) => stream.codec_type === 'video') || {};
  const audio = streams.find((stream) => stream.codec_type === 'audio') || {};

  const fpsRaw = video.avg_frame_rate || video.r_frame_rate || '0/1';
  const [fpsNum, fpsDen] = String(fpsRaw).split('/').map(Number);
  const fps = Number.isFinite(fpsNum) && Number.isFinite(fpsDen) && fpsDen !== 0
    ? fpsNum / fpsDen
    : safeNumber(fpsRaw, 0);

  return {
    format,
    durationSec: safeNumber(format.duration || video.duration || audio.duration, 0),
    video: {
      width: safeNumber(video.width, 0),
      height: safeNumber(video.height, 0),
      codec: video.codec_name || '',
      fps,
      pixFmt: video.pix_fmt || '',
    },
    audio: {
      codec: audio.codec_name || '',
      sampleRate: safeNumber(audio.sample_rate, 0),
      channels: safeNumber(audio.channels, 0),
      durationSec: safeNumber(audio.duration || format.duration, 0),
    },
  };
}

async function extractFrameRgb(filePath, second, width = 64, height = 36) {
  const args = [
    '-v', 'quiet',
    '-ss', second.toFixed(3),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=rgb24`,
    '-f', 'rawvideo',
    'pipe:1',
  ];
  const { stdout } = await execFileAsync('ffmpeg', args, {
    encoding: 'buffer',
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

function compareFrameBuffers(bufferA, bufferB) {
  if (!Buffer.isBuffer(bufferA) || !Buffer.isBuffer(bufferB) || !bufferA.length || bufferA.length !== bufferB.length) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < bufferA.length; index += 1) {
    sum += Math.abs(bufferA[index] - bufferB[index]);
  }

  const meanAbsDiff = sum / bufferA.length;
  return Number((1 - (meanAbsDiff / 255)).toFixed(4));
}

function buildSampleTimes(durationSec) {
  const safeDuration = Math.max(1, safeNumber(durationSec, 0));
  const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
  return fractions
    .map((fraction) => Number(Math.min(Math.max(safeDuration * fraction, 0.5), Math.max(safeDuration - 0.5, 0.5)).toFixed(3)));
}

function scoreDuration(generatedSec, referenceSec) {
  if (!generatedSec || !referenceSec) return 0;
  const deltaRatio = Math.abs(generatedSec - referenceSec) / Math.max(referenceSec, 1);
  return Math.max(0, Number((100 * (1 - Math.min(deltaRatio, 1))).toFixed(2)));
}

function scoreResolution(generatedVideo, referenceVideo) {
  if (!generatedVideo?.width || !referenceVideo?.width || !generatedVideo?.height || !referenceVideo?.height) return 0;
  const widthRatio = Math.min(generatedVideo.width, referenceVideo.width) / Math.max(generatedVideo.width, referenceVideo.width);
  const heightRatio = Math.min(generatedVideo.height, referenceVideo.height) / Math.max(generatedVideo.height, referenceVideo.height);
  return Number((100 * widthRatio * heightRatio).toFixed(2));
}

function scoreFps(generatedVideo, referenceVideo) {
  const generated = safeNumber(generatedVideo?.fps, 0);
  const reference = safeNumber(referenceVideo?.fps, 0);
  if (!generated || !reference) return 0;
  const ratio = Math.min(generated, reference) / Math.max(generated, reference);
  return Number((100 * ratio).toFixed(2));
}

function scoreAudioSpec(generatedAudio, referenceAudio) {
  const sampleRateGenerated = safeNumber(generatedAudio?.sampleRate, 0);
  const sampleRateReference = safeNumber(referenceAudio?.sampleRate, 0);
  const channelsGenerated = safeNumber(generatedAudio?.channels, 0);
  const channelsReference = safeNumber(referenceAudio?.channels, 0);

  const sampleRateScore = sampleRateGenerated && sampleRateReference
    ? 100 * (Math.min(sampleRateGenerated, sampleRateReference) / Math.max(sampleRateGenerated, sampleRateReference))
    : 0;
  const channelScore = channelsGenerated && channelsReference
    ? 100 * (Math.min(channelsGenerated, channelsReference) / Math.max(channelsGenerated, channelsReference))
    : 0;

  return Number((((sampleRateScore * 0.6) + (channelScore * 0.4))).toFixed(2));
}

async function compareVideos(generatedPath, referencePath, options = {}) {
  const generatedInfo = await getMediaInfo(generatedPath);
  const referenceInfo = await getMediaInfo(referencePath);
  const sampleDuration = Math.min(generatedInfo.durationSec, referenceInfo.durationSec);
  const sampleTimes = buildSampleTimes(sampleDuration);
  const visualSamples = [];

  for (const second of sampleTimes) {
    try {
      const [frameA, frameB] = await Promise.all([
        extractFrameRgb(generatedPath, second, options.sampleWidth || 64, options.sampleHeight || 36),
        extractFrameRgb(referencePath, second, options.sampleWidth || 64, options.sampleHeight || 36),
      ]);
      visualSamples.push({
        second,
        similarity: compareFrameBuffers(frameA, frameB),
      });
    } catch (_error) {
      visualSamples.push({
        second,
        similarity: 0,
      });
    }
  }

  const visualSimilarityScore = visualSamples.length
    ? Number(((visualSamples.reduce((sum, item) => sum + item.similarity, 0) / visualSamples.length) * 100).toFixed(2))
    : 0;

  const durationScore = scoreDuration(generatedInfo.durationSec, referenceInfo.durationSec);
  const resolutionScore = scoreResolution(generatedInfo.video, referenceInfo.video);
  const fpsScore = scoreFps(generatedInfo.video, referenceInfo.video);
  const audioSpecScore = scoreAudioSpec(generatedInfo.audio, referenceInfo.audio);
  const overallScore = Number((
    (durationScore * 0.3)
    + (resolutionScore * 0.15)
    + (fpsScore * 0.1)
    + (audioSpecScore * 0.1)
    + (visualSimilarityScore * 0.35)
  ).toFixed(2));

  return {
    generated: {
      path: generatedPath,
      durationSec: Number(generatedInfo.durationSec.toFixed(3)),
      video: generatedInfo.video,
      audio: generatedInfo.audio,
    },
    reference: {
      path: referencePath,
      durationSec: Number(referenceInfo.durationSec.toFixed(3)),
      video: referenceInfo.video,
      audio: referenceInfo.audio,
    },
    scores: {
      duration: durationScore,
      resolution: resolutionScore,
      fps: fpsScore,
      audio_spec: audioSpecScore,
      visual_similarity: visualSimilarityScore,
      overall: overallScore,
    },
    deltas: {
      durationSec: Number((generatedInfo.durationSec - referenceInfo.durationSec).toFixed(3)),
      width: generatedInfo.video.width - referenceInfo.video.width,
      height: generatedInfo.video.height - referenceInfo.video.height,
      fps: Number((generatedInfo.video.fps - referenceInfo.video.fps).toFixed(3)),
      audioSampleRate: generatedInfo.audio.sampleRate - referenceInfo.audio.sampleRate,
      audioChannels: generatedInfo.audio.channels - referenceInfo.audio.channels,
    },
    visualSamples,
  };
}

module.exports = {
  getMediaInfo,
  extractFrameRgb,
  compareFrameBuffers,
  compareVideos,
};
