'use strict';

const fs = require('fs');
const path = require('path');

const { getOpenAIKey } = require('../../../packages/core/lib/llm-keys');
const { selectRuntime } = require('../../../packages/core/lib/runtime-selector');
const llmLogger = require('../../../packages/core/lib/llm-logger');
const { logToolCall } = require('../../../packages/core/lib/tool-logger');

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
const WHISPER_MAX_RETRIES = 3;
const WHISPER_TIMEOUT_MS = 5 * 60 * 1000;
const TEAM_NAME = 'video';
const BOT_NAME = 'video';

function ensureWhisperConfig(config) {
  if (!config || !config.whisper) {
    throw new Error('config.whisper 설정이 필요합니다.');
  }
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].join(':') + `,${String(ms).padStart(3, '0')}`;
}

function getDurationFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 0;
  return Number(segments[segments.length - 1].end || 0);
}

function isRetriableStatus(status) {
  return status === 429 || status >= 500;
}

async function transcribe(audioPath, config) {
  ensureWhisperConfig(config);

  if (!fs.existsSync(audioPath)) {
    throw new Error(`오디오 파일을 찾을 수 없습니다: ${audioPath}`);
  }

  const stats = fs.statSync(audioPath);
  if (stats.size > WHISPER_MAX_BYTES) {
    throw new Error(`Whisper API 파일 크기 제한(25MB) 초과: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
  }

  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new Error('OPENAI API 키를 찾을 수 없습니다. llm-keys.js 설정 또는 OPENAI_API_KEY를 확인해 주세요.');
  }

  const runtimeProfile = await selectRuntime(TEAM_NAME, 'stt');
  const model = runtimeProfile?.direct_model || config.whisper.model;
  const language = config.whisper.language;
  const responseFormat = config.whisper.response_format;
  const whisperUrl = runtimeProfile?.direct_endpoint || WHISPER_URL;

  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;

  while (attempt < WHISPER_MAX_RETRIES) {
    attempt += 1;
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

    try {
      const audioBuffer = fs.readFileSync(audioPath);
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: 'audio/mp4' }), path.basename(audioPath));
      form.append('model', model);
      form.append('language', language);
      form.append('response_format', responseFormat);

      const response = await fetch(whisperUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });

      const text = await response.text();
      const durationMs = Date.now() - attemptStartedAt;

      if (!response.ok) {
        let errorMessage = `OpenAI Whisper API 오류 (${response.status})`;
        try {
          const parsed = JSON.parse(text);
          errorMessage = parsed?.error?.message || errorMessage;
        } catch {
          if (text) errorMessage = `${errorMessage}: ${text}`;
        }

        await logToolCall('openai_whisper', 'transcribe', {
          bot: BOT_NAME,
          success: false,
          duration_ms: durationMs,
          error: errorMessage,
          metadata: {
            audioPath,
            model,
            language,
            responseFormat,
            selectorKey: 'video.stt',
            runtimePurpose: 'stt',
            attempt,
            status: response.status,
          },
        });

        if (isRetriableStatus(response.status) && attempt < WHISPER_MAX_RETRIES) {
          lastError = new Error(errorMessage);
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }

        throw new Error(errorMessage);
      }

      const parsed = JSON.parse(text);
      const segments = Array.isArray(parsed.segments)
        ? parsed.segments.map(segment => ({
            start: Number(segment.start || 0),
            end: Number(segment.end || 0),
            text: String(segment.text || '').trim(),
          }))
        : [];
      const duration = Number(parsed.duration || getDurationFromSegments(segments) || 0);

      await logToolCall('openai_whisper', 'transcribe', {
        bot: BOT_NAME,
        success: true,
        duration_ms: durationMs,
        metadata: {
          audioPath,
          model,
          language,
          responseFormat,
          selectorKey: 'video.stt',
          runtimePurpose: 'stt',
          attempt,
          segmentCount: segments.length,
          duration,
        },
      });

      return {
        text: String(parsed.text || '').trim(),
        segments,
        duration,
        duration_ms: Date.now() - startedAt,
      };
    } catch (err) {
      const durationMs = Date.now() - attemptStartedAt;
      const message = err.name === 'AbortError'
        ? 'OpenAI Whisper API 호출 타임아웃(5분)'
        : err.message;

      await logToolCall('openai_whisper', 'transcribe', {
        bot: BOT_NAME,
        success: false,
        duration_ms: durationMs,
        error: message,
        metadata: {
          audioPath,
          model,
          language,
          responseFormat,
          selectorKey: 'video.stt',
          runtimePurpose: 'stt',
          attempt,
        },
      });

      lastError = new Error(message);
      if (attempt >= WHISPER_MAX_RETRIES) {
        throw lastError;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('OpenAI Whisper API 호출 실패');
}

function toSRT(segments) {
  if (!Array.isArray(segments)) {
    throw new Error('segments 배열이 필요합니다.');
  }

  return segments
    .map((segment, index) => {
      const start = formatSrtTime(segment.start);
      const end = formatSrtTime(segment.end);
      const text = String(segment.text || '').trim();
      return `${index + 1}\n${start} --> ${end}\n${text}`;
    })
    .join('\n\n')
    .trim() + '\n';
}

async function generateSubtitle(audioPath, outputSrtPath, config) {
  ensureWhisperConfig(config);

  const startedAt = Date.now();
  const result = await transcribe(audioPath, config);
  const srt = toSRT(result.segments);
  fs.mkdirSync(path.dirname(outputSrtPath), { recursive: true });
  fs.writeFileSync(outputSrtPath, srt, 'utf8');

  const durationMinutes = Number(result.duration || 0) / 60;
  const cost = Number((durationMinutes * 0.006).toFixed(6));

  await llmLogger.logLLMCall({
    team: TEAM_NAME,
    bot: BOT_NAME,
    model: runtimeProfile?.direct_model || config.whisper.model,
    requestType: 'audio_transcription',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: cost,
    latencyMs: result.duration_ms,
    success: true,
  });

  return {
    srtPath: outputSrtPath,
    duration_ms: Date.now() - startedAt,
    cost,
    segmentCount: result.segments.length,
    segments: result.segments,
    text: result.text,
  };
}

module.exports = {
  transcribe,
  toSRT,
  generateSubtitle,
  formatSrtTime,
};
