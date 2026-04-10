import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { selectRuntime } = require('./runtime-selector');

type AspectSize = { width: number; height: number };

type RuntimeProfile = {
  workflow_template_path?: string;
  checkpoint_name?: string;
  base_url?: string;
  timeout_ms?: number;
  poll_ms?: number;
  max_retries?: number;
  image_provider?: string;
};

type WorkflowOptions = {
  workflowTemplatePath?: string;
  aspectRatio?: string;
  outputPrefix?: string;
};

type GenerateOptions = WorkflowOptions & {
  runtimeProfile?: RuntimeProfile;
  baseUrl?: string;
  timeoutMs?: number;
  pollMs?: number;
  retries?: number;
  provider?: string;
  batchSize?: number;
  batchCount?: number;
};

type ImageInfo = {
  filename: string;
  subfolder?: string;
  type?: string;
};

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_RETRIES = 3;
const DEFAULT_DRAWTHINGS_BASE_URL = 'http://127.0.0.1:7860';

const ASPECT_RATIO_MAP: Record<string, AspectSize> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1536, height: 864 },
  '9:16': { width: 864, height: 1536 },
  '3:4': { width: 1024, height: 1365 },
  '4:3': { width: 1365, height: 1024 },
};

function replaceTokens(value: unknown, tokens: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^%([A-Z0-9_]+)%$/);
    if (exact) {
      return tokens[exact[1]] ?? '';
    }
    return value.replace(/%([A-Z0-9_]+)%/g, (_, key: string) => String(tokens[key] ?? ''));
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceTokens(item, tokens));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceTokens(item, tokens)]),
    );
  }
  return value;
}

function loadWorkflowTemplate(profile: RuntimeProfile | null, opts: WorkflowOptions = {}): Record<string, unknown> {
  const explicitPath = opts.workflowTemplatePath || profile?.workflow_template_path || process.env.BLOG_COMFYUI_WORKFLOW_TEMPLATE;
  if (!explicitPath) {
    throw new Error('ComfyUI workflow template path가 설정되지 않았습니다.');
  }
  if (!fs.existsSync(explicitPath)) {
    throw new Error(`ComfyUI workflow template를 찾을 수 없습니다: ${explicitPath}`);
  }
  return JSON.parse(fs.readFileSync(explicitPath, 'utf8')) as Record<string, unknown>;
}

function buildWorkflow(profile: RuntimeProfile | null, prompt: string, opts: WorkflowOptions = {}): { workflow: unknown; outputPrefix: string } {
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

async function fetchJson(url: string, options: RequestInit = {}): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const err = error as { cause?: { code?: string }; message?: string };
    if (err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message || '')) {
      throw new Error(`ComfyUI 서버에 연결할 수 없습니다 (${url}). 서버가 실행 중인지 확인하세요.`);
    }
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ComfyUI HTTP ${response.status}: ${text || 'empty response'}`);
  }
  return text ? JSON.parse(text) as Record<string, any> : {};
}

async function ensureComfyUiReachable(baseUrl: string): Promise<void> {
  await fetchJson(`${baseUrl}/system_stats`);
}

function inferProvider(baseUrl: string, profile: RuntimeProfile | null, opts: GenerateOptions): 'comfyui' | 'drawthings' {
  const explicit = String(
    opts.provider || profile?.image_provider || process.env.BLOG_IMAGE_PROVIDER || '',
  ).trim().toLowerCase();
  if (explicit === 'drawthings' || explicit === 'draw-things') return 'drawthings';
  if (explicit === 'comfyui' || explicit === 'comfy') return 'comfyui';
  if (/:7860(?:\/|$)/.test(baseUrl) || /\/sdapi(?:\/|$)/.test(baseUrl)) return 'drawthings';
  return 'comfyui';
}

async function ensureDrawThingsReachable(baseUrl: string): Promise<void> {
  await fetchJson(`${baseUrl}/sdapi/v1/options`);
}

async function generateWithDrawThings(
  prompt: string,
  baseUrl: string,
  opts: GenerateOptions,
  profile: RuntimeProfile | null,
): Promise<Record<string, unknown>> {
  const aspectRatio = opts.aspectRatio || '1:1';
  const size = ASPECT_RATIO_MAP[aspectRatio] || ASPECT_RATIO_MAP['1:1'];
  const negativePrompt = process.env.BLOG_DRAWTHINGS_NEGATIVE_PROMPT
    || process.env.BLOG_COMFYUI_NEGATIVE_PROMPT
    || '';
  const steps = Number(process.env.BLOG_DRAWTHINGS_STEPS || process.env.BLOG_COMFYUI_STEPS || 4);
  const guidanceScale = Number(process.env.BLOG_DRAWTHINGS_CFG || process.env.BLOG_COMFYUI_CFG || 4.5);
  const batchSize = Math.max(1, Number(opts.batchSize || 1));
  const batchCount = Math.max(1, Number(opts.batchCount || 1));
  const startedAt = Date.now();

  await ensureDrawThingsReachable(baseUrl);
  const response = await fetchJson(`${baseUrl}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: negativePrompt,
      width: size.width,
      height: size.height,
      steps,
      guidance_scale: guidanceScale,
      batch_size: batchSize,
      batch_count: batchCount,
      sampler: String(process.env.BLOG_DRAWTHINGS_SAMPLER || 'Euler A Trailing'),
    }),
  });

  const firstImage = Array.isArray(response?.images) ? response.images[0] : null;
  if (!firstImage || typeof firstImage !== 'string') {
    throw new Error('Draw Things 이미지 응답이 없습니다.');
  }

  return {
    buffer: Buffer.from(firstImage, 'base64'),
    source: 'drawthings',
    execution_mode: 'local_image',
    duration_ms: Date.now() - startedAt,
    batch_size: batchSize,
    batch_count: batchCount,
    model: profile?.checkpoint_name || null,
  };
}

async function queuePrompt(baseUrl: string, workflow: unknown, clientId: string): Promise<Record<string, any>> {
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

async function readHistory(baseUrl: string, promptId: string): Promise<Record<string, any>> {
  return fetchJson(`${baseUrl}/history/${promptId}`);
}

function findFirstImageOutput(historyEntry: Record<string, any> | undefined): ImageInfo | null {
  const outputs = historyEntry?.outputs || {};
  for (const node of Object.values(outputs)) {
    const images = (node as { images?: ImageInfo[] } | null)?.images;
    if (Array.isArray(images) && images.length > 0) {
      return images[0];
    }
  }
  return null;
}

async function downloadImage(baseUrl: string, imageInfo: ImageInfo): Promise<Buffer> {
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

async function waitForImage(baseUrl: string, promptId: string, timeoutMs: number, pollMs: number): Promise<ImageInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await readHistory(baseUrl, promptId);
    const entry = history?.[promptId];
    const imageInfo = findFirstImageOutput(entry);
    if (imageInfo) {
      return imageInfo;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`ComfyUI 결과 대기 타임아웃 (${Math.round(timeoutMs / 1000)}초)`);
}

async function generateWithComfyUI(prompt: string, opts: GenerateOptions = {}): Promise<Record<string, unknown>> {
  const profile = opts.runtimeProfile || await selectRuntime('blog', 'image-local') || {};
  const baseUrl = String(opts.baseUrl || process.env.BLOG_IMAGE_BASE_URL || profile.base_url || DEFAULT_BASE_URL);
  const timeoutMs = Number(opts.timeoutMs || profile.timeout_ms || DEFAULT_TIMEOUT_MS);
  const pollMs = Number(opts.pollMs || profile.poll_ms || DEFAULT_POLL_MS);
  const retries = Math.max(1, Number(opts.retries || profile.max_retries || DEFAULT_RETRIES));
  const clientId = crypto.randomUUID();
  const provider = inferProvider(baseUrl, profile, opts);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    try {
      if (provider === 'drawthings') {
        const drawThingsBaseUrl = String(opts.baseUrl || process.env.BLOG_IMAGE_BASE_URL || profile.base_url || DEFAULT_DRAWTHINGS_BASE_URL);
        const result = await generateWithDrawThings(prompt, drawThingsBaseUrl, opts, profile);
        return {
          ...result,
          attempt,
        };
      }
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
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  const err = lastError as { message?: string } | null;
  const providerLabel = provider === 'drawthings' ? 'Draw Things' : 'ComfyUI';
  throw new Error(`${providerLabel} 로컬 이미지 생성 실패: ${err?.message || 'unknown error'}`);
}

export = {
  generateWithComfyUI,
};
