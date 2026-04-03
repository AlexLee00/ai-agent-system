'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { selectRuntime } = require('./runtime-selector');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_RETRIES = 3;

const ASPECT_RATIO_MAP = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1536, height: 864 },
  '9:16': { width: 864, height: 1536 },
  '3:4': { width: 1024, height: 1365 },
  '4:3': { width: 1365, height: 1024 },
};

function replaceTokens(value, tokens) {
  if (typeof value === 'string') {
    const exact = value.match(/^%([A-Z0-9_]+)%$/);
    if (exact) {
      return tokens[exact[1]] ?? '';
    }
    return value.replace(/%([A-Z0-9_]+)%/g, (_, key) => String(tokens[key] ?? ''));
  }
  if (Array.isArray(value)) {
    return value.map(item => replaceTokens(item, tokens));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceTokens(item, tokens)]),
    );
  }
  return value;
}

function loadWorkflowTemplate(profile, opts = {}) {
  const explicitPath = opts.workflowTemplatePath || profile?.workflow_template_path || process.env.BLOG_COMFYUI_WORKFLOW_TEMPLATE;
  if (!explicitPath) {
    throw new Error('ComfyUI workflow template path가 설정되지 않았습니다.');
  }
  if (!fs.existsSync(explicitPath)) {
    throw new Error(`ComfyUI workflow template를 찾을 수 없습니다: ${explicitPath}`);
  }
  const raw = fs.readFileSync(explicitPath, 'utf8');
  return JSON.parse(raw);
}

function buildWorkflow(profile, prompt, opts = {}) {
  const template = loadWorkflowTemplate(profile, opts);
  const aspectRatio = opts.aspectRatio || '1:1';
  const size = ASPECT_RATIO_MAP[aspectRatio] || ASPECT_RATIO_MAP['1:1'];
  const outputPrefix = opts.outputPrefix || `blog_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  const tokens = {
    PROMPT: prompt,
    NEGATIVE_PROMPT: process.env.BLOG_COMFYUI_NEGATIVE_PROMPT || '',
    WIDTH: size.width,
    HEIGHT: size.height,
    OUTPUT_PREFIX: outputPrefix,
    CKPT_NAME: process.env.BLOG_COMFYUI_CHECKPOINT || profile?.checkpoint_name || 'sd_xl_base_1.0.safetensors',
    STEPS: Number(process.env.BLOG_COMFYUI_STEPS || 28),
    CFG: Number(process.env.BLOG_COMFYUI_CFG || 6.5),
  };

  return {
    workflow: replaceTokens(template, tokens),
    outputPrefix,
  };
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(error?.message || '')) {
      throw new Error(`ComfyUI 서버에 연결할 수 없습니다 (${url}). 서버가 실행 중인지 확인하세요.`);
    }
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ComfyUI HTTP ${response.status}: ${text || 'empty response'}`);
  }
  return text ? JSON.parse(text) : {};
}

async function ensureComfyUiReachable(baseUrl) {
  await fetchJson(`${baseUrl}/system_stats`);
}

async function queuePrompt(baseUrl, workflow, clientId) {
  const body = JSON.stringify({
    prompt: workflow,
    client_id: clientId,
  });
  return fetchJson(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

async function readHistory(baseUrl, promptId) {
  return fetchJson(`${baseUrl}/history/${promptId}`);
}

function findFirstImageOutput(historyEntry) {
  const outputs = historyEntry?.outputs || {};
  for (const node of Object.values(outputs)) {
    const images = node?.images;
    if (Array.isArray(images) && images.length > 0) {
      return images[0];
    }
  }
  return null;
}

async function downloadImage(baseUrl, imageInfo) {
  const params = new URLSearchParams({
    filename: imageInfo.filename,
    subfolder: imageInfo.subfolder || '',
    type: imageInfo.type || 'output',
  });
  const response = await fetch(`${baseUrl}/view?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`ComfyUI 이미지 다운로드 실패 (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function waitForImage(baseUrl, promptId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await readHistory(baseUrl, promptId);
    const entry = history?.[promptId];
    const imageInfo = findFirstImageOutput(entry);
    if (imageInfo) {
      return imageInfo;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`ComfyUI 결과 대기 타임아웃 (${Math.round(timeoutMs / 1000)}초)`);
}

async function generateWithComfyUI(prompt, opts = {}) {
  const profile = opts.runtimeProfile || await selectRuntime('blog', 'image-local') || {};
  const baseUrl = opts.baseUrl || profile.base_url || DEFAULT_BASE_URL;
  const timeoutMs = Number(opts.timeoutMs || profile.timeout_ms || DEFAULT_TIMEOUT_MS);
  const pollMs = Number(opts.pollMs || profile.poll_ms || DEFAULT_POLL_MS);
  const retries = Math.max(1, Number(opts.retries || profile.max_retries || DEFAULT_RETRIES));
  const clientId = crypto.randomUUID();

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    try {
      if (attempt === 1) {
        await ensureComfyUiReachable(baseUrl);
      }
      const { workflow, outputPrefix } = buildWorkflow(profile, prompt, opts);
      const queued = await queuePrompt(baseUrl, workflow, clientId);
      const promptId = queued?.prompt_id;
      if (!promptId) {
        throw new Error('ComfyUI prompt_id 응답이 없습니다.');
      }
      const imageInfo = await waitForImage(baseUrl, promptId, timeoutMs, pollMs);
      const buffer = await downloadImage(baseUrl, imageInfo);
      return {
        buffer,
        source: 'comfyui',
        execution_mode: 'local_image',
        output_prefix: outputPrefix,
        prompt_id: promptId,
        duration_ms: Date.now() - startedAt,
        attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw new Error(`ComfyUI 로컬 이미지 생성 실패: ${lastError?.message || 'unknown error'}`);
}

module.exports = {
  generateWithComfyUI,
};
