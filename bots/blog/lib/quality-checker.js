'use strict';

/**
 * quality-checker.js — 포스팅 품질 검증 + AI 탐지 리스크 분석
 */

const https = require('https');
const builtinModules = new Set(require('module').builtinModules || []);

const MIN_CHARS  = { lecture: 8000, general: 7000 };
const GOAL_CHARS = { lecture: 9000, general: 8000 };
const AI_RISK_REWRITE_THRESHOLD = 70;

const REQUIRED_SECTION_MARKERS = {
  lecture: ['핵심 요약', '승호아빠 인사말', '최신 기술 브리핑', '강의 - 이론', '실무 - 코드', 'AEO FAQ', '함께 읽으면 좋은 글', '해시태그'],
  general: ['AI 스니펫 요약', '승호아빠 인사말', '본론 섹션 1', '본론 섹션 2', '본론 섹션 3', '마무리 제언', '해시태그'],
};

// ─── AI 탐지 리스크 분석 ──────────────────────────────────────────────

/**
 * AI 생성 콘텐츠 탐지 리스크 점수 계산 (0~100)
 * 높을수록 AI 탐지 위험 높음 → 마스터 리라이팅 필요
 */
function checkAIDetectionRisk(content) {
  const issues   = [];
  let riskScore  = 0;

  const sentences = content.split(/[.!?。]\s*/).filter(s => s.trim().length > 5);

  // 1. 반복 어구 밀도 (앞 20자 기준)
  const phraseMap = {};
  for (const s of sentences) {
    const key = s.trim().slice(0, 20);
    if (key.length > 5) phraseMap[key] = (phraseMap[key] || 0) + 1;
  }
  const repeatedPhrases = Object.values(phraseMap).filter(cnt => cnt >= 3);
  if (repeatedPhrases.length > 0) {
    riskScore += 20;
    issues.push({ severity: 'warn', msg: `반복 어구 ${repeatedPhrases.length}개 (3회 이상 반복)` });
  }

  // 2. 종결어미 단조로움 (입니다/합니다/됩니다 비율)
  const endingMatches = content.match(/입니다|합니다|됩니다|있습니다/g) || [];
  const endingRatio   = endingMatches.length / Math.max(sentences.length, 1);
  if (endingRatio > 0.6) {
    riskScore += 15;
    issues.push({ severity: 'warn', msg: `종결어미 단조로움: ${(endingRatio * 100).toFixed(0)}% (~입니다/합니다)` });
  }

  // 3. 문장 길이 과도 균일 (AI 특성 — 변동계수 0.25 미만)
  if (sentences.length > 10) {
    const avg     = sentences.reduce((a, s) => a + s.length, 0) / sentences.length;
    const variance = sentences.reduce((a, s) => a + (s.length - avg) ** 2, 0) / sentences.length;
    const cv      = Math.sqrt(variance) / avg;
    if (cv < 0.25) {
      riskScore += 15;
      issues.push({ severity: 'warn', msg: `문장 길이 과도 균일 (CV: ${cv.toFixed(2)}, AI적 패턴)` });
    }
  }

  // 4. 개인 경험/감상 표현 미포함
  if (!/제가|저는|솔직히|느꼈|경험|실제로.*해보니|직접.*해본|제 생각/.test(content)) {
    riskScore += 25;
    issues.push({ severity: 'warn', msg: '개인 경험/감상 표현 미포함 — 리라이팅 시 추가 필요' });
  }

  // 5. 감정 표현 부족
  if (!/놀랐|감동|기뻤|아쉬웠|뿌듯|설레|두근|가슴이/.test(content)) {
    riskScore += 10;
    issues.push({ severity: 'info', msg: '감정 표현 부족 — 리라이팅 시 추가 권장' });
  }

  // 6. 실시간 맥락(날씨/날짜/장소) 포함 여부
  const hasWeather = /날씨|기온|[0-9]+도|비가|눈이|맑|흐림|바람|춥|덥|선선|따뜻|쌀쌀|봄|여름|가을|겨울|햇살|창밖/.test(content);
  const hasDate    = /월요일|화요일|수요일|목요일|금요일|토요일|일요일|오늘 아침|이른 아침|오후/.test(content);
  const hasPlace   = /서현|분당|커피랑|도서관|자리에 앉|창가|책상/.test(content);
  const ctxScore   = [hasWeather, hasDate, hasPlace].filter(Boolean).length;

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

// ─── 품질 검증 ────────────────────────────────────────────────────────

/**
 * @param {string} content  — 포스팅 본문
 * @param {'lecture'|'general'} type
 * @returns {{ passed, charCount, hashtagCount, aiRisk, issues }}
 */
function checkQuality(content, type) {
  const issues    = [];
  const charCount = content.length;
  const minChars  = MIN_CHARS[type]  || 7000;
  const goalChars = GOAL_CHARS[type] || 9000;

  // 1. 글자수 체크
  if (charCount < minChars) {
    issues.push({ severity: 'error', msg: `글자수 부족: ${charCount}자 (최소 ${minChars}자)` });
  } else if (charCount < goalChars) {
    issues.push({ severity: 'warn', msg: `글자수 목표 미달: ${charCount}자 (목표 ${goalChars}자)` });
  }

  // 2. 필수 섹션 체크
  for (const marker of REQUIRED_SECTION_MARKERS[type] || []) {
    if (!content.includes(marker)) {
      issues.push({ severity: 'error', msg: `필수 섹션 누락: "${marker}"` });
    }
  }

  // 3. 커피랑도서관 홍보 포함 여부
  if (!content.includes('커피랑도서관') && !content.includes('분당서현')) {
    issues.push({ severity: 'warn', msg: '스터디카페 홍보 미포함' });
  }

  // 4. 해시태그 수 체크
  const hashtagMatch = content.match(/#[^\s#\n]+/g);
  const hashtagCount = hashtagMatch?.length || 0;
  if (hashtagCount < 15) {
    issues.push({ severity: 'warn', msg: `해시태그 부족: ${hashtagCount}개 (최소 15개)` });
  }

  // 5. AI 탐지 리스크 분석
  const aiRisk = checkAIDetectionRisk(content);
  if (aiRisk.riskScore >= AI_RISK_REWRITE_THRESHOLD) {
    issues.push({ severity: 'error', msg: `AI 탐지 리스크 높음 (${aiRisk.riskScore}점) — 자동 재작성 대상` });
  } else if (aiRisk.riskLevel === 'medium') {
    issues.push({ severity: 'info', msg: `AI 탐지 리스크 중간 (${aiRisk.riskScore}점) — 개인 에피소드 보강 권장` });
  }

  return {
    passed:      !issues.some(i => i.severity === 'error'),
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
      .map(line => line.trim())
      .find(line => line.length > 0) || '';
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

  const packages = extractExternalPackages(content);
  for (const pkg of packages.slice(0, 8)) {
    const exists = await packageExists(pkg);
    if (exists === false) {
      issues.push({ severity: 'error', msg: `코드 블록 패키지 미존재: ${pkg}` });
    }
  }

  return {
    ...quality,
    issues,
    passed: !issues.some(i => i.severity === 'error'),
    packageChecks: packages,
    autoRewriteRecommended: quality.aiRisk?.riskScore >= AI_RISK_REWRITE_THRESHOLD,
  };
}

module.exports = { checkQuality, checkQualityEnhanced, checkAIDetectionRisk, MIN_CHARS, GOAL_CHARS, REQUIRED_SECTION_MARKERS, AI_RISK_REWRITE_THRESHOLD };
