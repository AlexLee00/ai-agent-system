// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');

const BOT_NAME = 'subtitle-corrector';
const TEAM_NAME = 'video';
const subtitleMemory = createAgentMemory({ agentId: 'video.subtitle', team: 'video' });
const CHUNK_SIZE = 50;
const SYSTEM_PROMPT = `당신은 FlutterFlow, Firebase, Supabase, Dart, Widget, API, JSON,
Authentication, Database, Query, Column, Row, Navigation, Action,
Parameter, Component, State, Variable 등 IT 전문용어에 정통한
한국어 자막 교정 전문가입니다.

규칙:
1. 오탈자, 띄어쓰기, 기술 용어 오류를 수정합니다.
2. 타임스탬프(00:01:23,456 --> 00:01:25,789 형식)는 절대 수정하지 않습니다.
3. SRT 번호(1, 2, 3...)는 절대 수정하지 않습니다.
4. 교정된 SRT 형식 그대로 출력합니다.
5. 자막 내용만 교정하고, 구조를 변경하지 않습니다.
6. 음성 인식 오류로 보이는 부분을 문맥에 맞게 수정합니다.`;

function ensureSubtitleConfig(config) {
  if (!config || !config.subtitle_correction) {
    throw new Error('config.subtitle_correction 설정이 필요합니다.');
  }
}

function splitSrtEntries(srtText) {
  return String(srtText || '')
    .trim()
    .split(/\n\s*\n/g)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function chunkEntries(entries, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    chunks.push(entries.slice(i, i + chunkSize));
  }
  return chunks;
}

function extractTimestampLines(srtText) {
  return String(srtText || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/.test(line));
}

function parseSrtEntry(entryText) {
  const lines = String(entryText || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 3) return null;
  const indexLine = lines[0].trim();
  const timestampLine = lines[1].trim();
  if (!/^\d+$/.test(indexLine)) return null;
  if (!/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/.test(timestampLine)) return null;
  return {
    indexLine,
    timestampLine,
    textLines: lines.slice(2),
  };
}

function rebuildChunkWithOriginalStructure(originalChunk, correctedChunk) {
  const originalEntries = splitSrtEntries(originalChunk);
  const correctedEntries = splitSrtEntries(correctedChunk);

  if (originalEntries.length !== correctedEntries.length) {
    return null;
  }

  const rebuilt = [];
  for (let i = 0; i < originalEntries.length; i += 1) {
    const original = parseSrtEntry(originalEntries[i]);
    const corrected = parseSrtEntry(correctedEntries[i]);
    if (!original || !corrected) {
      return null;
    }
    rebuilt.push([
      original.indexLine,
      original.timestampLine,
      ...corrected.textLines,
    ].join('\n').trimEnd());
  }

  return rebuilt.join('\n\n');
}

async function callSharedCorrection(chunkText) {
  const response = await callWithFallback({
    chain: selectLLMChain('video.subtitle-correction'),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: chunkText,
    logMeta: {
      team: TEAM_NAME,
      purpose: 'editing',
      bot: BOT_NAME,
      agentName: 'subtitle-corrector',
      selectorKey: 'video.subtitle-correction',
      requestType: 'subtitle_correction',
    },
  });

  const text = String(response?.text || '').trim();
  if (!text) {
    throw new Error('공용 LLM 응답 본문이 비어 있습니다.');
  }

  return {
    text,
    provider: response.provider,
    model: response.model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

async function withRetries(fn, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

async function runChunkCorrection(chunkText, config, chunkIndex) {
  const settings = config.subtitle_correction;
  const startedAt = Date.now();

  try {
    const result = await withRetries(() => callSharedCorrection(chunkText), settings.max_retries);
    const durationMs = Date.now() - startedAt;

    await logToolCall(`llm_${result.provider}`, 'subtitle_correction', {
      bot: BOT_NAME,
      success: true,
      duration_ms: durationMs,
      metadata: {
        chunkIndex,
        model: result.model,
        provider: result.provider,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        selectorKey: 'video.subtitle-correction',
      },
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await logToolCall('llm_fallback', 'subtitle_correction', {
      bot: BOT_NAME,
      success: false,
      duration_ms: durationMs,
      error: error.message,
      metadata: {
        chunkIndex,
        selectorKey: 'video.subtitle-correction',
      },
    });
    throw error;
  }
}

function normalizeSrtOutput(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

async function correctSubtitle(srtText, config) {
  ensureSubtitleConfig(config);

  const entries = splitSrtEntries(srtText);
  const chunks = chunkEntries(entries, CHUNK_SIZE);
  const correctedChunks = [];
  let totalTokens = 0;
  let totalCost = 0;
  const providers = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkEntriesText = chunks[index].join('\n\n');
    const originalTimestamps = extractTimestampLines(chunkEntriesText);

    try {
      const result = await runChunkCorrection(chunkEntriesText, config, index);
      const correctedChunkRaw = normalizeSrtOutput(result.text);
      const rebuiltChunk = rebuildChunkWithOriginalStructure(chunkEntriesText, correctedChunkRaw);
      if (!rebuiltChunk) {
        await logToolCall('subtitle_corrector', 'structure_mismatch', {
          bot: BOT_NAME,
          success: false,
          metadata: {
            chunkIndex: index,
            originalEntryCount: splitSrtEntries(chunkEntriesText).length,
            correctedEntryCount: splitSrtEntries(correctedChunkRaw).length,
          },
        });
        correctedChunks.push(chunkEntriesText);
        totalTokens += result.inputTokens + result.outputTokens;
        totalCost += result.costUsd;
        providers.push(`${result.provider}:fallback_original`);
        continue;
      }

      const correctedChunk = normalizeSrtOutput(rebuiltChunk);
      const correctedTimestamps = extractTimestampLines(correctedChunk);
      const sameTimestamps =
        correctedTimestamps.length === originalTimestamps.length &&
        correctedTimestamps.every((line, lineIndex) => line === originalTimestamps[lineIndex]);

      if (!sameTimestamps) {
        await logToolCall('subtitle_corrector', 'timestamp_mismatch', {
          bot: BOT_NAME,
          success: false,
          metadata: {
            chunkIndex: index,
            originalTimestampCount: originalTimestamps.length,
            correctedTimestampCount: correctedTimestamps.length,
          },
        });
        correctedChunks.push(chunkEntriesText);
        totalTokens += result.inputTokens + result.outputTokens;
        totalCost += result.costUsd;
        providers.push(`${result.provider}:fallback_original`);
        continue;
      }

      correctedChunks.push(correctedChunk);
      totalTokens += result.inputTokens + result.outputTokens;
      totalCost += result.costUsd;
      providers.push(result.provider);
    } catch (error) {
      await logToolCall('subtitle_corrector', 'chunk_fallback_original', {
        bot: BOT_NAME,
        success: false,
        error: error.message,
        metadata: { chunkIndex: index },
      });
      correctedChunks.push(chunkEntriesText);
    }
  }

  return {
    correctedSrt: correctedChunks.join('\n\n').trim() + '\n',
    stats: {
      chunks: chunks.length,
      totalTokens,
      cost: Number(totalCost.toFixed(6)),
      provider: providers.length === 0 ? 'fallback_original' : [...new Set(providers)].join(','),
    },
  };
}

async function correctFile(inputSrtPath, outputSrtPath, config) {
  ensureSubtitleConfig(config);

  const originalSrt = fs.readFileSync(inputSrtPath, 'utf8');

  try {
    const result = await correctSubtitle(originalSrt, config);
    fs.mkdirSync(path.dirname(outputSrtPath), { recursive: true });
    fs.writeFileSync(outputSrtPath, result.correctedSrt, 'utf8');
    try {
      await subtitleMemory.remember(
        [
          `자막 교정 성공: ${path.basename(inputSrtPath)}`,
          `chunks=${result.stats?.chunks || 0}`,
          `provider=${result.stats?.provider || 'unknown'}`,
          `fallback=${result.stats?.provider === 'fallback_original' ? 'yes' : 'no'}`,
        ].join(' | '),
        'episodic',
        {
          keywords: ['video', 'subtitle', 'completed', path.basename(inputSrtPath)].filter(Boolean).slice(0, 8),
          importance: result.stats?.provider === 'fallback_original' ? 0.58 : 0.66,
          expiresIn: 30 * 24 * 60 * 60,
          metadata: {
            type: 'video_subtitle_correction',
            outcome: 'completed',
            file: path.basename(inputSrtPath),
            chunks: result.stats?.chunks || 0,
            provider: result.stats?.provider || null,
            fallbackUsed: result.stats?.provider === 'fallback_original',
          },
        },
      );
      await subtitleMemory.consolidate({
        olderThanDays: 14,
        limit: 8,
        sourceType: 'episodic',
        targetType: 'semantic',
      });
    } catch (memoryError) {
      await logToolCall('subtitle_corrector', 'agent_memory_write_failed', {
        bot: BOT_NAME,
        success: false,
        error: memoryError.message,
        metadata: { file: path.basename(inputSrtPath) },
      });
    }
    return {
      outputPath: outputSrtPath,
      stats: result.stats,
      fallbackUsed: result.stats.provider === 'fallback_original',
    };
  } catch (error) {
    fs.mkdirSync(path.dirname(outputSrtPath), { recursive: true });
    fs.writeFileSync(outputSrtPath, originalSrt, 'utf8');
    const episodicHint = await subtitleMemory.recall(
      [path.basename(inputSrtPath), 'subtitle correction failure'].filter(Boolean).join(' '),
      {
        type: 'episodic',
        limit: 2,
        threshold: 0.35,
      },
    ).then((rows) => {
      if (!rows || rows.length === 0) return '';
      const lines = rows.slice(0, 2).map((row) => {
        const createdAt = row?.created_at ? String(row.created_at).slice(0, 10) : 'unknown';
        const similarity = Number(row?.similarity || 0);
        const headline = String(row?.content || '').split(' | ')[0] || '기록 없음';
        return `${createdAt} / 유사도 ${similarity.toFixed(2)} / ${headline}`;
      });
      return `\n최근 유사 실패:\n- ${lines.join('\n- ')}`;
    }).catch(() => '');
    const semanticHint = await subtitleMemory.recall(
      [path.basename(inputSrtPath), 'consolidated subtitle correction pattern'].filter(Boolean).join(' '),
      {
        type: 'semantic',
        limit: 2,
        threshold: 0.28,
      },
    ).then((rows) => {
      if (!rows || rows.length === 0) return '';
      const lines = rows.slice(0, 2).map((row) => {
        const createdAt = row?.created_at ? String(row.created_at).slice(0, 10) : 'unknown';
        const similarity = Number(row?.similarity || 0);
        const headline = String(row?.content || '').split('\n')[0] || '패턴 요약 없음';
        return `${createdAt} / 유사도 ${similarity.toFixed(2)} / ${headline}`;
      });
      return `\n최근 통합 패턴:\n- ${lines.join('\n- ')}`;
    }).catch(() => '');
    await publishToWebhook({
      event: {
        from_bot: 'subtitle-corrector',
        team: TEAM_NAME,
        event_type: 'video_subtitle_correction_failed',
        alert_level: 4,
        message: [
          '🚨 비디오 자막 교정 실패',
          `파일: ${path.basename(inputSrtPath)}`,
          `사유: ${error.message}`,
          '조치: 원본 SRT로 폴백되어 파이프라인은 계속 진행됩니다.',
        ].join('\n') + episodicHint + semanticHint,
      },
    });
    try {
      await subtitleMemory.remember(
        [
          `자막 교정 실패: ${path.basename(inputSrtPath)}`,
          `reason=${error.message}`,
        ].join(' | '),
        'episodic',
        {
          keywords: ['video', 'subtitle', 'failed', path.basename(inputSrtPath)].filter(Boolean).slice(0, 8),
          importance: 0.82,
          expiresIn: 30 * 24 * 60 * 60,
          metadata: {
            type: 'video_subtitle_correction',
            outcome: 'failed',
            file: path.basename(inputSrtPath),
            errorMessage: error.message,
          },
        },
      );
      await subtitleMemory.consolidate({
        olderThanDays: 14,
        limit: 8,
        sourceType: 'episodic',
        targetType: 'semantic',
      });
    } catch (memoryError) {
      await logToolCall('subtitle_corrector', 'agent_memory_write_failed', {
        bot: BOT_NAME,
        success: false,
        error: memoryError.message,
        metadata: { file: path.basename(inputSrtPath), stage: 'failure' },
      });
    }
    return {
      outputPath: outputSrtPath,
      stats: {
        chunks: 0,
        totalTokens: 0,
        cost: 0,
        provider: 'fallback_original',
      },
      fallbackUsed: true,
    };
  }
}

module.exports = {
  correctSubtitle,
  correctFile,
  splitSrtEntries,
  extractTimestampLines,
};
