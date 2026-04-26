// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { logToolCall } = require('../../../packages/core/lib/tool-logger');
const { callHubLlm } = require('../../../packages/core/lib/hub-client');
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
    runtime_purpose: String(config?.narration_analyzer?.runtime_purpose || 'analysis'),
    llm_timeout_ms: Number(config?.narration_analyzer?.llm_timeout_ms || 15000),
    offline_segment_count_short: Number(config?.narration_analyzer?.offline_segment_count_short || 4),
    offline_segment_count_medium: Number(config?.narration_analyzer?.offline_segment_count_medium || 5),
    offline_segment_count_long: Number(config?.narration_analyzer?.offline_segment_count_long || 6),
    offline_segment_count_xlong: Number(config?.narration_analyzer?.offline_segment_count_xlong || 7),
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

function buildSegment(segmentId, startSec, endSec, text, topic, requiredScreen, keywordsEn = [], keywordsKo = [], actionVerbs = []) {
  return {
    segment_id: segmentId,
    start_s: Number(startSec.toFixed(3)),
    end_s: Number(endSec.toFixed(3)),
    entries: [segmentId],
    text,
    topic,
    required_screen: requiredScreen,
    keywords_en: keywordsEn,
    keywords_ko: keywordsKo,
    action_verbs: actionVerbs,
    llm_analyzed: false,
  };
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

async function buildOfflineNarrationFixture(audioPath, config = {}, options = {}) {
  const durationMs = await probeDurationMs(audioPath);
  const durationSec = Math.max(30, Math.round(durationMs / 1000));
  const resolved = ensureNarrationConfig(config);
  const segmentCount = durationSec >= 720
    ? resolved.offline_segment_count_xlong
    : durationSec >= 480
      ? resolved.offline_segment_count_long
      : durationSec >= 240
        ? resolved.offline_segment_count_medium
        : resolved.offline_segment_count_short;
  const step = durationSec / segmentCount;

  const genericTemplates = [
    {
      text: 'FlutterFlow 에디터와 페이지 구조를 소개하고 파라미터 개념을 설명',
      topic: '에디터 구조와 파라미터 개념 소개',
      required_screen: '에디터 전체 뷰 또는 Widget Tree 화면',
      keywords_en: ['FlutterFlow', 'Page', 'Parameters', 'Widget', 'Tree'],
      keywords_ko: ['파라미터', '위젯', '트리'],
      action_verbs: ['소개', '설명'],
    },
    {
      text: '페이지 파라미터를 생성하고 Route Settings와 Page Parameters를 확인',
      topic: '페이지 파라미터 생성',
      required_screen: 'Page Parameters 또는 Route Settings 화면',
      keywords_en: ['Page', 'Parameters', 'Route', 'Settings', 'Parameter'],
      keywords_ko: ['페이지', '파라미터', '설정'],
      action_verbs: ['생성', '확인'],
    },
    {
      text: '액션 플로우에서 값을 연결하고 Set from Variable을 설정',
      topic: '액션 플로우와 값 연결',
      required_screen: 'Action Flow Editor 또는 Set from Variable 화면',
      keywords_en: ['Action', 'Flow', 'Set', 'Variable', 'Value'],
      keywords_ko: ['액션', '값', '변수'],
      action_verbs: ['설정', '연결'],
    },
    {
      text: '페이지 이동과 Navigate action을 설정하며 전달 값을 점검',
      topic: '페이지 이동과 전달 값 설정',
      required_screen: 'Navigate action 또는 대상 페이지 선택 화면',
      keywords_en: ['Navigate', 'Page', 'Action', 'DetailPage', 'Value'],
      keywords_ko: ['이동', '페이지', '전달'],
      action_verbs: ['이동', '전달'],
    },
    {
      text: '마지막으로 테스트와 검증 흐름을 확인하고 전체 동작을 정리',
      topic: '테스트와 동작 정리',
      required_screen: '미리보기 또는 최종 확인 화면',
      keywords_en: ['Test', 'Preview', 'Run', 'Action', 'Page'],
      keywords_ko: ['테스트', '검증'],
      action_verbs: ['확인', '정리'],
    },
  ];

  const authTemplates = [
    {
      text: 'FlutterFlow 프로젝트 구조와 로그인 흐름을 소개하고 인증 준비 상태를 점검',
      topic: '로그인 흐름과 인증 준비 소개',
      required_screen: '앱 시작 화면 또는 로그인 플로우 개요 화면',
      keywords_en: ['EmailAuthApp', 'LoginPage', 'Page', 'Parameters', 'FlutterFlow'],
      keywords_ko: ['로그인', '인증', '플로우'],
      action_verbs: ['소개', '점검'],
    },
    {
      text: 'Firebase Authentication 또는 Supabase 설정 화면에서 인증 공급자를 활성화한다',
      topic: '인증 공급자 설정',
      required_screen: 'Authentication Settings 또는 Provider 설정 화면',
      keywords_en: ['FlutterFire', 'AuthenticatedUser', 'Settings', 'EmailAuthApp', 'Page'],
      keywords_ko: ['인증', '공급자', '설정'],
      action_verbs: ['활성화', '설정'],
    },
    {
      text: '이메일 로그인 폼과 입력 필드를 연결하고 validation 동작을 확인한다',
      topic: '로그인 폼과 validation 연결',
      required_screen: 'Login Form 또는 TextField 설정 화면',
      keywords_en: ['LoginPage', 'TextField', 'Button', 'Condition', 'Variable'],
      keywords_ko: ['이메일', '비밀번호', '폼'],
      action_verbs: ['연결', '확인'],
    },
    {
      text: '로그인 버튼 액션에 sign in 동작을 연결하고 성공 후 이동 페이지를 설정한다',
      topic: '로그인 액션 연결',
      required_screen: 'Action Flow Editor 또는 Sign In action 화면',
      keywords_en: ['Set', 'Variable', 'Action', 'LoginPage', 'Conditions'],
      keywords_ko: ['로그인', '액션', '이동'],
      action_verbs: ['연결', '이동'],
    },
    {
      text: '세션 유지와 로그인 성공 후 분기 처리를 확인하고 오류 메시지를 점검한다',
      topic: '세션 유지와 오류 처리',
      required_screen: 'Conditional Action 또는 App State 화면',
      keywords_en: ['AuthenticatedUser', 'Conditional', 'verifyEmail', 'Widget', 'State'],
      keywords_ko: ['세션', '오류', '상태'],
      action_verbs: ['유지', '점검'],
    },
    {
      text: '최종적으로 로그인 테스트를 실행하고 인증 흐름 전체를 검증한다',
      topic: '인증 테스트와 검증',
      required_screen: 'Preview 또는 Test Mode 화면',
      keywords_en: ['verifyEmail', 'ForgotPassword', 'LoginPage', 'FlutterFire', 'Test'],
      keywords_ko: ['테스트', '검증'],
      action_verbs: ['실행', '검증'],
    },
    {
      text: '마지막으로 로그아웃과 재로그인 시나리오까지 확인하며 운영 흐름을 정리한다',
      topic: '로그아웃과 재로그인 정리',
      required_screen: 'Profile 또는 Logout action 화면',
      keywords_en: ['SettingPage', 'SignupPage', 'ForgotPassword', 'LoginPage', 'Page'],
      keywords_ko: ['로그아웃', '재로그인'],
      action_verbs: ['확인', '정리'],
    },
  ];

  const dbTemplates = [
    {
      text: '프로젝트와 데이터 구조를 소개하고 데이터베이스 생성 목표를 설명한다',
      topic: '데이터베이스 생성 개요',
      required_screen: '프로젝트 개요 또는 Database 탭 화면',
      keywords_en: ['Database', 'Project', 'Schema', 'Collection', 'Table'],
      keywords_ko: ['데이터베이스', '스키마'],
      action_verbs: ['소개', '설명'],
    },
    {
      text: '새 컬렉션 또는 테이블을 생성하고 기본 필드를 추가한다',
      topic: '테이블과 필드 생성',
      required_screen: 'Create Table 또는 Add Field 화면',
      keywords_en: ['Create', 'Table', 'Collection', 'Field', 'Column'],
      keywords_ko: ['테이블', '필드'],
      action_verbs: ['생성', '추가'],
    },
    {
      text: '문자열과 숫자 타입을 설정하고 기본값과 제약 조건을 확인한다',
      topic: '필드 타입과 제약 조건 설정',
      required_screen: 'Field Settings 또는 Schema Editor 화면',
      keywords_en: ['Type', 'Text', 'Number', 'Default', 'Constraint'],
      keywords_ko: ['타입', '기본값', '제약'],
      action_verbs: ['설정', '확인'],
    },
    {
      text: '레코드 조회용 쿼리와 리스트 바인딩을 연결해 실제 데이터를 표시한다',
      topic: '쿼리와 리스트 바인딩',
      required_screen: 'Query Collection 또는 Backend Query 화면',
      keywords_en: ['Query', 'List', 'Collection', 'Record', 'Backend'],
      keywords_ko: ['쿼리', '리스트', '레코드'],
      action_verbs: ['연결', '표시'],
    },
    {
      text: '생성 액션과 업데이트 액션을 추가하고 입력 폼과 데이터 저장 흐름을 연결한다',
      topic: '생성 업데이트 액션 연결',
      required_screen: 'Create Record 또는 Update Record action 화면',
      keywords_en: ['Create', 'Update', 'Record', 'Action', 'Form'],
      keywords_ko: ['생성', '업데이트', '저장'],
      action_verbs: ['추가', '저장'],
    },
    {
      text: '필터와 정렬을 적용해 데이터 표시 순서를 정리하고 상세 페이지를 연결한다',
      topic: '필터 정렬과 상세 페이지 연결',
      required_screen: 'Filter Settings 또는 Sort Query 화면',
      keywords_en: ['Filter', 'Sort', 'Detail', 'Page', 'Query'],
      keywords_ko: ['필터', '정렬', '상세'],
      action_verbs: ['적용', '연결'],
    },
    {
      text: '최종적으로 테스트 데이터를 넣고 CRUD 흐름 전체를 검증한다',
      topic: 'CRUD 테스트와 검증',
      required_screen: 'Preview 또는 Data Viewer 화면',
      keywords_en: ['Test', 'Preview', 'Create', 'Delete', 'Record'],
      keywords_ko: ['테스트', '검증', '데이터'],
      action_verbs: ['입력', '검증'],
    },
  ];

  const sampleLabel = String(options.sampleLabel || audioPath || '').normalize('NFC');
  const baseName = path.basename(sampleLabel);
  let templates = genericTemplates;
  if (/서버인증/.test(baseName)) {
    templates = authTemplates;
  } else if (/DB|db생성|DB생성/.test(baseName)) {
    templates = dbTemplates;
  }

  const segments = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const template = templates[Math.min(index, templates.length - 1)];
    const startSec = index * step;
    const endSec = index === segmentCount - 1 ? durationSec : (index + 1) * step;
    if (endSec <= startSec) continue;
    segments.push(buildSegment(
      index + 1,
      startSec,
      endSec,
      template.text,
      template.topic,
      template.required_screen,
      template.keywords_en,
      template.keywords_ko,
      template.action_verbs
    ));
  }

  return {
    source_audio: path.basename(audioPath),
    source_audio_path: path.resolve(audioPath),
    duration_s: durationSec,
    total_entries: segments.length,
    total_segments: segments.length,
    segments,
    srt_path: null,
    corrected_srt_path: null,
    output_path: null,
    offline_fixture: true,
  };
}

async function transcribeNarration(audioPath, config, options = {}) {
  const tempDir = options.tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'video-narration-'));
  fs.mkdirSync(tempDir, { recursive: true });
  const rawSrtPath = options.outputSrtPath || path.join(tempDir, 'narration_raw.srt');
  await generateSubtitle(audioPath, rawSrtPath, config);
  return rawSrtPath;
}

async function callNarrationAnalyzer(entries, runtimePurpose, timeoutMs) {
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
  const response = await callHubLlm({
    callerTeam: TEAM_NAME,
    agent: 'narration-analyzer',
    selectorKey: 'video.narration-analyzer',
    taskType: 'narration_segment_analysis',
    abstractModel: 'anthropic_sonnet',
    systemPrompt: [
      '당신은 FlutterFlow 강의용 나레이션 구간 분석기다.',
      '자막 엔트리를 의미 단위 구간으로 묶어 JSON 객체 하나만 반환한다.',
      '형식은 { "segments": [ ... ] } 이어야 한다.',
    ].join('\n'),
    prompt,
    timeoutMs,
  });
  const text = response?.text || '';
  const parsed = JSON.parse(text);
  const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];

  await logToolCall(`llm_${response.provider}`, 'narration_segment_analysis', {
    bot: BOT_NAME,
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: { model: response.model || 'hub-runtime', provider: response.provider, entryCount: entries.length },
  });

  return segments;
}

async function analyzeSegments(entries, config = {}) {
  const resolved = ensureNarrationConfig(config);
  try {
    const segments = await callNarrationAnalyzer(entries, resolved.runtime_purpose, resolved.llm_timeout_ms);
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
  buildOfflineNarrationFixture,
};
