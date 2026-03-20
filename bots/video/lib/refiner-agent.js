'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { getGeminiKey, getGroqAccounts } = require('../../../packages/core/lib/llm-keys');
const { logLLMCall } = require('../../../packages/core/lib/llm-logger');
const { logToolCall } = require('../../../packages/core/lib/tool-logger');

const { loadEDL, saveEDL, applyPatch } = require('./edl-builder');
const { normalizeAudio } = require('./ffmpeg-preprocess');
const { parseSrt } = require('./critic-agent');

const execFileAsync = promisify(execFile);

const BOT_NAME = 'video';
const TEAM_NAME = 'video';
const LLM_TIMEOUT_MS = 45 * 1000;

function toErrorMessage(error) {
  return error?.stderr || error?.stdout || error?.message || String(error || '알 수 없는 오류');
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function safeParseFloat(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function loadJsonMaybe(input) {
  if (typeof input === 'string') {
    return JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  }
  return input || {};
}

function nextVersionedPath(filePath) {
  const resolved = path.resolve(filePath);
  const parsed = path.parse(resolved);
  const baseMatch = parsed.name.match(/^(.*?)(?:_v(\d+))?$/);
  const stem = (baseMatch?.[1] || parsed.name).replace(/_v\d+$/, '');
  const dirEntries = fs.readdirSync(parsed.dir);
  let maxVersion = 1;

  for (const entry of dirEntries) {
    const entryPath = path.parse(entry);
    if (entryPath.ext !== parsed.ext) continue;
    const match = entryPath.name.match(new RegExp(`^${escapeRegex(stem)}(?:_v(\\d+))?$`));
    if (!match) continue;
    const version = match[1] ? Number.parseInt(match[1], 10) : 1;
    if (Number.isInteger(version)) {
      maxVersion = Math.max(maxVersion, version);
    }
  }

  const nextVersion = maxVersion + 1;
  return {
    version: nextVersion,
    outputPath: path.join(parsed.dir, `${stem}_v${nextVersion}${parsed.ext}`),
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function msToTimestamp(ms) {
  const normalized = Math.max(0, Math.round(ms));
  const hours = Math.floor(normalized / 3600000);
  const minutes = Math.floor((normalized % 3600000) / 60000);
  const seconds = Math.floor((normalized % 60000) / 1000);
  const millis = normalized % 1000;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':') + `,${String(millis).padStart(3, '0')}`;
}

function serializeSrt(entries) {
  return entries.map((entry) => {
    const text = String(entry.text || '').replace(/\r\n/g, '\n').trimEnd();
    return [
      String(entry.index),
      `${entry.start} --> ${entry.end}`,
      text,
    ].join('\n');
  }).join('\n\n') + '\n';
}

function buildIssueMap(issues) {
  const grouped = new Map();
  for (const issue of issues || []) {
    const key = Number.parseInt(issue.entry, 10);
    if (!Number.isInteger(key)) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(issue);
  }
  return grouped;
}

function splitLongLine(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length <= 40 || normalized.includes('\n')) {
    return normalized;
  }

  const center = Math.min(20, Math.floor(normalized.length / 2));
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] !== ' ') continue;
    const distance = Math.abs(index - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  if (bestIndex === -1) {
    return normalized;
  }
  return `${normalized.slice(0, bestIndex).trim()}\n${normalized.slice(bestIndex + 1).trim()}`;
}

function stripGroqPrefix(modelName) {
  return String(modelName || '').replace(/^groq\//, '');
}

function getGroqApiKey() {
  const accounts = getGroqAccounts();
  const accountKey = Array.isArray(accounts) ? accounts.find(account => account?.api_key)?.api_key : null;
  return accountKey || process.env.GROQ_API_KEY || null;
}

async function callGroqRefine(prompt, modelName) {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error('Groq API 키가 없습니다.');
  }

  const startedAt = Date.now();
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });
  const response = await Promise.race([
    client.chat.completions.create({
      model: stripGroqPrefix(modelName),
      temperature: 0.1,
      reasoning_effort: 'low',
      messages: [
        { role: 'user', content: prompt },
      ],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Groq 호출 timeout')), LLM_TIMEOUT_MS)),
  ]);

  const text = response?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('Groq 응답 본문이 비어 있습니다.');
  }

  const inputTokens = response?.usage?.prompt_tokens || estimateTokens(prompt);
  const outputTokens = response?.usage?.completion_tokens || estimateTokens(text);
  const durationMs = Date.now() - startedAt;

  await logLLMCall({
    team: TEAM_NAME,
    bot: 'refiner-agent',
    model: modelName,
    requestType: 'subtitle_refine',
    inputTokens,
    outputTokens,
    costUsd: 0,
    latencyMs: durationMs,
    success: true,
  });

  await logToolCall('llm_groq', 'subtitle_refine', {
    bot: BOT_NAME,
    success: true,
    duration_ms: durationMs,
    metadata: { model: modelName, inputTokens, outputTokens, costUsd: 0 },
  });

  return {
    text,
    costUsd: 0,
    provider: 'groq',
    model: modelName,
  };
}

async function callGeminiRefine(prompt, modelName = 'gemini-2.5-flash') {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error('Gemini API 키가 없습니다.');
  }

  const startedAt = Date.now();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const response = await Promise.race([
    model.generateContent(prompt),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini 호출 timeout')), LLM_TIMEOUT_MS)),
  ]);
  const text = response?.response?.text?.()?.trim();
  if (!text) {
    throw new Error('Gemini 응답 본문이 비어 있습니다.');
  }

  const usage = response?.response?.usageMetadata || {};
  const inputTokens = usage.promptTokenCount || estimateTokens(prompt);
  const outputTokens = usage.candidatesTokenCount || estimateTokens(text);
  const durationMs = Date.now() - startedAt;

  await logLLMCall({
    team: TEAM_NAME,
    bot: 'refiner-agent',
    model: modelName,
    requestType: 'subtitle_refine',
    inputTokens,
    outputTokens,
    costUsd: 0,
    latencyMs: durationMs,
    success: true,
  });

  await logToolCall('llm_gemini', 'subtitle_refine', {
    bot: BOT_NAME,
    success: true,
    duration_ms: durationMs,
    metadata: { model: modelName, inputTokens, outputTokens, costUsd: 0 },
  });

  return {
    text,
    costUsd: 0,
    provider: 'gemini',
    model: modelName,
  };
}

async function refineSubtitleWithLLM(text, config) {
  const provider = String(config?.quality_loop?.refiner?.provider || 'groq').toLowerCase();
  const model = config?.quality_loop?.refiner?.model || 'groq/gpt-oss-20b';
  const prompt = [
    '다음 자막 텍스트를 교정해주세요. FlutterFlow IT 강의 자막입니다.',
    '수정된 텍스트만 반환하세요.',
    `원본: ${text}`,
  ].join('\n');

  try {
    if (provider === 'gemini') {
      return await callGeminiRefine(prompt, model);
    }
    return await callGroqRefine(prompt, model);
  } catch (primaryError) {
    await logToolCall(provider === 'gemini' ? 'llm_gemini' : 'llm_groq', 'subtitle_refine', {
      bot: BOT_NAME,
      success: false,
      duration_ms: 0,
      error: toErrorMessage(primaryError),
      metadata: { model },
    });
    return callGeminiRefine(prompt, 'gemini-2.5-flash');
  }
}

async function refineSubtitles(criticReport, subtitlePath, config) {
  const startedAt = Date.now();
  const subtitleIssues = (criticReport?.issues || []).filter((issue) => (
    ['subtitle_typo', 'subtitle_terminology', 'subtitle_length', 'subtitle_sync'].includes(issue.type)
  ));

  if (!subtitleIssues.length) {
    await logToolCall('refiner_agent', 'refine_subtitles', {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: { subtitlePath, issues: 0, changed: false },
    });
    return {
      outputPath: path.resolve(subtitlePath),
      changes: [],
      cost_usd: 0,
    };
  }

  const rawSrt = fs.readFileSync(subtitlePath, 'utf8');
  const entries = parseSrt(rawSrt).map((entry) => ({ ...entry }));
  const grouped = buildIssueMap(subtitleIssues);
  const changes = [];
  let llmCostUsd = 0;

  for (const entry of entries) {
    const entryIssues = grouped.get(entry.index) || [];
    if (!entryIssues.length) continue;

    let updatedText = entry.text;
    let updatedStartMs = entry.startMs;
    let updatedEndMs = entry.endMs;

    for (const issue of entryIssues) {
      try {
        if ((issue.type === 'subtitle_typo' || issue.type === 'subtitle_terminology') && issue.fix) {
          const before = updatedText;
          if (issue.current && updatedText.includes(issue.current)) {
            updatedText = updatedText.replace(issue.current, issue.fix);
          } else if (!issue.current) {
            updatedText = issue.fix;
          }
          if (before !== updatedText) {
            changes.push({ entry: entry.index, type: issue.type, before, after: updatedText });
          }
          continue;
        }

        if (issue.type === 'subtitle_sync' && Number.isFinite(Number(issue.offset_ms))) {
          const offsetMs = Number(issue.offset_ms);
          const before = `${msToTimestamp(updatedStartMs)} --> ${msToTimestamp(updatedEndMs)}`;
          updatedStartMs += offsetMs;
          updatedEndMs += offsetMs;
          const after = `${msToTimestamp(updatedStartMs)} --> ${msToTimestamp(updatedEndMs)}`;
          if (before !== after) {
            changes.push({ entry: entry.index, type: issue.type, before, after });
          }
          continue;
        }

        if (issue.type === 'subtitle_length') {
          const before = updatedText;
          updatedText = splitLongLine(updatedText);
          if (before !== updatedText) {
            changes.push({ entry: entry.index, type: issue.type, before, after: updatedText });
          }
          continue;
        }

        const before = updatedText;
        const llmResult = await refineSubtitleWithLLM(updatedText, config);
        llmCostUsd += Number(llmResult.costUsd || 0);
        updatedText = llmResult.text;
        if (before !== updatedText) {
          changes.push({ entry: entry.index, type: issue.type, before, after: updatedText });
        }
      } catch (error) {
        await logToolCall('refiner_agent', 'subtitle_issue', {
          bot: BOT_NAME,
          success: false,
          duration_ms: 0,
          error: toErrorMessage(error),
          metadata: { entry: entry.index, issueType: issue.type },
        });
      }
    }

    entry.text = updatedText;
    entry.startMs = Math.max(0, updatedStartMs);
    entry.endMs = Math.max(entry.startMs, updatedEndMs);
    entry.start = msToTimestamp(entry.startMs);
    entry.end = msToTimestamp(entry.endMs);
  }

  if (!changes.length) {
    await logToolCall('refiner_agent', 'refine_subtitles', {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: { subtitlePath, issues: subtitleIssues.length, changed: false },
    });
    return {
      outputPath: path.resolve(subtitlePath),
      changes: [],
      cost_usd: Number(llmCostUsd.toFixed(6)),
    };
  }

  const { outputPath } = nextVersionedPath(subtitlePath);
  fs.writeFileSync(outputPath, serializeSrt(entries), 'utf8');

  await logToolCall('refiner_agent', 'refine_subtitles', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      subtitlePath,
      outputPath,
      issues: subtitleIssues.length,
      changes: changes.length,
      llmCostUsd: Number(llmCostUsd.toFixed(6)),
    },
  });

  return {
    outputPath,
    changes,
    cost_usd: Number(llmCostUsd.toFixed(6)),
  };
}

function hasSimilarEdit(edits, candidate, toleranceSeconds = 0.3) {
  return edits.some((edit) => {
    if (edit.type !== candidate.type) return false;
    if (candidate.type === 'cut') {
      return Math.abs(safeParseFloat(edit.from) - safeParseFloat(candidate.from)) <= toleranceSeconds
        && Math.abs(safeParseFloat(edit.to) - safeParseFloat(candidate.to)) <= toleranceSeconds;
    }
    if (candidate.type === 'transition') {
      return Math.abs(safeParseFloat(edit.at) - safeParseFloat(candidate.at)) <= toleranceSeconds;
    }
    return false;
  });
}

async function refineEDL(criticReport, edlPath, _config) {
  const startedAt = Date.now();
  const edlIssues = (criticReport?.issues || []).filter((issue) => (
    ['silent_gap', 'freeze_frame', 'scene_change', 'excessive_scenes', 'low_efficiency'].includes(issue.type)
  ));

  if (!edlIssues.length) {
    await logToolCall('refiner_agent', 'refine_edl', {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: { edlPath, issues: 0, changed: false },
    });
    return {
      outputPath: path.resolve(edlPath),
      changes: [],
    };
  }

  const originalEdl = loadEDL(edlPath);
  const currentEdits = Array.isArray(originalEdl.edits) ? [...originalEdl.edits] : [];
  const patch = { add: [], remove: [], modify: [] };
  const changes = [];

  for (const issue of edlIssues) {
    try {
      if (issue.type === 'silent_gap') {
        const candidate = {
          type: 'cut',
          from: safeParseFloat(issue.from),
          to: safeParseFloat(issue.to),
          reason: '무음 구간',
        };
        if (!hasSimilarEdit(currentEdits.concat(patch.add), candidate)) {
          patch.add.push(candidate);
          changes.push({ type: 'silent_gap', action: 'add_cut', detail: candidate });
        }
        continue;
      }

      if (issue.type === 'freeze_frame') {
        const candidate = {
          type: 'cut',
          from: safeParseFloat(issue.from),
          to: safeParseFloat(issue.to),
          reason: '정지 화면',
        };
        if (!hasSimilarEdit(currentEdits.concat(patch.add), candidate)) {
          patch.add.push(candidate);
          changes.push({ type: 'freeze_frame', action: 'add_cut', detail: candidate });
        }
        continue;
      }

      if (issue.type === 'scene_change') {
        const candidate = {
          type: 'transition',
          at: safeParseFloat(issue.at),
          effect: 'fade',
          duration: 0.5,
          score: safeParseFloat(issue.score, 0),
        };
        if (!hasSimilarEdit(currentEdits.concat(patch.add), candidate, 1.0)) {
          patch.add.push(candidate);
          changes.push({ type: 'scene_change', action: 'add_transition', detail: candidate });
        }
        continue;
      }

      if (issue.type === 'excessive_scenes') {
        const transitionIndices = currentEdits
          .map((edit, index) => ({ edit, index }))
          .filter(item => item.edit.type === 'transition')
          .sort((a, b) => safeParseFloat(a.edit.score, 0) - safeParseFloat(b.edit.score, 0));
        const removeCount = Math.max(1, Math.floor(transitionIndices.length * 0.1));
        const removed = transitionIndices.slice(0, removeCount).map(item => item.index);
        patch.remove.push(...removed);
        if (removed.length) {
          changes.push({ type: 'excessive_scenes', action: 'remove_transitions', detail: { count: removed.length } });
        }
        continue;
      }

      if (issue.type === 'low_efficiency') {
        changes.push({ type: 'low_efficiency', action: 'review_only', detail: { ratio: issue.ratio } });
      }
    } catch (error) {
      await logToolCall('refiner_agent', 'edl_issue', {
        bot: BOT_NAME,
        success: false,
        duration_ms: 0,
        error: toErrorMessage(error),
        metadata: { issueType: issue.type },
      });
    }
  }

  const uniqueRemove = [...new Set(patch.remove)].sort((a, b) => b - a);
  patch.remove = uniqueRemove;

  if (!patch.add.length && !patch.remove.length && !patch.modify.length) {
    await logToolCall('refiner_agent', 'refine_edl', {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: { edlPath, issues: edlIssues.length, changed: false },
    });
    return {
      outputPath: path.resolve(edlPath),
      changes,
    };
  }

  const nextEdl = applyPatch(originalEdl, patch);
  const { outputPath } = nextVersionedPath(edlPath);
  saveEDL(nextEdl, outputPath);

  await logToolCall('refiner_agent', 'refine_edl', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      edlPath,
      outputPath,
      issues: edlIssues.length,
      changes: changes.length,
      added: patch.add.length,
      removed: patch.remove.length,
    },
  });

  return {
    outputPath,
    changes,
  };
}

async function refineAudio(criticReport, videoPath, config) {
  const startedAt = Date.now();
  const audioIssues = (criticReport?.issues || []).filter((issue) => (
    issue.type === 'audio_lufs' || issue.type === 'audio_peak'
  ));

  if (!audioIssues.length) {
    await logToolCall('refiner_agent', 'refine_audio', {
      bot: BOT_NAME,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: { videoPath, issues: 0, changed: false },
    });
    return null;
  }

  if (!videoPath) {
    throw new Error('오디오 재정규화를 위한 videoPath가 필요합니다.');
  }

  const resolvedVideoPath = path.resolve(videoPath);
  const dir = path.dirname(resolvedVideoPath);
  const extractedAudioPath = path.join(dir, 'refiner_audio_extract.m4a');
  const { outputPath } = nextVersionedPath(path.join(dir, 'narr_norm.m4a'));

  await runCommand(
    'ffmpeg',
    ['-y', '-i', resolvedVideoPath, '-vn', '-c:a', 'copy', extractedAudioPath],
    'extract_audio_for_refine',
    { videoPath: resolvedVideoPath, extractedAudioPath }
  );

  try {
    await normalizeAudio(extractedAudioPath, outputPath, config);
  } finally {
    if (fs.existsSync(extractedAudioPath)) {
      fs.unlinkSync(extractedAudioPath);
    }
  }

  const changes = audioIssues.map((issue) => ({
    type: issue.type,
    before: issue.measured,
    after: issue.target,
  }));

  await logToolCall('refiner_agent', 'refine_audio', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      videoPath: resolvedVideoPath,
      outputPath,
      issues: audioIssues.length,
      changes: changes.length,
    },
  });

  return {
    outputPath,
    changes,
  };
}

function saveRefinerResult(result, outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return outputPath;
}

async function runRefiner(criticReportOrPath, subtitlePath, edlPath, config, options = {}) {
  const startedAt = Date.now();
  const criticReport = loadJsonMaybe(criticReportOrPath);

  const subtitleResult = await refineSubtitles(criticReport, subtitlePath, config);
  const edlResult = await refineEDL(criticReport, edlPath, config);
  const audioResult = await refineAudio(criticReport, options.videoPath || options.syncedVideoPath, config);

  const versions = [
    subtitleResult.outputPath,
    edlResult.outputPath,
    audioResult?.outputPath,
  ]
    .filter(Boolean)
    .map((filePath) => {
      const match = path.basename(filePath).match(/_v(\d+)\./);
      return match ? Number.parseInt(match[1], 10) : 1;
    })
    .filter(Number.isInteger);
  const version = versions.length ? Math.max(...versions) : 1;
  const costUsd = Number(((subtitleResult.cost_usd || 0) + 0).toFixed(6));

  const result = {
    version,
    timestamp: new Date().toISOString(),
    critic_score: Number(criticReport.score || 0),
    subtitle: {
      path: subtitleResult.outputPath,
      changes_count: subtitleResult.changes.length,
      changes: subtitleResult.changes,
    },
    edl: {
      path: edlResult.outputPath,
      changes_count: edlResult.changes.length,
      changes: edlResult.changes,
    },
    audio: audioResult ? {
      path: audioResult.outputPath,
      changes_count: audioResult.changes.length,
      changes: audioResult.changes,
    } : null,
    total_changes: subtitleResult.changes.length + edlResult.changes.length + (audioResult?.changes.length || 0),
    cost_usd: costUsd,
  };

  await logToolCall('refiner_agent', 'run_refiner', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      criticScore: result.critic_score,
      version,
      totalChanges: result.total_changes,
      costUsd,
    },
  });

  return result;
}

module.exports = {
  runRefiner,
  refineSubtitles,
  refineEDL,
  refineAudio,
  saveRefinerResult,
};
