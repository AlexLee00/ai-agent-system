'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { enhanceEDLWithRAG } = require('./video-rag');

const BOT_NAME = 'video';
const FILTER_SUPPORT_CACHE = new Map();

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

function mergeNearbyScenes(scenes, windowSeconds = 1.0) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return [];
  }

  const sorted = [...scenes]
    .map(scene => ({
      at: safeParseFloat(scene.at),
      score: safeParseFloat(scene.score, 0),
    }))
    .filter(scene => Number.isFinite(scene.at) && scene.at >= 0)
    .sort((a, b) => a.at - b.at);

  if (!sorted.length) {
    return [];
  }

  const merged = [sorted[0]];
  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if ((current.at - last.at) <= windowSeconds) {
      if (current.score > last.score) {
        last.at = current.at;
        last.score = current.score;
      }
      continue;
    }
    merged.push(current);
  }

  return merged;
}

function ensureFfmpegConfig(config) {
  if (!config || !config.ffmpeg) {
    throw new Error('config.ffmpeg 설정이 필요합니다.');
  }
}

function supportsFilter(filterName) {
  if (FILTER_SUPPORT_CACHE.has(filterName)) {
    return FILTER_SUPPORT_CACHE.get(filterName);
  }

  try {
    const output = execFileSync('ffmpeg', ['-hide_banner', '-filters'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 5 * 1024 * 1024,
    });
    const supported = new RegExp(`\\b${filterName}\\b`).test(output);
    FILTER_SUPPORT_CACHE.set(filterName, supported);
    return supported;
  } catch (_err) {
    FILTER_SUPPORT_CACHE.set(filterName, false);
    return false;
  }
}

async function getMediaInfo(filePath) {
  const { stdout } = await runCommand(
    'ffprobe',
    [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    'probe_render_target',
    { filePath }
  );

  const payload = JSON.parse(stdout);
  const streams = payload.streams || [];
  const format = payload.format || {};
  const video = streams.find(stream => stream.codec_type === 'video') || {};
  const audio = streams.find(stream => stream.codec_type === 'audio') || {};

  const fpsRaw = video.avg_frame_rate || video.r_frame_rate || '0/1';
  const [fpsNum, fpsDen] = String(fpsRaw).split('/').map(Number);
  const fps = Number.isFinite(fpsNum) && Number.isFinite(fpsDen) && fpsDen !== 0
    ? fpsNum / fpsDen
    : safeParseFloat(fpsRaw, 0);

  return {
    duration: safeParseFloat(format.duration || video.duration || audio.duration, 0),
    video: {
      width: Number(video.width || 0),
      height: Number(video.height || 0),
      codec: video.codec_name || '',
      profile: video.profile || '',
      fps,
      bitRate: Number(video.bit_rate || 0),
      pixFmt: video.pix_fmt || '',
    },
    audio: {
      codec: audio.codec_name || '',
      sampleRate: Number(audio.sample_rate || 0),
      channels: Number(audio.channels || 0),
      bitRate: Number(audio.bit_rate || 0),
    },
    format,
  };
}

async function buildInitialEDL(sourcePath, subtitlePath, analysis = {}, options = {}) {
  const edits = [];
  const mergedScenes = mergeNearbyScenes(
    analysis.scenes || [],
    safeParseFloat(options.sceneMergeWindowSeconds, 1.0)
  );

  for (const silence of analysis.silences || []) {
    edits.push({
      type: 'cut',
      from: silence.from,
      to: silence.to,
      reason: '무음 구간',
    });
  }

  for (const freeze of analysis.freezes || []) {
    edits.push({
      type: 'cut',
      from: freeze.from,
      to: freeze.to,
      reason: '정지 화면',
    });
  }

  for (const scene of mergedScenes) {
    edits.push({
      type: 'transition',
      at: scene.at,
      effect: 'fade',
      duration: 0.5,
      score: scene.score,
    });
  }

  if (options.title) {
    edits.push({
      type: 'text_overlay',
      at: 0,
      duration: 3,
      text: options.title,
    });
  }

  edits.sort((a, b) => {
    const aTime = a.from ?? a.at ?? 0;
    const bTime = b.from ?? b.at ?? 0;
    return aTime - bTime;
  });

  let edl = {
    version: 1,
    source: sourcePath,
    subtitle: subtitlePath,
    duration: safeParseFloat(analysis.duration, 0),
    edits,
  };

  try {
    edl = await enhanceEDLWithRAG(edl, analysis, options.config || null);
  } catch (_error) {
    // RAG 실패 시 원본 EDL 유지
  }

  return edl;
}

function saveEDL(edl, outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify(edl, null, 2), 'utf8');
  return outputPath;
}

function loadEDL(edlPath) {
  return JSON.parse(fs.readFileSync(edlPath, 'utf8'));
}

function applyPatch(edl, patch = {}) {
  const next = {
    ...edl,
    edits: Array.isArray(edl.edits) ? [...edl.edits] : [],
  };

  const removeSet = new Set((patch.remove || []).map(index => Number(index)).filter(Number.isInteger));
  next.edits = next.edits.filter((_, index) => !removeSet.has(index));

  for (const modification of patch.modify || []) {
    const index = Number(modification.index);
    if (!Number.isInteger(index) || !next.edits[index]) continue;
    const { index: _ignored, ...changes } = modification;
    next.edits[index] = { ...next.edits[index], ...changes };
  }

  for (const addition of patch.add || []) {
    next.edits.push(addition);
  }

  next.edits.sort((a, b) => {
    const aTime = a.from ?? a.at ?? 0;
    const bTime = b.from ?? b.at ?? 0;
    return aTime - bTime;
  });

  return next;
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const merged = [sorted[0]];
  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (current.from <= last.to) {
      last.to = Math.max(last.to, current.to);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function computeKeepSegments(duration, cutEdits) {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('원본 duration 정보를 찾을 수 없습니다.');
  }

  const cuts = mergeIntervals(
    cutEdits
      .map(edit => ({
        from: Math.max(0, safeParseFloat(edit.from)),
        to: Math.min(duration, safeParseFloat(edit.to)),
      }))
      .filter(interval => interval.to > interval.from)
  );

  if (!cuts.length) {
    return [{ from: 0, to: duration, factor: 1 }];
  }

  const keep = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.from > cursor) {
      keep.push({ from: cursor, to: cut.from });
    }
    cursor = Math.max(cursor, cut.to);
  }
  if (cursor < duration) {
    keep.push({ from: cursor, to: duration });
  }
  return keep;
}

function splitSegmentsBySpeed(segments, speedEdits) {
  if (!speedEdits.length) {
    return segments.map(segment => ({ ...segment, factor: 1 }));
  }

  const boundaries = new Set();
  for (const segment of segments) {
    boundaries.add(segment.from);
    boundaries.add(segment.to);
  }
  for (const edit of speedEdits) {
    boundaries.add(safeParseFloat(edit.from));
    boundaries.add(safeParseFloat(edit.to));
  }

  const sorted = [...boundaries].filter(Number.isFinite).sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (to <= from) continue;

    const insideBase = segments.some(segment => from >= segment.from && to <= segment.to);
    if (!insideBase) continue;

    const speedEdit = speedEdits.find(edit => from >= safeParseFloat(edit.from) && to <= safeParseFloat(edit.to));
    result.push({
      from,
      to,
      factor: speedEdit ? safeParseFloat(speedEdit.factor, 1) || 1 : 1,
    });
  }

  return result;
}

function atempoChain(factor) {
  if (!Number.isFinite(factor) || factor <= 0) {
    return 'atempo=1.0';
  }
  const filters = [];
  let remaining = factor;

  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }

  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }

  filters.push(`atempo=${remaining.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`);
  return filters.join(',');
}

function escapeSubtitlesPath(filePath) {
  return String(filePath)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function escapeDrawtextText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

function buildFFmpegFilter(edl) {
  const sourcePath = edl.source;
  const subtitlePath = edl.subtitle;
  if (!sourcePath) {
    throw new Error('EDL에 source 경로가 없습니다.');
  }

  const sourceDuration = safeParseFloat(edl.duration, 0);
  if (!sourceDuration) {
    throw new Error('EDL에 duration 정보가 없습니다. buildInitialEDL 전에 analysis.duration을 포함해 주세요.');
  }

  const edits = Array.isArray(edl.edits) ? edl.edits : [];
  const cutEdits = edits.filter(edit => edit.type === 'cut');
  const transitionEdits = edits.filter(edit => edit.type === 'transition');
  const speedEdits = edits.filter(edit => edit.type === 'speed');
  const overlayEdits = edits.filter(edit => edit.type === 'text_overlay');

  const keepSegments = computeKeepSegments(sourceDuration, cutEdits);
  const effectiveSegments = splitSegmentsBySpeed(keepSegments, speedEdits);
  const filterParts = [];
  const videoLabels = [];
  const audioLabels = [];
  let timelineCursor = 0;

  if (!effectiveSegments.length) {
    filterParts.push('[0:v]setpts=PTS-STARTPTS[vcat]');
    filterParts.push('[0:a]asetpts=PTS-STARTPTS[acat]');
    timelineCursor = sourceDuration;
  } else {
    effectiveSegments.forEach((segment, index) => {
      const duration = Math.max(0, segment.to - segment.from);
      if (duration <= 0) return;
      const factor = Math.max(0.01, safeParseFloat(segment.factor, 1));
      const trimmedDuration = duration / factor;

      const videoLabel = `v${index}`;
      const audioLabel = `a${index}`;

      const videoChain = [
        `[0:v]trim=start=${segment.from.toFixed(3)}:end=${segment.to.toFixed(3)}`,
        'setpts=PTS-STARTPTS',
      ];
      if (factor !== 1) {
        videoChain.push(`setpts=(PTS-STARTPTS)/${factor}`);
      }
      filterParts.push(`${videoChain.join(',')}[${videoLabel}]`);

      const audioChain = [
        `[0:a]atrim=start=${segment.from.toFixed(3)}:end=${segment.to.toFixed(3)}`,
        'asetpts=PTS-STARTPTS',
      ];
      if (factor !== 1) {
        audioChain.push(atempoChain(factor));
      }
      filterParts.push(`${audioChain.join(',')}[${audioLabel}]`);

      videoLabels.push(`[${videoLabel}]`);
      audioLabels.push(`[${audioLabel}]`);
      timelineCursor += trimmedDuration;
    });

    if (!videoLabels.length) {
      filterParts.push('[0:v]setpts=PTS-STARTPTS[vcat]');
      filterParts.push('[0:a]asetpts=PTS-STARTPTS[acat]');
      timelineCursor = sourceDuration;
    } else if (videoLabels.length === 1) {
      filterParts.push(`${videoLabels[0]}null[vcat]`);
      filterParts.push(`${audioLabels[0]}anull[acat]`);
    } else {
      filterParts.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[vcat]`);
      filterParts.push(`${audioLabels.join('')}concat=n=${audioLabels.length}:v=0:a=1[acat]`);
    }
  }

  let currentVideoLabel = 'vcat';

  if (transitionEdits.length) {
    // 현재 transition은 단일 연속 스트림 위에 fade in/out를 누적 적용하면
    // 후속 fade-in이 앞 구간 전체를 검게 만드는 문제가 있어 렌더 단계에서는 비활성화한다.
    // transition edit 자체는 EDL 원장에 유지하고, 향후 구간 분할 기반 xfade로 교체한다.
  }

  if (overlayEdits.length && supportsFilter('drawtext')) {
    overlayEdits.forEach((edit, index) => {
      const outLabel = `vtext_${index}`;
      const start = safeParseFloat(edit.at, 0);
      const duration = safeParseFloat(edit.duration, 3);
      const end = start + duration;
      const escapedText = escapeDrawtextText(edit.text || '');
      filterParts.push(
        `[${currentVideoLabel}]drawtext=text='${escapedText}':fontcolor=white:fontsize=56:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-(text_h*2):enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${outLabel}]`
      );
      currentVideoLabel = outLabel;
    });
  }

  if (subtitlePath && supportsFilter('subtitles')) {
    const subtitleLabel = 'vsub';
    filterParts.push(
      `[${currentVideoLabel}]subtitles=filename='${escapeSubtitlesPath(subtitlePath)}'[${subtitleLabel}]`
    );
    currentVideoLabel = subtitleLabel;
  }

  filterParts.push(`[${currentVideoLabel}]null[vout]`);
  filterParts.push('[acat]anull[aout]');

  return {
    filter: filterParts.join(';\n'),
    duration: timelineCursor || sourceDuration,
  };
}

function createFilterScriptFile(contents, suffix) {
  const filePath = path.join(os.tmpdir(), `video-${suffix}-${crypto.randomUUID()}.ffscript`);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function buildPreviewCommand(edl, outputPath, config) {
  ensureFfmpegConfig(config);
  const { filter, duration } = buildFFmpegFilter(edl);
  const previewFilter = `${filter};\n[vout]scale=1280:720:flags=lanczos[vfinal];\n[aout]anull[afinal]`;
  const filterScriptPath = createFilterScriptFile(previewFilter, 'preview');

  const args = [
    'ffmpeg',
    '-y',
    '-nostdin',
    '-i', edl.source,
    '-filter_complex_script', filterScriptPath,
    '-map', '[vfinal]',
    '-map', '[afinal]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '28',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];
  args.filterScriptPath = filterScriptPath;
  args.renderDurationSeconds = duration;
  return args;
}

function buildFinalRenderCommand(edl, outputPath, config) {
  ensureFfmpegConfig(config);
  const { filter, duration } = buildFFmpegFilter(edl);
  const ff = config.ffmpeg;
  const finalFilter = `${filter};\n[vout]scale=${ff.render_width}:${ff.render_height}:flags=lanczos[vscaled];\n[vscaled]fps=${ff.render_fps}[vfinal];\n[aout]anull[afinal]`;
  const filterScriptPath = createFilterScriptFile(finalFilter, 'final');

  const args = [
    'ffmpeg',
    '-y',
    '-nostdin',
    '-i', edl.source,
    '-filter_complex_script', filterScriptPath,
    '-map', '[vfinal]',
    '-map', '[afinal]',
    '-c:v', 'libx264',
    '-preset', String(ff.render_preset),
    '-profile:v', String(ff.render_profile),
    '-pix_fmt', String(ff.render_pixel_format),
    '-r', String(ff.render_fps),
    '-b:v', String(ff.render_bitrate),
    '-movflags', String(ff.render_movflags),
    '-colorspace', String(ff.render_color_space),
    '-color_trc', String(ff.render_color_space),
    '-color_primaries', String(ff.render_color_space),
    '-c:a', 'aac',
    '-b:a', String(ff.audio_bitrate),
    '-ar', String(ff.audio_sample_rate),
    '-ac', String(ff.audio_channels),
    outputPath,
  ];
  args.filterScriptPath = filterScriptPath;
  args.renderDurationSeconds = duration;
  return args;
}

function parseProgressTime(stderrChunk) {
  const matches = [...String(stderrChunk).matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g)];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return (hours * 3600) + (minutes * 60) + seconds;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computePreviewWatchdogOptions(commandArgs) {
  const renderDurationSeconds = safeParseFloat(commandArgs.renderDurationSeconds, 0);
  if (!renderDurationSeconds) {
    return {
      timeoutMs: 15 * 60 * 1000,
      stallTimeoutMs: 3 * 60 * 1000,
    };
  }

  const estimatedRuntimeMs = renderDurationSeconds * 600;
  const timeoutMs = clamp(
    Math.round(estimatedRuntimeMs),
    15 * 60 * 1000,
    60 * 60 * 1000
  );
  const stallTimeoutMs = clamp(
    Math.round(renderDurationSeconds * 100),
    3 * 60 * 1000,
    10 * 60 * 1000
  );

  return {
    timeoutMs,
    stallTimeoutMs,
  };
}

async function executeRender(commandArgs, action, metadata = {}, options = {}) {
  const startedAt = Date.now();
  const [bin, ...args] = commandArgs;
  const filterScriptPath = commandArgs.filterScriptPath;
  const renderDurationSeconds = commandArgs.renderDurationSeconds || null;
  const timeoutMs = options.timeoutMs || 0;
  const stallTimeoutMs = options.stallTimeoutMs || 0;

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    let timeoutId = null;
    let stallIntervalId = null;
    let killTimerId = null;
    let lastProgressSeconds = null;
    let lastProgressAdvanceAt = Date.now();
    let sawProgress = false;

    function cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
      if (stallIntervalId) clearInterval(stallIntervalId);
      if (killTimerId) clearTimeout(killTimerId);
      if (filterScriptPath && fs.existsSync(filterScriptPath)) {
        fs.unlinkSync(filterScriptPath);
      }
    }

    function terminateRender(reason) {
      if (settled) return;
      stderr += `\n[video] ${reason}\n`;
      proc.kill('SIGTERM');
      killTimerId = setTimeout(() => {
        if (!settled) proc.kill('SIGKILL');
      }, 5000);
    }

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        terminateRender(`FFmpeg ${action} 전체 제한 시간(${timeoutMs}ms) 초과`);
      }, timeoutMs);
    }

    if (stallTimeoutMs > 0) {
      stallIntervalId = setInterval(() => {
        if (!sawProgress || settled) return;
        if ((Date.now() - lastProgressAdvanceAt) > stallTimeoutMs) {
          terminateRender(`FFmpeg ${action} 진행 정체(${stallTimeoutMs}ms, last=${lastProgressSeconds ?? 'n/a'}s)`);
        }
      }, 5000);
    }

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      const seconds = parseProgressTime(text);
      if (seconds !== null) {
        sawProgress = true;
        if (lastProgressSeconds === null || seconds > lastProgressSeconds) {
          lastProgressAdvanceAt = Date.now();
          lastProgressSeconds = seconds;
        }
        process.stdout.write(`[${action}] progress: ${seconds.toFixed(1)}s\r`);
      }
    });

    proc.on('error', async err => {
      settled = true;
      cleanup();
      await logToolCall(bin, action, {
        bot: BOT_NAME,
        success: false,
        duration_ms: Date.now() - startedAt,
        error: toErrorMessage(err),
        metadata,
      });
      reject(err);
    });

    proc.on('close', async code => {
      settled = true;
      cleanup();
      const duration_ms = Date.now() - startedAt;
      if (code === 0) {
        await logToolCall(bin, action, {
          bot: BOT_NAME,
          success: true,
          duration_ms,
          metadata: {
            ...metadata,
            renderDurationSeconds,
            lastProgressSeconds,
          },
        });
        process.stdout.write('\n');
        resolve({ success: true, duration_ms, stderr });
        return;
      }

      const error = new Error(`FFmpeg ${action} 실패 (exit ${code}): ${stderr.trim().slice(-500)}`);
      await logToolCall(bin, action, {
        bot: BOT_NAME,
        success: false,
        duration_ms,
        error: toErrorMessage(error),
        metadata,
      });
      reject(error);
    });
  });
}

function hasFastStart(filePath) {
  const buffer = fs.readFileSync(filePath);
  const moovIndex = buffer.indexOf(Buffer.from('moov'));
  const mdatIndex = buffer.indexOf(Buffer.from('mdat'));
  return moovIndex !== -1 && mdatIndex !== -1 && moovIndex < mdatIndex;
}

async function renderPreview(edl, outputPath, config) {
  const args = buildPreviewCommand(edl, outputPath, config);
  const watchdogOptions = computePreviewWatchdogOptions(args);
  const result = await executeRender(args, 'render_preview', {
    source: edl.source,
    outputPath,
    watchdogOptions,
  }, watchdogOptions);
  return {
    success: result.success,
    duration_ms: result.duration_ms,
    outputPath,
  };
}

async function renderFinal(edl, outputPath, config) {
  const args = buildFinalRenderCommand(edl, outputPath, config);
  const result = await executeRender(args, 'render_final', {
    source: edl.source,
    outputPath,
  }, {
    timeoutMs: 90 * 60 * 1000,
    stallTimeoutMs: 2 * 60 * 1000,
  });
  const stats = fs.statSync(outputPath);
  const probe = await getMediaInfo(outputPath);

  return {
    success: result.success,
    duration_ms: result.duration_ms,
    outputPath,
    fileSize: stats.size,
    validation: {
      width: probe.video.width,
      height: probe.video.height,
      fps: probe.video.fps,
      codec: probe.video.codec,
      profile: probe.video.profile,
      audioSampleRate: probe.audio.sampleRate,
      audioChannels: probe.audio.channels,
      faststart: hasFastStart(outputPath),
    },
  };
}

function convertSrtToVtt(srtPath, vttPath) {
  const srt = fs.readFileSync(srtPath, 'utf8').replace(/^\uFEFF/, '');
  const body = srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  fs.writeFileSync(vttPath, `WEBVTT\n\n${body}`, 'utf8');
  return vttPath;
}

module.exports = {
  buildInitialEDL,
  saveEDL,
  loadEDL,
  applyPatch,
  buildFFmpegFilter,
  buildPreviewCommand,
  buildFinalRenderCommand,
  renderPreview,
  renderFinal,
  convertSrtToVtt,
};
