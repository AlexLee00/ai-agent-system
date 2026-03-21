'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OpenAI = require('openai');

const { getOpenAIKey } = require('../../../packages/core/lib/llm-keys');
const { logLLMCall } = require('../../../packages/core/lib/llm-logger');
const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { generateSubtitle } = require('./whisper-client');
const { correctFile } = require('./subtitle-corrector');
const { probeDurationMs } = require('./ffmpeg-preprocess');

const BOT_NAME = 'video';
const TEAM_NAME = 'video';

function ensureNarrationConfig(config = {}) {
  return {
    segment_min_sec: Number(config?.narration_analyzer?.segment_min_sec || 10),
    segment_max_sec: Number(config?.narration_analyzer?.segment_max_sec || 60),
    correct_subtitle: Boolean(
      typeof config?.narration_analyzer?.correct_subtitle === 'boolean'
        ? config.narration_analyzer.correct_subtitle
        : true
    ),
    llm_model: String(config?.narration_analyzer?.llm_model || 'gpt-4o-mini'),
    llm_timeout_ms: Number(config?.narration_analyzer?.llm_timeout_ms || 15000),
  };
}

function safeParseFloat(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSrtTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return 0;
  const [, hh, mm, ss, ms] = match.map(Number);
  return (((hh * 60) + mm) * 60 + ss) + (ms / 1000);
}

function parseSrt(srtText) {
  return String(srtText || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.length < 3) return null;
      const index = Number.parseInt(lines[0].trim(), 10);
      const timeMatch = lines[1].trim().match(/^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/);
      if (!Number.isInteger(index) || !timeMatch) return null;
      const startSec = parseSrtTime(timeMatch[1]);
      const endSec = parseSrtTime(timeMatch[2]);
      return {
        index,
        start: timeMatch[1],
        end: timeMatch[2],
        startSec,
        endSec,
        text: lines.slice(2).join(' ').replace(/\s+/g, ' ').trim(),
      };
    })
    .filter(Boolean);
}

function extractEnglishKeywords(text) {
  const tokens = String(text || '').match(/[A-Za-z][A-Za-z0-9]{2,}/g) || [];
  return [...new Set(tokens)].slice(0, 10);
}

function mechanicalSegments(entries, config) {
  const segments = [];
  let current = [];
  let currentStart = null;

  for (const entry of entries) {
    if (!current.length) {
      current = [entry];
      currentStart = entry.startSec;
      continue;
    }

    const currentEnd = entry.endSec;
    const currentDuration = currentEnd - currentStart;
    const reachedMax = currentDuration >= config.segment_max_sec;
    const reachedMinAndSentence = currentDuration >= config.segment_min_sec && /[.!?…]$/.test(entry.text);

    current.push(entry);

    if (reachedMax || reachedMinAndSentence) {
      const combinedText = current.map((item) => item.text).join(' ').trim();
      segments.push({
        segment_id: segments.length + 1,
        start_s: current[0].startSec,
        end_s: current[current.length - 1].endSec,
        entries: current.map((item) => item.index),
        text: combinedText,
        topic: combinedText.slice(0, 30) || `구간 ${segments.length + 1}`,
        required_screen: '연관 FlutterFlow 화면',
        keywords_en: extractEnglishKeywords(combinedText),
        keywords_ko: [],
        action_verbs: [],
        llm_analyzed: false,
      });
      current = [];
      currentStart = null;
    }
  }

  if (current.length) {
    const combinedText = current.map((item) => item.text).join(' ').trim();
    segments.push({
      segment_id: segments.length + 1,
      start_s: current[0].startSec,
      end_s: current[current.length - 1].endSec,
      entries: current.map((item) => item.index),
      text: combinedText,
      topic: combinedText.slice(0, 30) || `구간 ${segments.length + 1}`,
      required_screen: '연관 FlutterFlow 화면',
      keywords_en: extractEnglishKeywords(combinedText),
      keywords_ko: [],
      action_verbs: [],
      llm_analyzed: false,
    });
  }

  return segments;
}

async function transcribeNarration(audioPath, config, options = {}) {
  const tempDir = options.tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'video-narration-'));
  fs.mkdirSync(tempDir, { recursive: true });
  const rawSrtPath = options.outputSrtPath || path.join(tempDir, 'narration_raw.srt');
  await generateSubtitle(audioPath, rawSrtPath, config);
  return rawSrtPath;
}

async function callNarrationAnalyzer(entries, modelName, timeoutMs) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OpenAI API 키가 없습니다.');

  const client = new OpenAI({ apiKey, timeout: timeoutMs });
  const payload = entries.map((entry) => ({
    index: entry.index,
    start_s: entry.startSec,
    end_s: entry.endSec,
    text: entry.text,
  }));
  const prompt = [
    '다음은 FlutterFlow 강의 나레이션 자막입니다.',
    '의미 단위 구간으로 나누고 JSON 객체 하나로만 답하세요.',
    '{ "segments": [ { "segment_id": 1, "start_s": 0, "end_s": 32, "entries": [1,2], "topic": "...", "required_screen": "...", "keywords_en": ["Parameter"], "keywords_ko": ["파라미터"], "action_verbs": ["클릭"] } ] }',
    JSON.stringify(payload, null, 2),
  ].join('\n');

  const startedAt = Date.now();
  const response = await client.chat.completions.create({
    model: modelName,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'user', content: prompt },
    ],
  });
  const text = response?.choices?.[0]?.message?.content || '';
  const parsed = JSON.parse(text);
  const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];

  await logLLMCall({
    team: TEAM_NAME,
    bot: 'narration-analyzer',
    model: modelName,
    requestType: 'narration_segment_analysis',
    inputTokens: response?.usage?.prompt_tokens || 0,
    outputTokens: response?.usage?.completion_tokens || 0,
    costUsd: 0,
    latencyMs: Date.now() - startedAt,
    success: true,
  });
  await logToolCall('llm_openai', 'narration_segment_analysis', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: { model: modelName, entryCount: entries.length },
  });

  return segments;
}

async function analyzeSegments(entries, config = {}) {
  const resolved = ensureNarrationConfig(config);
  try {
    const segments = await callNarrationAnalyzer(entries, resolved.llm_model, resolved.llm_timeout_ms);
    if (!Array.isArray(segments) || !segments.length) {
      return mechanicalSegments(entries, resolved);
    }
    return segments.map((segment, index) => {
      const segmentEntryIds = Array.isArray(segment.entries) && segment.entries.length
        ? segment.entries.map((value) => Number(value)).filter(Number.isFinite)
        : entries
          .filter((entry) => entry.startSec >= safeParseFloat(segment.start_s) && entry.endSec <= safeParseFloat(segment.end_s))
          .map((entry) => entry.index);
      const relevantEntries = entries.filter((entry) => segmentEntryIds.includes(entry.index));
      const text = relevantEntries.map((entry) => entry.text).join(' ').trim();
      return {
        segment_id: Number(segment.segment_id || index + 1),
        start_s: safeParseFloat(segment.start_s, relevantEntries[0]?.startSec || 0),
        end_s: safeParseFloat(segment.end_s, relevantEntries[relevantEntries.length - 1]?.endSec || 0),
        entries: segmentEntryIds,
        text,
        topic: String(segment.topic || '').trim() || text.slice(0, 30),
        required_screen: String(segment.required_screen || '').trim() || '연관 FlutterFlow 화면',
        keywords_en: Array.isArray(segment.keywords_en) && segment.keywords_en.length ? segment.keywords_en : extractEnglishKeywords(text),
        keywords_ko: Array.isArray(segment.keywords_ko) ? segment.keywords_ko : [],
        action_verbs: Array.isArray(segment.action_verbs) ? segment.action_verbs : [],
        llm_analyzed: true,
      };
    });
  } catch (_error) {
    return mechanicalSegments(entries, resolved);
  }
}

async function analyzeNarration(audioPath, config = {}, options = {}) {
  const resolved = ensureNarrationConfig(config);
  const tempDir = options.tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'video-narration-analysis-'));
  fs.mkdirSync(tempDir, { recursive: true });

  const rawSrtPath = await transcribeNarration(audioPath, config, {
    tempDir,
    outputSrtPath: path.join(tempDir, 'narration_raw.srt'),
  });

  let workingSrtPath = rawSrtPath;
  let correctedSrtPath = null;
  if (options.correct !== false && resolved.correct_subtitle) {
    correctedSrtPath = path.join(tempDir, 'narration_corrected.srt');
    const corrected = await correctFile(rawSrtPath, correctedSrtPath, config);
    workingSrtPath = corrected.outputPath;
  }

  const srtText = fs.readFileSync(workingSrtPath, 'utf8');
  const entries = parseSrt(srtText);
  const segments = await analyzeSegments(entries, config);
  const durationMs = await probeDurationMs(audioPath);

  const payload = {
    source_audio: path.basename(audioPath),
    source_audio_path: path.resolve(audioPath),
    duration_s: Number((durationMs / 1000).toFixed(3)),
    total_entries: entries.length,
    total_segments: segments.length,
    segments,
    srt_path: rawSrtPath,
    corrected_srt_path: correctedSrtPath,
  };

  const outputPath = path.join(tempDir, 'narration_segments.json');
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  return { ...payload, output_path: outputPath, entries };
}

module.exports = {
  transcribeNarration,
  parseSrt,
  analyzeSegments,
  analyzeNarration,
};
