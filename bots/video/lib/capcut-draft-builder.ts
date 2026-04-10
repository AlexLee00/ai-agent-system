// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { logToolCall } = require('../../../packages/core/lib/tool-logger');

const BOT_NAME = 'video';
const DEFAULT_TIMEOUT_MS = 30_000;

function ensureCapCutConfig(config) {
  if (!config || !config.capcut_api || !config.paths || !config.ffmpeg) {
    throw new Error('CapCut draft builder에는 config.capcut_api / config.paths / config.ffmpeg 설정이 필요합니다.');
  }
  if (!config.capcut_api.host) {
    throw new Error('config.capcut_api.host가 비어 있습니다.');
  }
  if (!config.capcut_api.mcp_cwd) {
    throw new Error('config.capcut_api.mcp_cwd가 비어 있습니다.');
  }
  if (!config.paths.capcut_drafts) {
    throw new Error('config.paths.capcut_drafts가 비어 있습니다.');
  }
}

function nowMs() {
  return Date.now();
}

function withTimeout(timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function toErrorMessage(error) {
  if (!error) return '알 수 없는 오류';
  if (error.name === 'AbortError') {
    return `요청 타임아웃 (${DEFAULT_TIMEOUT_MS}ms)`;
  }
  return error.message || String(error);
}

async function logCapCutCall(action, startedAt, success, metadata = {}, error = null) {
  await logToolCall('capcut_api', action, {
    bot: BOT_NAME,
    success,
    duration_ms: nowMs() - startedAt,
    error: error || undefined,
    metadata,
  });
}

async function postJson(config, endpoint, body, action, timeoutMs = DEFAULT_TIMEOUT_MS) {
  ensureCapCutConfig(config);
  const url = `${config.capcut_api.host}${endpoint}`;
  const startedAt = nowMs();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: withTimeout(timeoutMs),
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`CapCutAPI JSON 파싱 실패 (${endpoint}): ${text.slice(0, 200)}`);
    }

    if (!response.ok || payload?.success === false) {
      const errorMessage = payload?.error || `CapCutAPI ${action} 실패 (HTTP ${response.status})`;
      throw new Error(errorMessage);
    }

    await logCapCutCall(action, startedAt, true, {
      endpoint,
      bodyKeys: Object.keys(body || {}),
    });

    return payload;
  } catch (error) {
    const message = toErrorMessage(error);
    await logCapCutCall(action, startedAt, false, {
      endpoint,
      bodyKeys: Object.keys(body || {}),
    }, message);
    throw new Error(`CapCutAPI ${action} 실패: ${message}`);
  }
}

async function getJson(config, endpoint, action, timeoutMs = DEFAULT_TIMEOUT_MS) {
  ensureCapCutConfig(config);
  const url = `${config.capcut_api.host}${endpoint}`;
  const startedAt = nowMs();

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: withTimeout(timeoutMs),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`CapCutAPI JSON 파싱 실패 (${endpoint}): ${text.slice(0, 200)}`);
    }

    if (!response.ok || payload?.success === false) {
      const errorMessage = payload?.error || `CapCutAPI ${action} 실패 (HTTP ${response.status})`;
      throw new Error(errorMessage);
    }

    await logCapCutCall(action, startedAt, true, { endpoint });
    return payload;
  } catch (error) {
    const message = toErrorMessage(error);
    await logCapCutCall(action, startedAt, false, { endpoint }, message);
    throw new Error(`CapCutAPI ${action} 실패: ${message}`);
  }
}

function ensureFileExists(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} 파일을 찾을 수 없습니다: ${filePath}`);
  }
}

async function healthCheck(config) {
  const startedAt = nowMs();
  const payload = await getJson(config, '/get_font_types', 'health_check');
  return {
    alive: true,
    latency_ms: nowMs() - startedAt,
    fontCount: Array.isArray(payload.output) ? payload.output.length : 0,
  };
}

async function createDraft(config, options = {}) {
  const payload = await postJson(
    config,
    '/create_draft',
    {
      width: options.width || config.ffmpeg.render_width || 2560,
      height: options.height || config.ffmpeg.render_height || 1440,
    },
    'create_draft'
  );

  return {
    draftId: payload.output?.draft_id,
    draftUrl: payload.output?.draft_url || '',
  };
}

async function addVideo(config, draftId, videoPath, options = {}) {
  ensureFileExists(videoPath, '영상');
  return postJson(
    config,
    '/add_video',
    {
      draft_id: draftId,
      video_url: videoPath,
      start: options.start || 0,
      end: options.end || 0,
      width: options.width || config.ffmpeg.render_width || 2560,
      height: options.height || config.ffmpeg.render_height || 1440,
      volume: options.volume ?? 0,
      track_name: options.trackName || 'video_main',
    },
    'add_video'
  );
}

async function addAudio(config, draftId, audioPath, options = {}) {
  ensureFileExists(audioPath, '오디오');
  return postJson(
    config,
    '/add_audio',
    {
      draft_id: draftId,
      audio_url: audioPath,
      start: options.start || 0,
      volume: options.volume ?? 1.0,
      track_name: options.trackName || 'audio_main',
    },
    'add_audio'
  );
}

async function addSubtitle(config, draftId, srtContent, options = {}) {
  if (!String(srtContent || '').trim()) {
    throw new Error('SRT 내용이 비어 있습니다.');
  }

  return postJson(
    config,
    '/add_subtitle',
    {
      draft_id: draftId,
      srt: srtContent,
      font: options.font || '文轩体',
      font_size: options.fontSize || 8.0,
      font_color: options.fontColor || '#FFFFFF',
      border_width: options.borderWidth || 1.5,
      border_color: options.borderColor || '#000000',
      background_alpha: options.backgroundAlpha || 0.0,
      transform_y: options.transformY || -0.8,
      vertical: options.vertical ?? false,
      alpha: options.alpha ?? 1.0,
      width: options.width || config.ffmpeg.render_width || 2560,
      height: options.height || config.ffmpeg.render_height || 1440,
    },
    'add_subtitle'
  );
}

async function saveDraft(config, draftId) {
  await postJson(
    config,
    '/save_draft',
    { draft_id: draftId },
    'save_draft'
  );

  return {
    draftId,
    saved: true,
  };
}

function findDraftFolder(config, draftId) {
  ensureCapCutConfig(config);

  const draftPath = path.join(config.capcut_api.mcp_cwd, draftId);
  if (!fs.existsSync(draftPath)) {
    throw new Error(`CapCut draft 폴더를 찾을 수 없습니다: ${draftPath}`);
  }

  return { draftPath };
}

function copyToCapCut(dfdPath, capCutDir) {
  ensureFileExists(dfdPath, 'CapCut draft');
  if (!fs.existsSync(capCutDir)) {
    throw new Error(`CapCut Desktop 프로젝트 경로를 찾을 수 없습니다: ${capCutDir}`);
  }

  const dfdName = path.basename(dfdPath);
  const targetPath = path.join(capCutDir, dfdName);
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.cpSync(dfdPath, targetPath, { recursive: true });

  return {
    copied: true,
    targetPath,
  };
}

async function buildDraft(config, syncedVideoPath, normalizedAudioPath, correctedSrtPath, title) {
  ensureCapCutConfig(config);
  ensureFileExists(syncedVideoPath, '동기화 영상');
  ensureFileExists(normalizedAudioPath, '정규화 오디오');
  ensureFileExists(correctedSrtPath, '교정 자막');

  const srtContent = fs.readFileSync(correctedSrtPath, 'utf8');

  await healthCheck(config);
  const { draftId, draftUrl } = await createDraft(config, {
    width: config.ffmpeg.render_width,
    height: config.ffmpeg.render_height,
    title,
  });

  await addVideo(config, draftId, syncedVideoPath, {
    width: config.ffmpeg.render_width,
    height: config.ffmpeg.render_height,
    volume: 0,
  });
  await addAudio(config, draftId, normalizedAudioPath, {
    volume: 1.0,
  });
  await addSubtitle(config, draftId, srtContent, {
    width: config.ffmpeg.render_width,
    height: config.ffmpeg.render_height,
  });

  await saveDraft(config, draftId);
  const { draftPath } = findDraftFolder(config, draftId);
  const { targetPath } = copyToCapCut(draftPath, config.paths.capcut_drafts);

  return {
    draftId,
    draftUrl,
    draftPath,
    capCutPath: targetPath,
  };
}

module.exports = {
  healthCheck,
  createDraft,
  addVideo,
  addAudio,
  addSubtitle,
  saveDraft,
  findDraftFolder,
  copyToCapCut,
  buildDraft,
};
