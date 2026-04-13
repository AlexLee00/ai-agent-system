#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const DRAFT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output/drafts');
const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output');

function parseArgs(argv = []) {
  const args = {
    file: '',
    latest: argv.includes('--latest'),
    type: '',
    json: argv.includes('--json'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--file') args.file = String(argv[i + 1] || '').trim();
    if (token === '--type') args.type = String(argv[i + 1] || '').trim();
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
  for (const dir of dirs) {
    for (const name of safeReadDir(dir)) {
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        if (!/\.html?$/i.test(name)) continue;
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
  return /_lecture_/i.test(path.basename(filePath || '')) ? 'lecture' : 'general';
}

function countHtmlFaq(html = '') {
  return (String(html).match(/(?:<p[^>]*>\s*(?:<strong>)?)\s*(?:Q[0-9]*[.):]|Q\.\s|질문\s*[0-9]*[.):])/gi) || []).length;
}

function countAnsweredFaqPairs(html = '') {
  const normalized = String(html || '')
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

function buildLearningPointsHtml(title, type) {
  const lines = type === 'lecture'
    ? [
        `${title || '이번 강의'}의 핵심 구조를 실무 관점에서 이해합니다.`,
        '구현 전에 먼저 확인해야 할 설계 기준과 운영 포인트를 정리합니다.',
        '예제 코드를 실제 프로젝트에 옮길 때 놓치기 쉬운 체크포인트를 짚습니다.',
      ]
    : [
        `${title || '이번 주제'}를 볼 때 먼저 점검해야 할 기준을 정리합니다.`,
        '실무 의사결정에서 흔들리지 않도록 잡아야 할 핵심 포인트를 확인합니다.',
        '오늘 내용이 실제 업무와 일상 판단에 어떻게 연결되는지 살펴봅니다.',
      ];

  return [
    '<h2 class="section-title">이 글에서 배울 수 있는 것</h2>',
    ...lines.map((line) => `<p>- ${line}</p>`),
  ].join('\n');
}

function buildFaqHtml(title, type) {
  const sectionTitle = type === 'lecture' ? 'AEO FAQ' : '질문형 Q&A';
  const qa = type === 'lecture'
    ? [
        [`Q. ${title || '이번 강의 주제'}를 왜 먼저 이해해야 하나요?`, 'A. 기능 구현보다 시스템 경계와 운영 책임을 먼저 이해해야 실제 장애를 줄일 수 있기 때문입니다.'],
        [`Q. ${title || '이 기술'}를 적용할 때 가장 자주 놓치는 부분은 무엇인가요?`, 'A. 예외 처리, 관측 포인트, 재시도 정책처럼 운영 단계에서 필요한 기준을 뒤늦게 붙이는 경우가 많습니다.'],
        ['Q. 예제 코드를 그대로 복사해도 바로 실무에 쓸 수 있나요?', 'A. 출발점으로는 좋지만 인증, 로깅, 롤백, 모니터링까지 붙어야 운영 가능한 코드가 됩니다.'],
      ]
    : [
        [`Q. ${title || '이번 주제'}를 실제 상황에 적용할 때 가장 먼저 봐야 할 것은 무엇인가요?`, 'A. 지금 당장 해결하려는 문제보다, 그 판단이 이후 일정과 기대치에 어떤 영향을 주는지 먼저 보는 편이 안전합니다.'],
        ['Q. 비슷해 보이는 선택지인데 왜 결과가 크게 달라지나요?', 'A. 기준 없이 빠르게 결정하면 중간 수정 비용이 커지기 때문입니다. 처음에 확인할 질문 몇 개가 전체 흐름을 바꿉니다.'],
        ['Q. 실무에서는 완벽한 답보다 무엇이 더 중요할까요?', 'A. 지금 단계에서 무엇을 확정하고 무엇을 열어둘지 분리하는 판단이 더 중요합니다.'],
      ];

  return [
    `<h2 class="section-title">${sectionTitle}</h2>`,
    ...qa.flatMap(([q, a]) => [`<p>${q}</p>`, `<p>${a}</p>`]),
  ].join('\n');
}

function hasPersonalVoice(html = '') {
  return /제가|저는|느꼈|경험|실제로.*해보니|직접.*해본|제 생각|솔직히/.test(String(html));
}

function hasEmotionLine(html = '') {
  return /놀랐|감동|기뻤|아쉬웠|뿌듯|설레|두근|가슴이|반가웠|인상적/.test(String(html));
}

function buildPersonalVoiceHtml(title, type) {
  const text = type === 'lecture'
    ? [
        `제가 실제 운영 흐름에 ${title || '이번 강의'}를 대입해보면, 처음에는 단순한 개념처럼 보여도 장애와 복구 관점에서 훨씬 중요하게 다가오는 순간이 분명히 있었습니다.`,
        '개인적으로도 이런 기준을 다시 정리하고 나면 구조가 한결 또렷해지는 느낌이라 꽤 인상적이었습니다.',
      ].join(' ')
    : [
        `저도 ${title || '이번 주제'}와 비슷한 고민을 할 때면, 더 많이 하는 방법보다 무엇을 기준으로 버릴지부터 다시 적어보곤 합니다.`,
        '그 과정을 거치고 나면 막연하게 조급했던 마음이 조금 정리되는 점이 늘 인상적으로 남았습니다.',
      ].join(' ');
  return `<p>${text}</p>`;
}

function ensureLearningPoints(html, title, type) {
  if (html.includes('<h2 class="section-title">이 글에서 배울 수 있는 것</h2>')) return html;
  const sectionHtml = buildLearningPointsHtml(title, type);
  const anchor = type === 'lecture'
    ? '<h2 class="section-title">승호아빠 인사말</h2>'
    : '<h2 class="section-title">승호아빠 인사말</h2>';
  if (html.includes(anchor)) {
    return html.replace(anchor, `${sectionHtml}\n<br>\n${anchor}`);
  }
  return html;
}

function ensureFaq(html, title, type) {
  const faqTitle = type === 'lecture' ? 'AEO FAQ' : '질문형 Q&A';
  const hasSection = html.includes(`<h2 class="section-title">${faqTitle}</h2>`);
  const faqCount = countHtmlFaq(html);
  const answeredFaqCount = countAnsweredFaqPairs(html);
  if (hasSection && faqCount >= 3 && answeredFaqCount >= 3) return html;

  const nextSectionPattern = type === 'lecture'
    ? /<h2 class="section-title">AEO FAQ<\/h2>[\s\S]*?(?=<h2 class="section-title">마무리 인사<\/h2>)/i
    : /<h2 class="section-title">질문형 Q&A<\/h2>[\s\S]*?(?=<h2 class="section-title">스터디카페 홍보 섹션<\/h2>|<h2 class="section-title">마무리 제언<\/h2>)/i;

  const faqHtml = buildFaqHtml(title, type);
  if (nextSectionPattern.test(html)) {
    return html.replace(nextSectionPattern, `${faqHtml}\n<br>\n`);
  }

  const anchor = type === 'lecture'
    ? '<h2 class="section-title">마무리 인사</h2>'
    : (html.includes('<h2 class="section-title">스터디카페 홍보 섹션</h2>')
      ? '<h2 class="section-title">스터디카페 홍보 섹션</h2>'
      : '<h2 class="section-title">마무리 제언</h2>');

  if (html.includes(anchor)) {
    return html.replace(anchor, `${faqHtml}\n<br>\n${anchor}`);
  }

  return `${html}\n${faqHtml}`;
}

function ensurePersonalVoice(html, title, type) {
  if (hasPersonalVoice(html) && hasEmotionLine(html)) return html;
  const paragraph = buildPersonalVoiceHtml(title, type);
  const anchor = type === 'lecture'
    ? '<h2 class="section-title">마무리 인사</h2>'
    : '<h2 class="section-title">마무리 제언</h2>';

  if (html.includes(anchor)) {
    return html.replace(anchor, `${paragraph}\n<br>\n${anchor}`);
  }

  return `${html}\n${paragraph}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolveLatestFile(args);
  if (!filePath) throw new Error('보정할 HTML 파일을 찾지 못했습니다.');

  const html = fs.readFileSync(filePath, 'utf8');
  const titleMatch = html.match(/<h1 class="post-title">([^<]+)<\/h1>/i);
  const title = String(titleMatch?.[1] || '').trim();
  const type = inferType(filePath, args.type);

  let next = html;
  next = ensureLearningPoints(next, title, type);
  next = ensureFaq(next, title, type);
  next = ensurePersonalVoice(next, title, type);

  if (next !== html) fs.writeFileSync(filePath, next, 'utf8');

  const payload = {
    file: filePath,
    type,
    updated: next !== html,
    faqCount: countHtmlFaq(next),
    answeredFaqCount: countAnsweredFaqPairs(next),
    hasLearningPoints: next.includes('<h2 class="section-title">이 글에서 배울 수 있는 것</h2>'),
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[repair-briefing] file=${payload.file}`);
  console.log(`[repair-briefing] type=${payload.type} updated=${payload.updated}`);
  console.log(`[repair-briefing] learning=${payload.hasLearningPoints} faqCount=${payload.faqCount} answeredFaq=${payload.answeredFaqCount}`);
}

main();
