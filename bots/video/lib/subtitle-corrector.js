'use strict';

const fs = require('fs');
const path = require('path');

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { getOpenAIKey, getGeminiKey } = require('../../../packages/core/lib/llm-keys');
const { logLLMCall } = require('../../../packages/core/lib/llm-logger');
const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

const BOT_NAME = 'subtitle-corrector';
const TEAM_NAME = 'video';
const CHUNK_SIZE = 50;
const OPENAI_PRICING = {
  input: 0.15,
  output: 0.60,
};

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

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function calcOpenAICost(inputTokens, outputTokens) {
  return Number((((inputTokens * OPENAI_PRICING.input) + (outputTokens * OPENAI_PRICING.output)) / 1_000_000).toFixed(6));
}

async function callOpenAICorrection(chunkText, settings) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new Error('OpenAI API 키가 없습니다.');
  }

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: settings.model,
    temperature: settings.temperature,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: chunkText },
    ],
  });

  const text = response?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('OpenAI 응답 본문이 비어 있습니다.');
  }

  const inputTokens = response?.usage?.prompt_tokens || 0;
  const outputTokens = response?.usage?.completion_tokens || 0;
  return {
    text,
    provider: 'openai',
    model: settings.model,
    inputTokens,
    outputTokens,
    costUsd: calcOpenAICost(inputTokens, outputTokens),
  };
}

async function callGeminiCorrection(chunkText, settings) {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error('Gemini API 키가 없습니다.');
  }

  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({
    model: settings.model,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: settings.temperature,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const response = await model.generateContent(chunkText);
  const text = response?.response?.text?.()?.trim();
  if (!text) {
    throw new Error('Gemini 응답 본문이 비어 있습니다.');
  }

  const usage = response?.response?.usageMetadata || {};
  const inputTokens = usage.promptTokenCount || estimateTokens(chunkText);
  const outputTokens = usage.candidatesTokenCount || estimateTokens(text);
  return {
    text,
    provider: 'gemini',
    model: settings.model,
    inputTokens,
    outputTokens,
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
  const primary = {
    provider: settings.llm_provider,
    model: settings.llm_model,
    temperature: settings.temperature,
  };
  const fallback = {
    provider: settings.fallback_provider === 'google' ? 'gemini' : settings.fallback_provider,
    model: settings.fallback_model,
    temperature: settings.temperature,
  };

  const chain = [primary, fallback];
  let lastError = null;

  for (const candidate of chain) {
    const action = candidate.provider === 'openai' ? callOpenAICorrection : callGeminiCorrection;
    const startedAt = Date.now();

    try {
      const result = await withRetries(() => action(chunkText, candidate), settings.max_retries);
      const durationMs = Date.now() - startedAt;

      await logLLMCall({
        team: TEAM_NAME,
        bot: BOT_NAME,
        model: result.model,
        requestType: 'subtitle_correction',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        latencyMs: durationMs,
        success: true,
      });

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
        },
      });

      return result;
    } catch (error) {
      lastError = error;
      const durationMs = Date.now() - startedAt;
      await logLLMCall({
        team: TEAM_NAME,
        bot: BOT_NAME,
        model: candidate.model,
        requestType: 'subtitle_correction',
        latencyMs: durationMs,
        success: false,
        errorMsg: error.message,
      });
      await logToolCall(`llm_${candidate.provider}`, 'subtitle_correction', {
        bot: BOT_NAME,
        success: false,
        duration_ms: durationMs,
        error: error.message,
        metadata: {
          chunkIndex,
          model: candidate.model,
          provider: candidate.provider,
        },
      });
    }
  }

  throw lastError || new Error('자막 교정 LLM 체인이 모두 실패했습니다.');
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
    return {
      outputPath: outputSrtPath,
      stats: result.stats,
      fallbackUsed: result.stats.provider === 'fallback_original',
    };
  } catch (error) {
    fs.mkdirSync(path.dirname(outputSrtPath), { recursive: true });
    fs.writeFileSync(outputSrtPath, originalSrt, 'utf8');
    await postAlarm({
      message: [
        '🚨 비디오 자막 교정 실패',
        `파일: ${path.basename(inputSrtPath)}`,
        `사유: ${error.message}`,
        '조치: 원본 SRT로 폴백되어 파이프라인은 계속 진행됩니다.',
      ].join('\n'),
      team: 'general',
      alertLevel: 4,
      fromBot: 'subtitle-corrector',
    });
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
