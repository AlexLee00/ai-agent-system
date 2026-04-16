'use strict';

/**
 * quality-checker.js — 포스팅 품질 검증 + AI 탐지 리스크 분석
 */

const https = require('https');
const builtinModules = new Set(require('module').builtinModules || []);
const { detectTitlePattern } = require('./performance-diagnostician.ts');

const MIN_CHARS = { lecture: 8000, general: 6000 };
const GOAL_CHARS = { lecture: 9000, general: 8000 };
const AI_RISK_REWRITE_THRESHOLD = 70;

const REQUIRED_SECTION_MARKERS = {
  lecture: ['핵심 요약', '이 글에서 배울 수 있는 것', '승호아빠 인사말', '최신 기술 브리핑', '강의 - 이론', '실무 - 코드', 'AEO FAQ', '함께 읽으면 좋은 글', '해시태그'],
  general: ['AI 스니펫 요약', '승호아빠 인사말', '본론 섹션 1', '본론 섹션 2', '본론 섹션 3', '마무리 제언', '해시태그'],
};

const MARKER_ALIASES = {
  lecture: {
    '[함께 읽으면 좋은 글]': ['[마무리 인사 + 함께 읽으면 좋은 글]'],
    '[해시태그]': ['[마무리 인사 + 해시태그]'],
    '함께 읽으면 좋은 글': ['마무리 인사 + 함께 읽으면 좋은 글'],
    '해시태그': ['마무리 인사 + 해시태그'],
    '[마무리 인사]': ['[마무리 인사 + 함께 읽으면 좋은 글]'],
    '마무리 인사': ['마무리 인사 + 함께 읽으면 좋은 글'],
  },
};

function hasSectionMarker(content, type, marker) {
  const text = String(content || '');
  if (text.includes(marker)) return true;
  const normalizedMarker = String(marker || '').replace(/^\[|\]$/g, '').trim();
  if (normalizedMarker) {
    const headingPattern = new RegExp(`<h2[^>]*class="section-title"[^>]*>\\s*${normalizedMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/h2>`, 'i');
    if (headingPattern.test(text)) return true;
  }
  const aliases = MARKER_ALIASES[type]?.[marker] || [];
  return aliases.some((alias) => {
    if (text.includes(alias)) return true;
    const normalizedAlias = String(alias || '').replace(/^\[|\]$/g, '').trim();
    if (!normalizedAlias) return false;
    const headingPattern = new RegExp(`<h2[^>]*class="section-title"[^>]*>\\s*${normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/h2>`, 'i');
    return headingPattern.test(text);
  });
}

function checkTruncatedEnding(content, type) {
  const issues = [];
  const text = String(content || '');
  const trimmed = text.trimEnd();
  const tail = trimmed.slice(-1500);
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';

  const boldCount = (tail.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    issues.push({ severity: 'error', msg: '본문 끝부분 강조 마커(**)가 닫히지 않음 — 출력 잘림 의심' });
  }

  const inlineCodeCount = (tail.match(/`/g) || []).length;
  if (inlineCodeCount % 2 !== 0) {
    issues.push({ severity: 'error', msg: '본문 끝부분 인라인 코드 마커(`)가 닫히지 않음 — 출력 잘림 의심' });
  }

  if (/^\*\*Q\d+\./.test(lastLine) || (/\?\*?$/.test(lastLine) && /^\*\*/.test(lastLine))) {
    issues.push({ severity: 'error', msg: 'FAQ 항목이 질문 줄에서 끝남 — 답변 누락 또는 출력 잘림 의심' });
  }

  if (type === 'lecture') {
    if (!hasSectionMarker(text, 'lecture', '[마무리 인사]') && !hasSectionMarker(text, 'lecture', '[함께 읽으면 좋은 글]')) {
      issues.push({ severity: 'error', msg: '강의 포스팅 마무리 인사 섹션 누락' });
    }
    if (!hasSectionMarker(text, 'lecture', '[함께 읽으면 좋은 글]')) {
      issues.push({ severity: 'error', msg: '강의 포스팅 관련 글 섹션 누락' });
    }
    if (!hasSectionMarker(text, 'lecture', '[해시태그]')) {
      issues.push({ severity: 'error', msg: '강의 포스팅 해시태그 섹션 누락' });
    }
  }

  return issues;
}

function countQuestionStyleFaq(content) {
  const text = String(content || '');
  const matches = text.match(/(?:^|\n)\s*(?:\*\*)?Q[0-9]*[.):]|(?:^|\n)\s*Q\.\s|(?:^|\n)\s*질문\s*[0-9]*[.):]|(?:^|\n)\s*Q\.\s*[^ \n]/g);
  const baseCount = matches ? matches.length : 0;
  const htmlCount = (text.match(/(?:<p[^>]*>\s*(?:<strong>)?)\s*(?:Q[0-9]*[.):]|Q\.\s|질문\s*[0-9]*[.):])/gi) || []).length;
  const faqSections = Array.from(text.matchAll(/<h2[^>]*class="section-title"[^>]*>(AEO FAQ|질문형 Q&A)<\/h2>/gi)).length;
  return Math.max(baseCount, htmlCount, faqSections);
}

function countAnsweredFaqPairs(content) {
  const text = String(content || '');
  const normalized = text
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

function extractFirstContentLine(content) {
  return String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) || '';
}

function normalizeTitleWords(text = '') {
  return String(text || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

function calculateTitleOverlap(a = '', b = '') {
  const first = new Set(normalizeTitleWords(a));
  const second = new Set(normalizeTitleWords(b));
  if (!first.size || !second.size) return 0;
  let matched = 0;
  for (const token of first) {
    if (second.has(token)) matched += 1;
  }
  return matched / Math.max(first.size, second.size);
}

function checkBriefingStructure(content, type) {
  const issues = [];
  const text = String(content || '');

  if (type === 'lecture') {
    if (!hasSectionMarker(text, type, '이 글에서 배울 수 있는 것')) {
      issues.push({ severity: 'warn', msg: 'AI Briefing용 학습 포인트 섹션 누락: "이 글에서 배울 수 있는 것"' });
    }
  }

  if (type === 'general') {
    if (!hasSectionMarker(text, type, '이 글에서 배울 수 있는 것')) {
      issues.push({ severity: 'warn', msg: 'AI Briefing용 학습 포인트 섹션 누락: "이 글에서 배울 수 있는 것"' });
    }
  }

  const faqCount = countQuestionStyleFaq(text);
  const answeredFaqCount = countAnsweredFaqPairs(text);
  if (faqCount < 3) {
    issues.push({ severity: 'warn', msg: `질문형 Q&A 부족: ${faqCount}개 (권장 최소 3개)` });
  }
  if (answeredFaqCount < 3) {
    issues.push({ severity: 'warn', msg: `질문형 Q&A 답변 밀도 부족: ${answeredFaqCount}개 (권장 최소 3개)` });
  }

  return issues;
}

function sanitizeForAIDetection(content) {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<code[\s\S]*?<\/code>/gi, ' ')
    .replace(/_THE_END_/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkAIDetectionRisk(content) {
  const issues = [];
  let riskScore = 0;
  const normalized = sanitizeForAIDetection(content);

  const sentences = normalized
    .split(/[.!?。]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && !/^(use strict|nodejs \d+강|\[.*\])$/i.test(s));

  const phraseMap = {};
  for (const sentence of sentences) {
    const key = sentence.trim().slice(0, 20);
    if (key.length > 5) phraseMap[key] = (phraseMap[key] || 0) + 1;
  }
  const repeatedPhrases = Object.values(phraseMap).filter((count) => count >= 3);
  if (repeatedPhrases.length > 0) {
    riskScore += 20;
    issues.push({ severity: 'warn', msg: `반복 어구 ${repeatedPhrases.length}개 (3회 이상 반복)` });
  }

  const endingMatches = normalized.match(/입니다|합니다|됩니다|있습니다/g) || [];
  const endingRatio = endingMatches.length / Math.max(sentences.length, 1);
  if (endingRatio > 0.6) {
    riskScore += 15;
    issues.push({ severity: 'warn', msg: `종결어미 단조로움: ${(endingRatio * 100).toFixed(0)}% (~입니다/합니다)` });
  }

  if (sentences.length > 10) {
    const avg = sentences.reduce((acc, sentence) => acc + sentence.length, 0) / sentences.length;
    const variance = sentences.reduce((acc, sentence) => acc + (sentence.length - avg) ** 2, 0) / sentences.length;
    const cv = Math.sqrt(variance) / avg;
    if (cv < 0.25) {
      riskScore += 15;
      issues.push({ severity: 'warn', msg: `문장 길이 과도 균일 (CV: ${cv.toFixed(2)}, AI적 패턴)` });
    }
  }

  if (!/제가|저는|솔직히|느꼈|경험|실제로.*해보니|직접.*해본|제 생각/.test(normalized)) {
    riskScore += 25;
    issues.push({ severity: 'warn', msg: '개인 경험/감상 표현 미포함 — 리라이팅 시 추가 필요' });
  }

  if (!/놀랐|감동|기뻤|아쉬웠|뿌듯|설레|두근|가슴이|반가웠|인상적/.test(normalized)) {
    riskScore += 10;
    issues.push({ severity: 'info', msg: '감정 표현 부족 — 리라이팅 시 추가 권장' });
  }

  const hasWeather = /날씨|기온|[0-9]+도|비가|눈이|맑|흐림|바람|춥|덥|선선|따뜻|쌀쌀|봄|여름|가을|겨울|햇살|창밖/.test(normalized);
  const hasDate = /월요일|화요일|수요일|목요일|금요일|토요일|일요일|오늘 아침|이른 아침|오후/.test(normalized);
  const hasPlace = /서현|분당|커피랑|도서관|자리에 앉|창가|책상/.test(normalized);
  const ctxScore = [hasWeather, hasDate, hasPlace].filter(Boolean).length;

  if (ctxScore === 0) {
    riskScore += 20;
    issues.push({ severity: 'warn', msg: '실시간 맥락(날씨/날짜/장소) 전혀 없음 — AI 탐지 위험 높음' });
  } else if (ctxScore === 1) {
    riskScore += 5;
    issues.push({ severity: 'info', msg: `실시간 맥락 부족 (${ctxScore}/3) — 날씨+날짜+장소 모두 포함 권장` });
  }

  return {
    riskScore,
    riskLevel: riskScore >= 50 ? 'high' : riskScore >= 30 ? 'medium' : 'low',
    issues,
  };
}

function checkQuality(content, type) {
  const issues = [];
  const charCount = content.length;
  const minChars = MIN_CHARS[type] || 7000;
  const goalChars = GOAL_CHARS[type] || 9000;

  if (charCount < minChars) {
    issues.push({ severity: 'error', msg: `글자수 부족: ${charCount}자 (최소 ${minChars}자)` });
  } else if (charCount < goalChars) {
    issues.push({ severity: 'warn', msg: `글자수 목표 미달: ${charCount}자 (목표 ${goalChars}자)` });
  }

  for (const marker of REQUIRED_SECTION_MARKERS[type] || []) {
    if (!hasSectionMarker(content, type, marker)) {
      issues.push({ severity: 'error', msg: `필수 섹션 누락: "${marker}"` });
    }
  }

  if (!content.includes('커피랑도서관') && !content.includes('분당서현')) {
    issues.push({ severity: 'warn', msg: '스터디카페 홍보 미포함' });
  }

  const hashtagMatch = content.match(/#[^\s#\n]+/g);
  const hashtagCount = hashtagMatch?.length || 0;
  if (hashtagCount < 15) {
    issues.push({ severity: 'warn', msg: `해시태그 부족: ${hashtagCount}개 (최소 15개)` });
  }

  const aiRisk = checkAIDetectionRisk(content);
  if (aiRisk.riskScore >= AI_RISK_REWRITE_THRESHOLD) {
    issues.push({ severity: 'error', msg: `AI 탐지 리스크 높음 (${aiRisk.riskScore}점) — 자동 재작성 대상` });
  } else if (aiRisk.riskLevel === 'medium') {
    issues.push({ severity: 'info', msg: `AI 탐지 리스크 중간 (${aiRisk.riskScore}점) — 개인 에피소드 보강 권장` });
  }

  issues.push(...checkBriefingStructure(content, type));
  issues.push(...checkTruncatedEnding(content, type));

  return {
    passed: !issues.some((issue) => issue.severity === 'error'),
    charCount,
    hashtagCount,
    aiRisk,
    issues,
  };
}

function extractExternalPackages(content) {
  const codeBlocks = String(content || '').match(/```[\s\S]*?```/g) || [];
  const packages = new Set();
  for (const block of codeBlocks) {
    for (const match of block.matchAll(/require\(['"]([^'"]+)['"]\)|from ['"]([^'"]+)['"]/g)) {
      const pkg = (match[1] || match[2] || '').trim();
      if (!pkg || pkg.startsWith('.') || pkg.startsWith('/')) continue;
      if (pkg.startsWith('node:')) continue;
      if (builtinModules.has(pkg)) continue;
      packages.add(pkg.split('/')[0] === '@' ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0]);
    }
  }
  return [...packages];
}

function packageExists(pkg) {
  return new Promise((resolve) => {
    const req = https.get(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, { timeout: 4000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function checkQualityEnhanced(content, type, options = {}) {
  const quality = checkQuality(content, type);
  const issues = [...quality.issues];

  if (type === 'lecture' && options.lectureNumber && options.expectedLectureTitle) {
    const titleLine = String(content || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) || '';
    const titleMatch = titleLine.match(/\[(?:Node\.js\s*)?(\d+)강\]\s*([^\n]+)/);
    if (titleMatch) {
      const detectedNum = Number(titleMatch[1]);
      if (detectedNum !== Number(options.lectureNumber)) {
        issues.push({ severity: 'error', msg: `강의 번호 불일치: 제목 ${detectedNum}강 / 기대 ${options.lectureNumber}강` });
      }
      if (!titleMatch[2].includes(options.expectedLectureTitle)) {
        issues.push({ severity: 'warn', msg: `강의 제목 불일치 가능: 기대 "${options.expectedLectureTitle}"` });
      }
    }
  }

  if (type === 'general' && options.category === '도서리뷰') {
    const expectedBook = options.bookInfo || null;
    const expectedIsbn = String(expectedBook?.isbn || '').replace(/[^0-9]/g, '');
    const expectedTitle = String(expectedBook?.title || '').trim();
    const expectedAuthor = String(expectedBook?.author || '').split(',')[0].trim();

    if (!expectedBook || !expectedIsbn || String(expectedBook.source || '') === 'fallback') {
      issues.push({ severity: 'error', msg: '도서리뷰 검증 실패: ISBN13 있는 검증 도서 정보가 필요함' });
    } else {
      if (expectedTitle && !String(content || '').includes(expectedTitle)) {
        issues.push({ severity: 'error', msg: `도서리뷰 제목/본문에 검증된 도서명이 없음: "${expectedTitle}"` });
      }
      if (expectedAuthor && !String(content || '').includes(expectedAuthor)) {
        issues.push({ severity: 'warn', msg: `도서리뷰 본문에 검증된 저자명이 약하게 나타남: "${expectedAuthor}"` });
      }
    }
  }

  if (type === 'general') {
    const titleLine = extractFirstContentLine(content);
    const normalizedTitle = String(titleLine || '').replace(/^\[[^\]]+\]\s*/, '').trim();
    const expectedPattern = String(options.expectedTitlePattern || '').trim();
    const topicTitleCandidate = String(options.topicTitleCandidate || '').trim();

    if (expectedPattern && normalizedTitle) {
      const detectedPattern = detectTitlePattern(normalizedTitle);
      if (detectedPattern !== expectedPattern) {
        issues.push({
          severity: 'warn',
          msg: `제목 패턴 이탈 가능: 현재 ${detectedPattern} / 기대 ${expectedPattern}`,
        });
      }
    }

    if (topicTitleCandidate && normalizedTitle) {
      const overlap = calculateTitleOverlap(normalizedTitle, topicTitleCandidate);
      if (overlap < 0.2) {
        issues.push({
          severity: 'error',
          msg: `제목 방향 이탈: 제목 후보와 핵심 키워드 겹침이 약함 (${overlap.toFixed(2)})`,
        });
      } else if (overlap < 0.4) {
        issues.push({
          severity: 'warn',
          msg: `제목 후보 반영이 약함: 핵심 키워드 겹침 ${overlap.toFixed(2)}`,
        });
      }
    }
  }

  const packages = extractExternalPackages(content);
  for (const pkg of packages.slice(0, 8)) {
    const exists = await packageExists(pkg);
    if (exists === false) {
      issues.push({
        severity: type === 'lecture' ? 'warn' : 'error',
        msg: `코드 블록 패키지 미존재: ${pkg}`,
      });
    }
  }

  return {
    ...quality,
    issues,
    passed: !issues.some((issue) => issue.severity === 'error'),
    packageChecks: packages,
    autoRewriteRecommended: quality.aiRisk?.riskScore >= AI_RISK_REWRITE_THRESHOLD,
  };
}

// ─── SEO 점수화 ───────────────────────────────────────────────────────────────

const SEO_TREND_KEYWORDS = [
  'AI', 'LLM', '자동화', '클라우드', 'SaaS', '생산성', '루틴', '커리어',
  '체크리스트', '실전', '가이드', '기준', '방법', '노하우', '핵심',
];

function scoreSEO(content, title = '') {
  const text = String(content || '');
  const titleStr = String(title || '').trim();
  let score = 0;
  const issues = [];

  // 제목 길이 (15~35자 SEO 적정)
  const titleLen = titleStr.length;
  if (titleLen >= 15 && titleLen <= 35) score += 20;
  else if (titleLen >= 10 && titleLen < 15) { score += 10; issues.push('제목이 짧음 (15자 이상 권장)'); }
  else if (titleLen > 35) { score += 5; issues.push('제목이 너무 긺 (35자 이하 권장)'); }
  else { issues.push('제목 길이 부적합'); }

  // 제목에 숫자 또는 질문형 → CTR 향상
  if (/\d/.test(titleStr)) score += 10;
  if (/[?？]/.test(titleStr) || /방법|기준|이유|가이드/.test(titleStr)) score += 10;

  // h2 헤딩 최소 3개
  const h2Count = (text.match(/<h2[^>]*>/gi) || []).length;
  if (h2Count >= 5) score += 15;
  else if (h2Count >= 3) score += 10;
  else { score += 0; issues.push(`h2 헤딩 부족: ${h2Count}개 (최소 3개 권장)`); }

  // FAQ / Q&A 섹션
  if (/AEO FAQ|질문형 Q&A/i.test(text)) score += 15;

  // 해시태그 15개 이상
  const hashCount = (text.match(/#[^\s#\n]+/g) || []).length;
  if (hashCount >= 15) score += 10;
  else { issues.push(`해시태그 부족: ${hashCount}개`); }

  // 트렌드 키워드 포함
  const trendHits = SEO_TREND_KEYWORDS.filter(k => text.includes(k)).length;
  score += Math.min(trendHits * 2, 20);

  return {
    seoScore: Math.min(score, 100),
    seoLevel: score >= 70 ? 'good' : score >= 45 ? 'fair' : 'poor',
    seoIssues: issues,
  };
}

// ─── 30일 중복 체크 ───────────────────────────────────────────────────────────

async function checkDuplicate30d(title, category = null) {
  try {
    const pgPool = require('../../../packages/core/lib/pg-pool');
    const cutoff = (() => {
      const kst = require('../../../packages/core/lib/kst');
      return kst.daysAgoStr(30);
    })();

    const whereCategory = category ? `AND category = $2` : '';
    const params = category ? [cutoff, category] : [cutoff];
    const rows = await pgPool.query('blog',
      `SELECT title FROM blog.posts
       WHERE type = 'general'
         AND DATE(publish_date) >= $1
         AND status NOT IN ('failed', 'error')
         ${whereCategory}
       ORDER BY publish_date DESC`,
      params
    );

    if (!rows || rows.length === 0) return { isDuplicate: false, similarTitle: null };

    // bigram 유사도
    const normalize = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const bigram = s => {
      const n = normalize(s);
      const set = new Set();
      for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
      return set;
    };
    const sim = (a, b) => {
      const A = bigram(a); const B = bigram(b);
      if (!A.size || !B.size) return 0;
      let inter = 0; for (const x of A) if (B.has(x)) inter++;
      return inter / new Set([...A, ...B]).size;
    };

    for (const row of rows) {
      if (sim(row.title, title) > 0.4) {
        return { isDuplicate: true, similarTitle: row.title };
      }
    }
    return { isDuplicate: false, similarTitle: null };
  } catch {
    return { isDuplicate: false, similarTitle: null };
  }
}

// ─── 5-Round LLM 크리틱 루프 ─────────────────────────────────────────────────

const CRITIC_ROUNDS = [
  { id: 1, label: '구조 완전성',   aspect: '섹션 구성과 흐름이 독자에게 자연스럽고 완전한가? 누락된 핵심 섹션이 있는가?' },
  { id: 2, label: 'AI 탐지 리스크', aspect: '개인 경험, 실시간 맥락(날씨/장소/날짜), 감정 표현이 충분히 포함되어 인간적으로 느껴지는가?' },
  { id: 3, label: 'SEO 적합성',   aspect: '제목, 소제목, FAQ, 해시태그가 검색에 최적화되어 있는가? 핵심 키워드가 자연스럽게 배치되었는가?' },
  { id: 4, label: '독자 실용 가치', aspect: '독자가 이 글을 읽고 즉시 적용할 수 있는 구체적 행동 지침이 있는가? 정보가 실질적으로 유용한가?' },
  { id: 5, label: '종합 완성도',   aspect: '전체적으로 네이버 블로그 상위 노출에 적합한 수준인가? 0~10점으로 평가하고 가장 중요한 개선점 1가지를 제시하라.' },
];

async function runCriticLoop(content, type, options = {}) {
  let callLocalLlm;
  try {
    callLocalLlm = require('../../../packages/core/lib/local-llm-client').callLocalLlm;
  } catch {
    return { criticScore: null, criticRounds: [], criticFeedback: 'LLM 클라이언트 로드 실패' };
  }

  const text = String(content || '');
  const snippet = text.slice(0, 1500);  // 앞부분만 전달 (속도/비용 절감)
  const roundResults = [];
  let totalScore = 0;
  let finalFeedback = '';

  for (const round of CRITIC_ROUNDS) {
    try {
      const prompt = `블로그 포스팅 품질 검토 — Round ${round.id}: ${round.label}

포스팅 앞부분 (${type === 'lecture' ? '강의' : '일반'} 타입):
---
${snippet}
---

평가 기준: ${round.aspect}

${round.id === 5
  ? '0~10점으로 평가하고 다음 형식으로만 답하라:\n점수: N\n개선점: (한 문장)'
  : '이 항목 점수를 0~10으로 평가하고 숫자만 답하라.'}`;

      const result = await callLocalLlm({ prompt, model: 'qwen2.5:7b', maxTokens: 60, temperature: 0.2 });
      const text_ = result?.content || result?.text || '';

      if (round.id === 5) {
        const scoreMatch = text_.match(/점수\s*:\s*(\d+(?:\.\d+)?)/);
        const feedbackMatch = text_.match(/개선점\s*:\s*(.+)/);
        const s = scoreMatch ? Math.min(10, Math.max(0, parseFloat(scoreMatch[1]))) : 5;
        totalScore += s;
        finalFeedback = feedbackMatch ? feedbackMatch[1].trim() : '';
        roundResults.push({ round: round.id, label: round.label, score: s });
      } else {
        const numMatch = text_.match(/\d+(?:\.\d+)?/);
        const s = numMatch ? Math.min(10, Math.max(0, parseFloat(numMatch[0]))) : 5;
        totalScore += s;
        roundResults.push({ round: round.id, label: round.label, score: s });
      }
    } catch {
      totalScore += 5;  // 실패 시 중간값
      roundResults.push({ round: round.id, label: round.label, score: 5, error: true });
    }
  }

  const avgScore = totalScore / CRITIC_ROUNDS.length;
  return {
    criticScore: Math.round(avgScore * 10),  // 0~100 스케일
    criticLevel: avgScore >= 7 ? 'good' : avgScore >= 5 ? 'fair' : 'poor',
    criticRounds: roundResults,
    criticFeedback: finalFeedback,
    criticPassed: avgScore >= 6,
  };
}

// ─── 통합: checkQualityWithCritic ─────────────────────────────────────────────

async function checkQualityWithCritic(content, type, options = {}) {
  const [base, seo, dup, critic] = await Promise.allSettled([
    checkQualityEnhanced(content, type, options),
    Promise.resolve(scoreSEO(content, options.title || '')),
    options.title ? checkDuplicate30d(options.title, options.category || null) : Promise.resolve({ isDuplicate: false }),
    options.skipCritic ? Promise.resolve(null) : runCriticLoop(content, type, options),
  ]);

  const baseResult  = base.status  === 'fulfilled' ? base.value  : await checkQuality(content, type);
  const seoResult   = seo.status   === 'fulfilled' ? seo.value   : { seoScore: 0, seoLevel: 'poor', seoIssues: [] };
  const dupResult   = dup.status   === 'fulfilled' ? dup.value   : { isDuplicate: false };
  const criticResult = critic.status === 'fulfilled' ? critic.value : null;

  const allIssues = [...(baseResult.issues || [])];
  if (dupResult.isDuplicate) {
    allIssues.push({ severity: 'error', msg: `30일 내 유사 제목 존재: "${dupResult.similarTitle}"` });
  }
  if (seoResult.seoLevel === 'poor') {
    allIssues.push({ severity: 'warn', msg: `SEO 점수 낮음 (${seoResult.seoScore}점): ${seoResult.seoIssues.join(', ')}` });
  }
  if (criticResult && !criticResult.criticPassed) {
    allIssues.push({ severity: 'warn', msg: `크리틱 루프 미달 (${criticResult.criticScore}점): ${criticResult.criticFeedback}` });
  }

  return {
    ...baseResult,
    issues: allIssues,
    passed: !allIssues.some(i => i.severity === 'error'),
    seo: seoResult,
    duplicate: dupResult,
    critic: criticResult,
  };
}

module.exports = {
  checkQuality,
  checkQualityEnhanced,
  checkQualityWithCritic,
  checkAIDetectionRisk,
  scoreSEO,
  checkDuplicate30d,
  runCriticLoop,
  MIN_CHARS,
  GOAL_CHARS,
  REQUIRED_SECTION_MARKERS,
  AI_RISK_REWRITE_THRESHOLD,
};
