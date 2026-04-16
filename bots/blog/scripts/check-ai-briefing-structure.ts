#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  checkQualityEnhanced,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/quality-checker.ts'));

const DRAFT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output/drafts');
const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output');

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    type: '',
    file: '',
    latest: argv.includes('--latest'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--type') args.type = String(argv[i + 1] || '').trim();
    if (token === '--file') args.file = String(argv[i + 1] || '').trim();
  }

  return args;
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function resolveLatestFile(args) {
  if (args.file) return path.resolve(args.file);

  const dirs = [DRAFT_DIR, OUTPUT_DIR];
  const candidates = [];
  const typeFilter = args.type === 'lecture' || args.type === 'general' ? `_${args.type}_` : '';

  for (const dir of dirs) {
    for (const name of safeReadDir(dir)) {
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        if (!/\.(md|html)$/i.test(name)) continue;
        if (typeFilter && !name.includes(typeFilter)) continue;
        candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.fullPath || '';
}

function inferType(filePath, explicitType) {
  if (explicitType === 'lecture' || explicitType === 'general') return explicitType;
  const base = path.basename(filePath || '');
  if (/_lecture_/i.test(base)) return 'lecture';
  return 'general';
}

function stripHtml(content) {
  return String(content || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlSectionTitles(content) {
  return Array.from(String(content || '').matchAll(/<h2[^>]*class="section-title"[^>]*>([^<]+)<\/h2>/gi))
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
}

function loadContent(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return {
    raw,
    text: /\.html?$/i.test(filePath) ? stripHtml(raw) : raw,
  };
}

function countQuestionStyleFaq(content, raw = '') {
  const textMatches = String(content || '').match(/(?:^|\n)\s*(?:\*\*)?Q[0-9]*[.):]|(?:^|\n)\s*Q\.\s|(?:^|\n)\s*질문\s*[0-9]*[.):]/gm);
  const rawMatches = String(raw || '').match(/(?:<p[^>]*>\s*(?:<strong>)?)\s*(?:Q[0-9]*[.):]|Q\.\s|질문\s*[0-9]*[.):])/gi);
  return Math.max(textMatches ? textMatches.length : 0, rawMatches ? rawMatches.length : 0);
}

function countAnsweredFaqPairs(content, raw = '') {
  const normalized = String(raw || content || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let answered = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^(?:Q[0-9]*[.):]|Q\.\s|질문\s*[0-9]*[.):])/.test(line)) continue;
    const answerLine = lines.slice(i + 1, i + 4).find((nextLine) => /^(?:A[0-9]*[.):]|A\.\s|답변\s*[0-9]*[.):])/.test(nextLine) || nextLine.length >= 24);
    if (answerLine) answered += 1;
  }
  return answered;
}

function buildBriefingSignals(content, type, raw = '') {
  const text = String(content || '');
  const sectionTitles = extractHtmlSectionTitles(raw);
  const hasSection = (label) => text.includes(label) || sectionTitles.includes(label);
  return {
    hasSummary: type === 'lecture'
      ? /핵심 요약 3줄|핵심 요약/.test(text) || hasSection('핵심 요약 3줄')
      : /AI 스니펫 요약|핵심 요약 3줄/.test(text) || hasSection('AI 스니펫 요약'),
    hasLearningPoints: /이 글에서 배울 수 있는 것/.test(text) || hasSection('이 글에서 배울 수 있는 것'),
    hasQuestionFaq: /질문형 Q&A|AEO FAQ|FAQ/.test(text) || hasSection('AEO FAQ') || hasSection('질문형 Q&A'),
    questionFaqCount: countQuestionStyleFaq(text, raw) + (hasSection('AEO FAQ') || hasSection('질문형 Q&A') ? 1 : 0),
    answeredFaqCount: countAnsweredFaqPairs(text, raw),
    hasConclusionLine: /핵심 메시지|결론 한줄|결론 한 줄/.test(text) || hasSection('마무리 제언') || hasSection('마무리 인사'),
    sectionTitles,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolveLatestFile(args);

  if (!filePath) {
    throw new Error('점검할 파일을 찾지 못했습니다. --file 경로를 지정하세요.');
  }

  const type = inferType(filePath, args.type);
  const loaded = loadContent(filePath);
  const content = loaded.text;
  const briefing = buildBriefingSignals(content, type, loaded.raw);
  const quality = await checkQualityEnhanced(loaded.raw, type, {});

  const briefingIssues = [];
  if (!briefing.hasSummary) briefingIssues.push('summary_missing');
  if (!briefing.hasLearningPoints) briefingIssues.push('learning_points_missing');
  if (!briefing.hasQuestionFaq) briefingIssues.push('question_faq_missing');
  if (briefing.questionFaqCount < 3) briefingIssues.push(`question_faq_insufficient:${briefing.questionFaqCount}`);
  if (briefing.answeredFaqCount < 3) briefingIssues.push(`question_answer_coverage_insufficient:${briefing.answeredFaqCount}`);
  if (!briefing.hasConclusionLine) briefingIssues.push('conclusion_missing');

  const payload = {
    file: filePath,
    type,
    charCount: content.length,
    briefing,
    briefingPassed: briefingIssues.length === 0,
    briefingIssues,
    quality: {
      passed: quality.passed,
      hashtagCount: quality.hashtagCount,
      aiRisk: quality.aiRisk,
      issueCount: Array.isArray(quality.issues) ? quality.issues.length : 0,
      issues: (quality.issues || []).map((issue) => ({
        severity: issue.severity,
        msg: issue.msg,
      })),
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    if (args.strict && (!payload.briefingPassed || !payload.quality.passed)) process.exit(2);
    return;
  }

  console.log(`[briefing-check] file=${payload.file}`);
  console.log(`[briefing-check] type=${payload.type} chars=${payload.charCount}`);
  console.log(`[briefing-check] summary=${payload.briefing.hasSummary} learning=${payload.briefing.hasLearningPoints} faq=${payload.briefing.hasQuestionFaq} faqCount=${payload.briefing.questionFaqCount} answeredFaq=${payload.briefing.answeredFaqCount} conclusion=${payload.briefing.hasConclusionLine}`);
  console.log(`[briefing-check] briefing passed=${payload.briefingPassed} issues=${payload.briefingIssues.join(',') || 'none'}`);
  console.log(`[briefing-check] quality passed=${payload.quality.passed} hashtags=${payload.quality.hashtagCount} aiRisk=${payload.quality.aiRisk?.riskScore}/${payload.quality.aiRisk?.riskLevel}`);
  for (const issue of payload.quality.issues.slice(0, 8)) {
    console.log(`[briefing-check] ${issue.severity}: ${issue.msg}`);
  }
  if (args.strict && (!payload.briefingPassed || !payload.quality.passed)) process.exit(2);
}

main().catch((error) => {
  console.error('[briefing-check] 실패:', error?.message || error);
  process.exit(1);
});
