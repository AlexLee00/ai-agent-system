// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { callHubLlm } = require('../../../packages/core/lib/hub-client');

const execFileAsync = promisify(execFile);

const BOT_NAME = 'video';
const TEAM_NAME = 'video';
const OCR_MIN_CONFIDENCE = 40;
const DEFAULT_OCR_WORKERS = 2;
const DEFAULT_TESSERACT_BIN = '/opt/homebrew/bin/tesseract';

function toErrorMessage(error) {
  return error?.stderr || error?.stdout || error?.message || String(error || '알 수 없는 오류');
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

function safeParseFloat(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureSceneIndexerConfig(config = {}) {
  return {
    interval_sec: Number(config?.scene_indexer?.interval_sec || 10),
    max_frames: Number(config?.scene_indexer?.max_frames || 500),
    dedup_threshold: Number(config?.scene_indexer?.dedup_threshold || 5),
    ocr_lang: String(config?.scene_indexer?.ocr_lang || 'eng'),
    ocr_workers: Number(config?.scene_indexer?.ocr_workers || DEFAULT_OCR_WORKERS),
    llm_batch_size: Number(config?.scene_indexer?.llm_batch_size || 8),
    runtime_purpose: String(config?.scene_indexer?.runtime_purpose || 'analysis'),
    llm_timeout_ms: Number(config?.scene_indexer?.llm_timeout_ms || 15000),
  };
}

async function probeDurationSec(videoPath) {
  const { stdout } = await runCommand(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ],
    'scene_index_probe_duration',
    { videoPath }
  );
  return safeParseFloat(String(stdout || '').trim(), 0);
}

function normalizeKeyword(word) {
  return String(word || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .trim();
}

function extractEnglishKeywords(text, words = []) {
  const set = new Set();
  for (const word of words) {
    const confidence = safeParseFloat(word?.confidence, 0);
    if (confidence < OCR_MIN_CONFIDENCE) continue;
    const normalized = normalizeKeyword(word?.text);
    if (normalized.length >= 3) set.add(normalized);
  }

  const textWords = String(text || '').match(/[A-Za-z][A-Za-z0-9]{2,}/g) || [];
  for (const token of textWords) {
    set.add(normalizeKeyword(token));
  }

  return [...set].filter(Boolean).slice(0, 20);
}

function hashFromBuffer(buffer) {
  const pixels = Array.from(buffer || []);
  if (!pixels.length) return '';
  const average = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  return pixels.map((value) => (value >= average ? '1' : '0')).join('');
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}

async function computePerceptualHash(filePath) {
  const buffer = await sharp(filePath)
    .greyscale()
    .resize(8, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  return hashFromBuffer(buffer);
}

async function extractFrames(videoPath, options = {}) {
  const config = ensureSceneIndexerConfig(options.config || {});
  const intervalSec = Number(options.intervalSec || config.interval_sec);
  const maxFrames = Number(options.maxFrames || config.max_frames);
  const tempDir = options.tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'video-scene-index-'));
  const framesDir = path.join(tempDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const durationSec = await probeDurationSec(videoPath);
  const estimatedFrames = Math.max(1, Math.ceil(durationSec / Math.max(intervalSec, 1)));
  const captureFrames = Math.min(maxFrames, estimatedFrames);

  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i', videoPath,
      '-vf', `fps=1/${intervalSec}`,
      '-frames:v', String(captureFrames),
      '-q:v', '2',
      path.join(framesDir, 'frame_%04d.jpg'),
    ],
    'scene_index_extract_frames',
    { videoPath, framesDir, intervalSec, captureFrames }
  );

  const frameFiles = fs.readdirSync(framesDir)
    .filter((name) => /^frame_\d+\.jpg$/.test(name))
    .sort();

  return {
    framesDir,
    frameCount: frameFiles.length,
    intervalSec,
    durationSec,
    frameFiles,
  };
}

async function deduplicateFrames(framesDir, options = {}) {
  const threshold = Number(options.threshold || options.config?.scene_indexer?.dedup_threshold || 5);
  const intervalSec = Number(options.intervalSec || options.config?.scene_indexer?.interval_sec || 10);
  const frameFiles = fs.readdirSync(framesDir)
    .filter((name) => /^frame_\d+\.jpg$/.test(name))
    .sort();

  const uniqueFrames = [];
  let removedCount = 0;
  let previousHash = null;

  for (const fileName of frameFiles) {
    const filePath = path.join(framesDir, fileName);
    const hash = await computePerceptualHash(filePath);
    if (previousHash && hammingDistance(previousHash, hash) < threshold) {
      removedCount += 1;
      continue;
    }

    const match = fileName.match(/frame_(\d+)\.jpg$/);
    const frameId = Number.parseInt(match?.[1] || '0', 10);
    uniqueFrames.push({
      frame_id: frameId,
      file_path: filePath,
      file_name: fileName,
      timestamp_s: Math.max(0, (frameId - 1) * intervalSec),
      phash: hash,
    });
    previousHash = hash;
  }

  return { uniqueFrames, removedCount };
}

async function createOcrWorker(lang) {
  const worker = await Tesseract.createWorker(lang);
  await worker.setParameters({
    preserve_interword_spaces: '1',
  });
  return worker;
}

function parseTesseractTsv(tsvText) {
  const lines = String(tsvText || '').split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split('\t');
    if (parts.length < 12) continue;
    const text = String(parts[11] || '').trim();
    if (!text) continue;
    rows.push({
      level: Number.parseInt(parts[0], 10) || 0,
      page_num: Number.parseInt(parts[1], 10) || 0,
      block_num: Number.parseInt(parts[2], 10) || 0,
      par_num: Number.parseInt(parts[3], 10) || 0,
      line_num: Number.parseInt(parts[4], 10) || 0,
      word_num: Number.parseInt(parts[5], 10) || 0,
      conf: safeParseFloat(parts[10], 0),
      text,
    });
  }
  return rows;
}

async function ocrFrameWithCli(frame, options = {}) {
  const tesseractBin = options.tesseractBin || DEFAULT_TESSERACT_BIN;
  if (!fs.existsSync(tesseractBin)) {
    throw new Error(`tesseract binary not found: ${tesseractBin}`);
  }
  const lang = options.lang || 'eng';
  const { stdout } = await runCommand(
    tesseractBin,
    [frame.file_path, 'stdout', '-l', lang, 'tsv'],
    'scene_index_ocr_frame_cli',
    { frameId: frame.frame_id, filePath: frame.file_path, lang }
  );
  const rows = parseTesseractTsv(stdout);
  const words = rows.map((row) => ({
    text: row.text,
    confidence: row.conf,
  }));
  const rawText = words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
  return {
    ...frame,
    rawText,
    words,
    keywords: extractEnglishKeywords(rawText, words),
    ocr_failed: false,
    ocr_engine: 'tesseract_cli',
  };
}

async function ocrFrames(uniqueFrames, options = {}) {
  const config = ensureSceneIndexerConfig(options.config || {});
  const requestedEngine = String(options.ocrEngine || 'auto').toLowerCase();
  const workersCount = Math.min(
    Math.max(1, Number(options.ocrWorkers || config.ocr_workers)),
    Math.max(1, uniqueFrames.length)
  );
  const lang = options.lang || config.ocr_lang;
  let workers = [];
  let workerBootstrapFailed = null;
  if (requestedEngine !== 'cli') {
    try {
      workers = await Promise.all(
        Array.from({ length: workersCount }, () => createOcrWorker(lang))
      );
    } catch (error) {
      workerBootstrapFailed = error;
      workers = [];
    }
  }

  let cursor = 0;
  const results = new Array(uniqueFrames.length);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : null;

  if (workers.length === 0) {
    await Promise.all(
      Array.from({ length: workersCount }, async (_unused, workerIndex) => {
        while (cursor < uniqueFrames.length) {
          const currentIndex = cursor;
          cursor += 1;
          const frame = uniqueFrames[currentIndex];
          try {
            results[currentIndex] = await ocrFrameWithCli(frame, { lang });
          } catch (error) {
            results[currentIndex] = {
              ...frame,
              rawText: '',
              words: [],
              keywords: [],
              ocr_failed: true,
              error: toErrorMessage(workerBootstrapFailed || error),
              ocr_engine: 'fallback_failed',
            };
          }
          if (progress) {
            progress({
              index: currentIndex + 1,
              total: uniqueFrames.length,
              workerIndex,
              frameId: frame.frame_id,
            });
          }
        }
      })
    );
    return results.filter(Boolean);
  }

  try {
    await Promise.all(workers.map(async (worker, workerIndex) => {
      while (cursor < uniqueFrames.length) {
        const currentIndex = cursor;
        cursor += 1;
        const frame = uniqueFrames[currentIndex];

        try {
          const recognized = await worker.recognize(frame.file_path);
          const rawText = String(recognized?.data?.text || '').replace(/\s+/g, ' ').trim();
          const words = (recognized?.data?.words || []).map((word) => ({
            text: String(word.text || '').trim(),
            confidence: safeParseFloat(word.confidence, 0),
          }));
          results[currentIndex] = {
            ...frame,
            rawText,
            words,
            keywords: extractEnglishKeywords(rawText, words),
            ocr_failed: false,
            ocr_engine: 'tesseract_js',
          };
        } catch (error) {
          try {
            results[currentIndex] = await ocrFrameWithCli(frame, { lang });
          } catch (fallbackError) {
            results[currentIndex] = {
              ...frame,
              rawText: '',
              words: [],
              keywords: [],
              ocr_failed: true,
              error: `${toErrorMessage(error)} | fallback: ${toErrorMessage(fallbackError)}`,
              ocr_engine: 'fallback_failed',
            };
          }
        }

        if (progress) {
          progress({
            index: currentIndex + 1,
            total: uniqueFrames.length,
            workerIndex,
            frameId: frame.frame_id,
          });
        }
      }
    }));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
  }

  return results.filter(Boolean);
}

function extractJsonArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw, raw.match(/\[[\s\S]*\]/)?.[0]].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch (_error) {
      // 다음 후보
    }
  }
  return null;
}

function inferSceneType(keywords = []) {
  const normalized = keywords.map((word) => String(word).toLowerCase());
  if (normalized.some((word) => word.includes('parameter'))) return 'parameter_editor';
  if (normalized.some((word) => word.includes('widget'))) return 'editor_overview';
  if (normalized.some((word) => word.includes('action'))) return 'action_flow';
  if (normalized.some((word) => word.includes('api'))) return 'api_config';
  return 'flutterflow_scene';
}

function fallbackClassifyFrame(frame) {
  return {
    frame_id: frame.frame_id,
    description: frame.rawText
      ? `FlutterFlow 화면 OCR 키워드: ${frame.keywords.slice(0, 5).join(', ')}`
      : 'OCR 키워드 부족으로 장면 설명 생략',
    scene_type: inferSceneType(frame.keywords),
    keywords_en: frame.keywords,
    keywords_ko: [],
    llm_classified: false,
  };
}

async function callSceneClassifier(batch, runtimePurpose, timeoutMs) {
  const prompt = [
    '다음은 FlutterFlow 노코드 개발 도구의 화면 OCR 텍스트입니다.',
    '각 프레임에 대해 JSON 배열로만 답하세요.',
    '{ "frame_id": N, "description": "한국어 설명", "scene_type": "editor_overview", "keywords_en": ["Widget Tree"], "keywords_ko": ["위젯 트리"] }',
    '',
    JSON.stringify(batch.map((item) => ({
      frame_id: item.frame_id,
      timestamp_s: item.timestamp_s,
      ocr_text: item.rawText,
      keywords: item.keywords,
    })), null, 2),
  ].join('\n');

  const startedAt = Date.now();
  const response = await callHubLlm({
    callerTeam: TEAM_NAME,
    agent: 'scene-indexer',
    selectorKey: 'video.scene-indexer',
    taskType: 'scene_classification',
    abstractModel: 'anthropic_sonnet',
    systemPrompt: [
      '당신은 FlutterFlow 비디오 편집용 장면 분류기다.',
      '입력된 OCR 텍스트를 보고 각 프레임을 설명과 장면 타입으로 분류한다.',
      '반드시 JSON 객체 하나만 반환하고 형식은 { "frames": [ ... ] } 여야 한다.',
    ].join('\n'),
    prompt: `${prompt}\n\n응답 형식: { "frames": [ ... ] }`,
    timeoutMs,
  });
  const text = response?.text || '';
  const parsed = JSON.parse(text);
  const frames = Array.isArray(parsed?.frames) ? parsed.frames : extractJsonArray(text);

  await logToolCall(`llm_${response.provider}`, 'scene_classification', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: { model: response.model || 'hub-runtime', provider: response.provider, batchSize: batch.length },
  });

  if (!Array.isArray(frames)) {
    throw new Error('scene classification JSON 파싱 실패');
  }
  return frames;
}

async function classifyScenes(ocrResults, config = {}) {
  const resolved = ensureSceneIndexerConfig(config);
  const batchSize = Math.max(1, resolved.llm_batch_size);
  const scenes = [];

  for (let index = 0; index < ocrResults.length; index += batchSize) {
    const batch = ocrResults.slice(index, index + batchSize);
    try {
      const classified = await callSceneClassifier(batch, resolved.runtime_purpose, resolved.llm_timeout_ms);
      const byId = new Map(classified.map((item) => [Number(item.frame_id), item]));
      for (const frame of batch) {
        const item = byId.get(Number(frame.frame_id));
        if (!item) {
          scenes.push(fallbackClassifyFrame(frame));
          continue;
        }
        scenes.push({
          frame_id: frame.frame_id,
          description: String(item.description || '').trim() || fallbackClassifyFrame(frame).description,
          scene_type: String(item.scene_type || '').trim() || inferSceneType(frame.keywords),
          keywords_en: Array.isArray(item.keywords_en) && item.keywords_en.length ? item.keywords_en : frame.keywords,
          keywords_ko: Array.isArray(item.keywords_ko) ? item.keywords_ko : [],
          llm_classified: true,
        });
      }
    } catch (_error) {
      for (const frame of batch) {
        scenes.push(fallbackClassifyFrame(frame));
      }
    }
  }

  return scenes;
}

async function indexVideo(videoPath, config = {}, options = {}) {
  const resolved = ensureSceneIndexerConfig(config);
  const tempDir = options.tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'video-sync-index-'));
  fs.mkdirSync(tempDir, { recursive: true });

  const extracted = await extractFrames(videoPath, {
    config,
    tempDir,
    intervalSec: options.intervalSec || resolved.interval_sec,
    maxFrames: options.maxFrames || resolved.max_frames,
  });

  const deduped = await deduplicateFrames(extracted.framesDir, {
    config,
    intervalSec: extracted.intervalSec,
    threshold: options.threshold || resolved.dedup_threshold,
  });

  const ocrResults = await ocrFrames(deduped.uniqueFrames, {
    config,
    tempDir,
    lang: resolved.ocr_lang,
    ocrWorkers: resolved.ocr_workers,
    ocrEngine: options.ocrEngine || 'auto',
    onProgress: options.onProgress,
  });
  const classified = await classifyScenes(ocrResults, config);
  const classifiedById = new Map(classified.map((item) => [Number(item.frame_id), item]));

  const scenes = ocrResults.map((frame, index) => {
    const classifiedScene = classifiedById.get(Number(frame.frame_id)) || fallbackClassifyFrame(frame);
    const nextTimestamp = ocrResults[index + 1]?.timestamp_s;
    const timestampEnd = Number.isFinite(nextTimestamp)
      ? nextTimestamp
      : Math.min(extracted.durationSec, frame.timestamp_s + extracted.intervalSec * 2);

    return {
      frame_id: frame.frame_id,
      timestamp_s: frame.timestamp_s,
      timestamp_end_s: timestampEnd,
      ocr_text: frame.rawText,
      description: classifiedScene.description,
      scene_type: classifiedScene.scene_type,
      keywords_en: classifiedScene.keywords_en || frame.keywords,
      keywords_ko: classifiedScene.keywords_ko || [],
      llm_classified: Boolean(classifiedScene.llm_classified),
      ocr_failed: Boolean(frame.ocr_failed),
      frame_path: frame.file_path,
    };
  });

  const sceneIndex = {
    source_video: path.basename(videoPath),
    source_video_path: path.resolve(videoPath),
    duration_s: extracted.durationSec,
    total_frames_captured: extracted.frameCount,
    unique_frames: deduped.uniqueFrames.length,
    frames_dir: extracted.framesDir,
    scenes,
  };

  const outputPath = path.join(tempDir, 'scene_index.json');
  fs.writeFileSync(outputPath, JSON.stringify(sceneIndex, null, 2), 'utf8');
  return { ...sceneIndex, output_path: outputPath };
}

module.exports = {
  extractFrames,
  deduplicateFrames,
  ocrFrames,
  classifyScenes,
  indexVideo,
};
