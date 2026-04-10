'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const { enhanceCriticWithRAG } = require('./video-rag');

const execFileAsync = promisify(execFile);

const BOT_NAME = 'video';
const TEAM_NAME = 'video';
const SUBTITLE_CHUNK_SIZE = 25;
const LLM_TIMEOUT_MS = 45 * 1000;

function toErrorMessage(error) {
  return error?.stderr || error?.stdout || error?.message || String(error || '알 수 없는 오류');
}

async function runCommand(bin, args, action, metadata = {}) {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(bin, args, { maxBuffer: 20 * 1024 * 1024 });
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

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function timestampToMs(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return 0;
  const [, hh, mm, ss, mmm] = match.map(Number);
  return (((hh * 60) + mm) * 60 + ss) * 1000 + mmm;
}

function parseSrt(srtContent) {
  return String(srtContent || '')
    .trim()
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.replace(/\r\n/g, '\n').split('\n');
      if (lines.length < 3) return null;
      const index = Number.parseInt(lines[0].trim(), 10);
      const timeMatch = lines[1].trim().match(/^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/);
      if (!Number.isInteger(index) || !timeMatch) return null;
      const start = timeMatch[1];
      const end = timeMatch[2];
      const text = lines.slice(2).join(' ').trim();
      return {
        index,
        start,
        end,
        startMs: timestampToMs(start),
        endMs: timestampToMs(end),
        text,
      };
    })
    .filter(Boolean);
}

function extractJsonArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
  const candidates = [
    fenced?.[1],
    raw,
    raw.match(/\[[\s\S]*\]/)?.[0],
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch (_error) {
      // 다음 후보 시도
    }
  }
  return null;
}

function mapSubtitleIssues(issues) {
  return (Array.isArray(issues) ? issues : [])
    .map((issue) => {
      const entry = Number.parseInt(issue.entry, 10);
      if (!Number.isInteger(entry)) return null;

      if (issue.type === 'typo') {
        return {
          type: 'subtitle_typo',
          entry,
          current: issue.current || '',
          fix: issue.fix || '',
          action: 'fix_text',
        };
      }
      if (issue.type === 'terminology') {
        return {
          type: 'subtitle_terminology',
          entry,
          current: issue.current || '',
          fix: issue.fix || '',
          action: 'fix_text',
        };
      }
      if (issue.type === 'length') {
        return {
          type: 'subtitle_length',
          entry,
          current: issue.current || '',
          action: 'split_line',
        };
      }
      return null;
    })
    .filter(Boolean);
}

async function callCriticLLM(prompt) {
  const startedAt = Date.now();
  const response = await callWithFallback({
    chain: selectLLMChain('video.critic'),
    systemPrompt: [
      '당신은 비디오 자막 RED 리뷰어다.',
      '주어진 자막 청크에서 IT 전문용어 오류, 맞춤법 오류, 길이 문제를 찾아 JSON 배열만 반환하라.',
      '[{ "entry": 번호, "type": "typo"|"terminology"|"length", "current": "현재 텍스트", "fix": "수정 텍스트" }]',
      '오류가 없으면 반드시 []만 반환하라.',
    ].join('\n'),
    userPrompt: prompt,
    timeoutMs: LLM_TIMEOUT_MS,
    logMeta: {
      team: TEAM_NAME,
      purpose: 'review',
      bot: 'critic-agent',
      agentName: 'critic',
      selectorKey: 'video.critic',
      requestType: 'critic_subtitle_review',
    },
  });
  const durationMs = Date.now() - startedAt;

  await logToolCall(`llm_${response.provider}`, 'critic_subtitle_review', {
    bot: BOT_NAME,
    success: true,
    duration_ms: durationMs,
    metadata: { model: response.model, provider: response.provider, costUsd: 0 },
  });

  return {
    text: response.text,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    provider: response.provider,
    model: response.model,
  };
}

async function analyzeSubtitles(subtitlePath, config) {
  const startedAt = Date.now();
  const entries = parseSrt(fs.readFileSync(subtitlePath, 'utf8'));
  const chunks = chunkArray(entries, SUBTITLE_CHUNK_SIZE);
  const issues = [];
  let hasParseFailure = false;
  let llmCostUsd = 0;
  let llmProvider = 'unknown';
  let llmModel = 'unknown';

  for (const chunk of chunks) {
    const chunkText = chunk
      .map((entry) => `${entry.index}\n${entry.start} --> ${entry.end}\n${entry.text}`)
      .join('\n\n');

    const prompt = [
      '다음은 FlutterFlow 강의 자막입니다. IT 전문용어 오류와 맞춤법 오류를 찾아주세요.',
      '각 오류를 JSON 배열로 반환하세요.',
      '[{ "entry": 번호, "type": "typo"|"terminology"|"length", "current": "현재 텍스트", "fix": "수정 텍스트" }]',
      '오류가 없으면 빈 배열 []을 반환하세요.',
      '',
      chunkText,
    ].join('\n');

    let response;
    try {
      response = await callCriticLLM(prompt);
    } catch (llmError) {
      await logToolCall('llm_fallback', 'critic_subtitle_review', {
        bot: BOT_NAME,
        success: false,
        duration_ms: 0,
        error: toErrorMessage(llmError),
        metadata: { selectorKey: 'video.critic' },
      });
      throw llmError;
    }

    llmCostUsd += Number(response.costUsd || 0);
    llmProvider = response.provider;
    llmModel = response.model;
    const parsed = extractJsonArray(response.text);
    if (!parsed) {
      hasParseFailure = true;
      await logToolCall('critic_agent', 'subtitle_json_parse', {
        bot: BOT_NAME,
        success: false,
        duration_ms: 0,
        error: 'LLM 응답 JSON 추출 실패',
        metadata: { model: response.model },
      });
      continue;
    }

    issues.push(...mapSubtitleIssues(parsed));
  }

  const baseScore = Math.max(0, 100 - (issues.length * 3));
  const score = hasParseFailure ? Math.min(baseScore, 50) : baseScore;
  await logToolCall('critic_agent', 'analyze_subtitles', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      subtitlePath,
      entries: entries.length,
      issues: issues.length,
      score,
      llmProvider,
      llmModel,
      llmCostUsd: Number(llmCostUsd.toFixed(6)),
      hasParseFailure,
    },
  });

  return {
    score,
    issues,
    entryCount: entries.length,
    llmCostUsd: Number(llmCostUsd.toFixed(6)),
    llmProvider,
    llmModel,
  };
}

function extractLoudnormJson(stderr) {
  const text = String(stderr || '');
  const match = text.match(/\{\s*"input_i"[\s\S]*?\}/m);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_error) {
    return null;
  }
}

function mergeNearbyScenes(scenes, windowSeconds = 1.0) {
  const sorted = [...(Array.isArray(scenes) ? scenes : [])]
    .map((scene) => ({
      at: Number(scene.at),
      score: Number(scene.score || 0),
    }))
    .filter((scene) => Number.isFinite(scene.at))
    .sort((a, b) => a.at - b.at);

  const merged = [];
  for (const scene of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && Math.abs(scene.at - previous.at) <= windowSeconds) {
      if (scene.score >= previous.score) {
        previous.at = scene.at;
        previous.score = scene.score;
      }
      continue;
    }
    merged.push({ ...scene });
  }
  return merged;
}

async function analyzeAudio(videoPath, _config) {
  const startedAt = Date.now();
  const issues = [];

  const { stderr } = await runCommand(
    'ffmpeg',
    ['-i', videoPath, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
    'analyze_audio',
    { videoPath }
  );

  const parsed = extractLoudnormJson(stderr);
  if (!parsed) {
    throw new Error('loudnorm 측정 JSON을 찾지 못했습니다.');
  }

  const measuredLufs = Number.parseFloat(parsed.input_i);
  const measuredPeak = Number.parseFloat(parsed.input_tp);
  if (Number.isFinite(measuredLufs) && (measuredLufs < -16 || measuredLufs > -12)) {
    issues.push({
      type: 'audio_lufs',
      measured: Number(measuredLufs.toFixed(2)),
      target: -14.0,
      action: 'renormalize',
    });
  }
  if (Number.isFinite(measuredPeak) && measuredPeak > -1.0) {
    issues.push({
      type: 'audio_peak',
      measured: Number(measuredPeak.toFixed(2)),
      target: -1.0,
      action: 'renormalize',
    });
  }

  let score = 100;
  if (issues.find((issue) => issue.type === 'audio_lufs') && issues.find((issue) => issue.type === 'audio_peak')) {
    score = 50;
  } else if (issues.find((issue) => issue.type === 'audio_peak')) {
    score = 60;
  } else if (issues.find((issue) => issue.type === 'audio_lufs')) {
    score = 70;
  }

  await logToolCall('critic_agent', 'analyze_audio', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      videoPath,
      measuredLufs: Number.isFinite(measuredLufs) ? Number(measuredLufs.toFixed(2)) : null,
      measuredPeak: Number.isFinite(measuredPeak) ? Number(measuredPeak.toFixed(2)) : null,
      issues: issues.length,
      score,
    },
  });

  return {
    score,
    issues,
    audioLufs: Number.isFinite(measuredLufs) ? Number(measuredLufs.toFixed(2)) : null,
    audioPeak: Number.isFinite(measuredPeak) ? Number(measuredPeak.toFixed(2)) : null,
  };
}

function analyzeVideoStructure(analysisData, _config) {
  const analysis = analysisData || {};
  const duration = Number.parseFloat(analysis.duration || 0);
  const silences = Array.isArray(analysis.silences) ? analysis.silences : [];
  const freezes = Array.isArray(analysis.freezes) ? analysis.freezes : [];
  const scenes = mergeNearbyScenes(Array.isArray(analysis.scenes) ? analysis.scenes : []);
  const issues = [];

  for (const silence of silences) {
    issues.push({
      type: 'silent_gap',
      from: Number(silence.from),
      to: Number(silence.to),
      duration: Number(silence.duration),
      action: 'cut',
    });
  }

  for (const freeze of freezes) {
    issues.push({
      type: 'freeze_frame',
      from: Number(freeze.from),
      to: Number(freeze.to),
      duration: Number(freeze.duration),
      action: 'cut',
    });
  }

  const durationMinutes = duration > 0 ? duration / 60 : 0;
  const sceneDensity = durationMinutes > 0 ? scenes.length / durationMinutes : 0;
  if (sceneDensity > 3) {
    issues.push({
      type: 'excessive_scenes',
      count: scenes.length,
      action: 'reduce_transitions',
    });
  }

  const topScenes = [...scenes]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 10);
  for (const scene of topScenes) {
    issues.push({
      type: 'scene_change',
      at: Number(scene.at),
      score: Number(scene.score || 0),
      action: 'add_transition',
    });
  }

  const inefficientSeconds = silences.reduce((sum, item) => sum + Number(item.duration || 0), 0)
    + freezes.reduce((sum, item) => sum + Number(item.duration || 0), 0);
  const inefficiencyRatio = duration > 0 ? inefficientSeconds / duration : 0;
  if (inefficiencyRatio >= 0.3) {
    issues.push({
      type: 'low_efficiency',
      ratio: Number(inefficiencyRatio.toFixed(3)),
      action: 'review_cuts',
    });
  }

  const score = Math.max(
    0,
    Math.round(100 - (silences.length * 5) - (freezes.length * 5) - (inefficiencyRatio * 0.5))
  );

  logToolCall('critic_agent', 'analyze_video_structure', {
    bot: BOT_NAME,
    success: true,
    duration_ms: 0,
    metadata: {
      duration,
      silences: silences.length,
      freezes: freezes.length,
      scenes: scenes.length,
      sceneDensity: Number(sceneDensity.toFixed(2)),
      inefficiencyRatio: Number(inefficiencyRatio.toFixed(3)),
      score,
    },
  }).catch(() => {});

  return {
    score,
    issues,
    silencesCount: silences.length,
    freezesCount: freezes.length,
    scenesCount: scenes.length,
    durationSeconds: duration,
    inefficiencyRatio: Number(inefficiencyRatio.toFixed(3)),
  };
}

function calculateOverallScore(subtitleScore, audioScore, videoScore) {
  return Math.round(
    (Number(subtitleScore || 0) * 0.4)
    + (Number(audioScore || 0) * 0.3)
    + (Number(videoScore || 0) * 0.3)
  );
}

function saveCriticReport(report, outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function runCritic(syncedVideoPath, subtitlePath, analysisOrPath, config) {
  const startedAt = Date.now();
  const analysisData = typeof analysisOrPath === 'string'
    ? JSON.parse(fs.readFileSync(path.resolve(analysisOrPath), 'utf8'))
    : (analysisOrPath || {});

  const tasks = await Promise.allSettled([
    analyzeSubtitles(subtitlePath, config),
    analyzeAudio(syncedVideoPath, config),
    analyzeVideoStructure(analysisData, config),
  ]);

  const subtitleResult = tasks[0].status === 'fulfilled'
    ? tasks[0].value
    : { score: 50, issues: [], entryCount: parseSrt(fs.readFileSync(subtitlePath, 'utf8')).length, llmCostUsd: 0, llmProvider: 'failed', llmModel: null };
  const audioResult = tasks[1].status === 'fulfilled'
    ? tasks[1].value
    : { score: 50, issues: [], audioLufs: null, audioPeak: null };
  const videoResult = tasks[2].status === 'fulfilled'
    ? tasks[2].value
    : {
        score: 50,
        issues: [],
        silencesCount: Array.isArray(analysisData.silences) ? analysisData.silences.length : 0,
        freezesCount: Array.isArray(analysisData.freezes) ? analysisData.freezes.length : 0,
        scenesCount: Array.isArray(analysisData.scenes) ? analysisData.scenes.length : 0,
        durationSeconds: Number(analysisData.duration || 0),
      };

  const overall = calculateOverallScore(subtitleResult.score, audioResult.score, videoResult.score);
  const targetScore = Number(config?.quality_loop?.target_score || 85);
  let report = {
    version: 1,
    timestamp: new Date().toISOString(),
    source_video: path.basename(syncedVideoPath),
    source_subtitle: path.basename(subtitlePath),
    score: overall,
    pass: overall >= targetScore,
    target_score: targetScore,
    issues: [
      ...subtitleResult.issues,
      ...audioResult.issues,
      ...videoResult.issues,
    ],
    scores: {
      subtitle_accuracy: subtitleResult.score,
      audio_quality: audioResult.score,
      video_structure: videoResult.score,
      overall,
    },
    analysis_summary: {
      subtitle_entries: subtitleResult.entryCount || 0,
      subtitle_issues_count: subtitleResult.issues.length,
      audio_lufs: audioResult.audioLufs,
      audio_peak: audioResult.audioPeak,
      silences_count: videoResult.silencesCount || 0,
      freezes_count: videoResult.freezesCount || 0,
      scenes_count: videoResult.scenesCount || 0,
      duration_seconds: videoResult.durationSeconds || Number(analysisData.duration || 0),
    },
    llm_cost_usd: Number((subtitleResult.llmCostUsd || 0).toFixed(6)),
  };

  try {
    report = await enhanceCriticWithRAG(report, config);
  } catch (_error) {
    // RAG 실패 시 원본 critic report 유지
  }

  await logToolCall('critic_agent', 'run_critic', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      sourceVideo: syncedVideoPath,
      subtitlePath,
      overall,
      pass: report.pass,
      issues: report.issues.length,
    },
  });

  return report;
}

module.exports = {
  runCritic,
  analyzeSubtitles,
  analyzeAudio,
  analyzeVideoStructure,
  calculateOverallScore,
  parseSrt,
  saveCriticReport,
};
