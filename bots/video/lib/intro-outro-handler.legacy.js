'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');

const execFileAsync = promisify(execFile);

const BOT_NAME = 'video';
const TEAM_NAME = 'video';
const FILTER_SUPPORT_CACHE = new Map();

function toErrorMessage(error) {
  return error?.stderr || error?.stdout || error?.message || String(error || '알 수 없는 오류');
}

async function runCommand(bin, args, action, metadata = {}) {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(bin, args, { maxBuffer: 50 * 1024 * 1024 });
    await logToolCall(bin, action, {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata,
    });
    return result;
  } catch (error) {
    await logToolCall(bin, action, {
      bot: BOT_NAME,
      success: false,
      duration_ms: Date.now() - startedAt,
      error: toErrorMessage(error),
      metadata,
    });
    throw error;
  }
}

function ensureIntroOutroConfig(config = {}) {
  return {
    default_intro_duration_sec: Number(config?.intro_outro?.default_intro_duration_sec || 3),
    default_outro_duration_sec: Number(config?.intro_outro?.default_outro_duration_sec || 5),
    default_bg_color: String(config?.intro_outro?.default_bg_color || 'black'),
    default_text_color: String(config?.intro_outro?.default_text_color || 'white'),
    default_font_size: Number(config?.intro_outro?.default_font_size || 72),
    fade_duration_sec: Number(config?.intro_outro?.fade_duration_sec || 0.5),
    llm_model: String(config?.intro_outro?.llm_model || 'gpt-4o-mini'),
    fallback_enabled: Boolean(typeof config?.intro_outro?.fallback_enabled === 'boolean' ? config.intro_outro.fallback_enabled : true),
  };
}

async function supportsFilter(filterName) {
  if (FILTER_SUPPORT_CACHE.has(filterName)) {
    return FILTER_SUPPORT_CACHE.get(filterName);
  }
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-filters'], {
      maxBuffer: 5 * 1024 * 1024,
    });
    const supported = new RegExp(`\\b${filterName}\\b`).test(stdout);
    FILTER_SUPPORT_CACHE.set(filterName, supported);
    return supported;
  } catch (_error) {
    FILTER_SUPPORT_CACHE.set(filterName, false);
    return false;
  }
}

function normalizeModeOptions(kind, value = {}, config = {}) {
  const introOutro = ensureIntroOutroConfig(config);
  const defaultDuration = kind === 'intro'
    ? introOutro.default_intro_duration_sec
    : introOutro.default_outro_duration_sec;
  return {
    mode: String(value.mode || 'none'),
    filePath: value.filePath ? path.resolve(value.filePath) : null,
    prompt: String(value.prompt || '').trim(),
    logoPath: value.logoPath ? path.resolve(value.logoPath) : null,
    durationSec: Number(value.durationSec || defaultDuration),
    title: String(value.title || '').trim() || (kind === 'intro' ? '인트로' : '아웃트로'),
  };
}

async function normalizeClipToTarget(filePath, outputPath, options) {
  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i', filePath,
      '-vf', `scale=${options.targetWidth}:${options.targetHeight},setsar=1,fps=${options.targetFps}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-an',
      outputPath,
    ],
    'normalize_intro_outro_clip',
    { filePath, outputPath, targetWidth: options.targetWidth, targetHeight: options.targetHeight, targetFps: options.targetFps }
  );
  return outputPath;
}

async function callTitleCardPlanner(prompt, title, options, config) {
  const introOutro = ensureIntroOutroConfig(config);
  const startedAt = Date.now();
  const response = await callWithFallback({
    chain: selectLLMChain('video.intro-outro'),
    systemPrompt: [
      '당신은 FFmpeg 제목 카드 기획기다.',
      '입력된 조건에 맞는 제목 카드 사양을 JSON 객체 하나로만 반환한다.',
      '{ "bgColor": "black", "textColor": "white", "fontSize": 72, "title": "...", "subtitle": "...", "fadeInSec": 0.5, "fadeOutSec": 0.5 }',
    ].join('\n'),
    userPrompt: [
      `title=${title}`,
      `prompt=${prompt}`,
      `durationSec=${options.durationSec}`,
      `target=${options.targetWidth}x${options.targetHeight}@${options.targetFps}`,
      `logo=${options.logoPath || 'none'}`,
    ].join('\n'),
    logMeta: {
      team: TEAM_NAME,
      purpose: 'editing',
      bot: 'intro-outro-handler',
      agentName: 'intro-outro-handler',
      selectorKey: 'video.intro-outro',
      requestType: 'intro_outro_plan',
    },
  });
  const content = response?.text || '{}';
  const parsed = JSON.parse(content);
  await logToolCall(`llm_${response.provider}`, 'intro_outro_plan', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: { model: response.model || introOutro.llm_model, provider: response.provider },
  });

  return parsed;
}

async function buildDefaultTitleCard(options) {
  const introOutro = ensureIntroOutroConfig(options.config || {});
  const outputPath = options.outputPath;
  const title = String(options.title || '').replace(/'/g, "\\'");
  const fadeDuration = Number(options.fadeDurationSec || introOutro.fade_duration_sec);
  const fadeOutStart = Math.max(0, Number(options.durationSec || 3) - fadeDuration);
  const drawtextSupported = await supportsFilter('drawtext');

  const filterGraph = drawtextSupported
    ? `drawtext=text='${title}':fontsize=${options.fontSize || introOutro.default_font_size}:fontcolor=${options.textColor || introOutro.default_text_color}:x=(w-text_w)/2:y=(h-text_h)/2,fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${fadeOutStart}:d=${fadeDuration}`
    : `fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${fadeOutStart}:d=${fadeDuration}`;

  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=${options.bgColor || introOutro.default_bg_color}:s=${options.targetWidth}x${options.targetHeight}:d=${options.durationSec}:r=${options.targetFps}`,
      '-vf', filterGraph,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-an',
      outputPath,
    ],
    'build_default_title_card',
    { outputPath, title, durationSec: options.durationSec, drawtextSupported }
  );

  return outputPath;
}

async function buildPromptTitleCard(kind, modeOptions, options, config) {
  const outputPath = path.join(options.tempDir, `${kind}_prompt.mp4`);
  const introOutro = ensureIntroOutroConfig(config);

  try {
    const plan = await callTitleCardPlanner(modeOptions.prompt, modeOptions.title, options, config);
    return await buildDefaultTitleCard({
      ...options,
      config,
      outputPath,
      title: String(plan.title || modeOptions.title || '').trim() || modeOptions.title,
      bgColor: String(plan.bgColor || introOutro.default_bg_color),
      textColor: String(plan.textColor || introOutro.default_text_color),
      fontSize: Number(plan.fontSize || introOutro.default_font_size),
      fadeDurationSec: Number(plan.fadeInSec || introOutro.fade_duration_sec),
      durationSec: modeOptions.durationSec,
    });
  } catch (_error) {
    if (!introOutro.fallback_enabled) {
      throw _error;
    }
    return buildDefaultTitleCard({
      ...options,
      config,
      outputPath,
      title: modeOptions.title,
      durationSec: modeOptions.durationSec,
    });
  }
}

async function processSingle(kind, modeOptions, options, config) {
  if (!modeOptions || modeOptions.mode === 'none') return null;
  const outputPath = path.join(options.tempDir, `${kind}_clip.mp4`);

  if (modeOptions.mode === 'file' && modeOptions.filePath) {
    const clipPath = await normalizeClipToTarget(modeOptions.filePath, outputPath, options);
    return {
      kind,
      mode: 'file',
      clipPath,
      durationSec: modeOptions.durationSec,
      title: modeOptions.title,
    };
  }

  if (modeOptions.mode === 'prompt') {
    const clipPath = await buildPromptTitleCard(kind, modeOptions, { ...options, outputPath }, config);
    return {
      kind,
      mode: 'prompt',
      clipPath,
      durationSec: modeOptions.durationSec,
      title: modeOptions.title,
      prompt: modeOptions.prompt,
    };
  }

  return null;
}

async function processIntroOutro(config, options = {}) {
  const tempDir = options.tempDir || path.join(process.cwd(), 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });
  const introOptions = normalizeModeOptions('intro', options.intro, config);
  const outroOptions = normalizeModeOptions('outro', options.outro, config);
  const shared = {
    targetWidth: Number(options.targetWidth),
    targetHeight: Number(options.targetHeight),
    targetFps: Number(options.targetFps),
    tempDir,
  };

  const introClip = await processSingle('intro', introOptions, shared, config);
  const outroClip = await processSingle('outro', outroOptions, shared, config);
  return { introClip, outroClip };
}

async function concatWithMainEdit(introClip, mainEditPath, outroClip, outputPath) {
  const inputFiles = [introClip?.clipPath, mainEditPath, outroClip?.clipPath].filter(Boolean);
  if (inputFiles.length === 1) {
    fs.copyFileSync(inputFiles[0], outputPath);
    return outputPath;
  }

  const listPath = path.join(path.dirname(outputPath), `concat-${Date.now()}.txt`);
  fs.writeFileSync(
    listPath,
    inputFiles.map((filePath) => `file '${String(filePath).replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );

  try {
    await runCommand(
      'ffmpeg',
      [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-an',
        outputPath,
      ],
      'concat_intro_outro',
      { outputPath, inputFiles }
    );
  } finally {
    if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
  }

  return outputPath;
}

module.exports = {
  processIntroOutro,
  buildDefaultTitleCard,
  concatWithMainEdit,
};
