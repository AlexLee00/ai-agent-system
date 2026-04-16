# 블로팀 종합 개선 — TS 실전환 + 포스팅 품질 + 이미지 업그레이드!

> 메티 | 2026-04-10 | OPS 구현
> 현황: 34ts/34js 1:1 래퍼 (실로직은 .legacy.js!)
> 목표: TS 실전환 + 포스팅 품질↑ + 이미지 FLUX.2!
>
> **[2026-04-17 상태] Part A/B/C/D 전부 완료**
> - Part A(TS 실전환): __dirname 전수 제거 + @ts-nocheck 전수 제거 완료 (2026-04-17) ✅
>   - lib/ 40개 + scripts/ 34개 파일, npx tsc --noEmit 에러 없음
> - Part B(포스팅 품질: 3단계 프롬프트, quality-checker.ts, AI패턴감지) ✅
> - Part C(이미지): 모든 Part 구현 확인, CODEX_BLOG_IMAGE_REDESIGN.md archive 완료 ✅
> - Part D(제목 다양성: topic-selector.ts, BANNED_PATTERNS) ✅

---

## Part A: TS 실전환! (래퍼 → 실코드!)

### 현재 문제!
```
.ts = @ts-nocheck + require('.legacy.js') = 타입 검증 0!
.js = 14줄 shim (dist → .legacy.js 폴백!)
.legacy.js = 실제 로직! (14줄~1041줄!)

= "겉만 TS" 상태!
```

### Task A-1: .legacy.js 로직 → .ts 통합!

```
패턴: 각 파일마다!
1. .legacy.js 내용을 .ts에 복사!
2. .ts 상단에 // @ts-nocheck 유지! (당장 타입 안 붙여도 OK!)
3. .legacy.js → .backup.js 리네임! (안전!)
4. .js shim이 .ts를 직접 require하도록 수정!

순서 (큰 파일부터!):
  blo.legacy.js (1041줄!) → blo.ts
  commenter.legacy.js (859줄!) → commenter.ts
  curriculum-planner.legacy.js (565줄!) → curriculum-planner.ts
  publ.legacy.js (567줄!) → publ.ts
  richer.legacy.js (440줄!) → richer.ts
  maestro.legacy.js (405줄!) → maestro.ts
  img-gen.legacy.js (386줄!) → img-gen.ts
  star.legacy.js (284줄!) → star.ts
  quality-checker.legacy.js (278줄!) → quality-checker.ts
  social.legacy.js (232줄!) → social.ts
  나머지 소형 파일!
```

### Task A-2: .js shim 정리!

```javascript
// 기존 shim (blo.js 14줄!):
try { module.exports = require(runtimePath); }
catch { module.exports = require('./blo.legacy.js'); }

// 수정: tsx 환경이면 .ts 직접!
try { module.exports = require(runtimePath); }
catch { module.exports = require('./blo.ts'); }
```

### Task A-3: scripts/ .ts 전환!

```
bots/blog/scripts/ 14개 파일!
.legacy.js → .ts 통합! (A-1과 동일 패턴!)
```

### 검증!

```
[ ] 모든 .legacy.js 로직이 .ts에!
[ ] .legacy.js → .backup.js 리네임!
[ ] npm run typecheck 통과! (@ts-nocheck 유지!)
[ ] tsx bots/blog/scripts/run-daily.ts 실행!
[ ] 블로그 발행 테스트 1건!
```

---

## Part B: 포스팅 품질 향상!

### Task B-1: 3단계 프롬프트 도입!

```
현재: 단일 프롬프트 → LLM 한번에 전체 생성!
개선: 3단계!

Stage 1 — 아웃라인 + 핵심 포인트!
  "이 주제에 대해 5개 섹션 아웃라인과
   각 섹션의 핵심 데이터/경험을 나열해줘"

Stage 2 — 섹션별 초안!
  각 섹션마다 별도 프롬프트!
  "다음 아웃라인 기반으로 이 섹션만 작성해줘.
   실제 경험과 구체적 숫자를 포함해."

Stage 3 — 품질 체크 + 수정!
  "AI 패턴 제거, 문장 길이 변화, 구체성 확인"
```

```javascript
// bots/blog/lib/maestro.ts 수정!
// 기존 generatePost → 3단계로!

async function generatePost(config) {
  // Stage 1: 아웃라인!
  const outline = await generateOutline(config);

  // Stage 2: 섹션별 초안!
  const sections = [];
  for (const section of outline.sections) {
    const draft = await generateSection(section, config);
    sections.push(draft);
  }
  const fullDraft = sections.join('\n\n');

  // Stage 3: 품질 체크 + 수정!
  const checked = await qualityCheckAndRevise(fullDraft, config);
  return checked;
}
```

### Task B-2: 실제 경험 주입!

```javascript
// bots/blog/lib/daily-config.ts 또는 새 파일!
// 카페 실제 데이터 — 프롬프트에 주입!

const REAL_EXPERIENCE = {
  cafeName: '커피랑도서관',
  location: '분당서현',
  monthlyRevenue: '운영 경험 기반',
  popularMenus: ['아메리카노', '카페라떼', '크로플'],
  seasonalTips: {
    spring: '벚꽃 시즌 테라스 활용',
    summer: '빙수/에이드 매출 비중 증가',
    autumn: '할로윈 이벤트 + 따뜻한 음료',
    winter: '크리스마스 시즌 매출 피크',
  },
  customerInsights: [
    '오전 9시 직장인 테이크아웃 집중',
    '오후 3시 주부/프리랜서 체류',
    '주말 가족 단위 방문 증가',
  ],
};

// 프롬프트에 주입!
// "당신은 카페 '커피랑도서관'을 운영하는 블로거입니다.
//  실제 경험: ${JSON.stringify(REAL_EXPERIENCE)}
//  이 경험을 자연스럽게 녹여서 작성하세요."
```

### Task B-3: quality-checker AI 패턴 감지!

```javascript
// bots/blog/lib/quality-checker.ts 추가!

const AI_PATTERNS = [
  // 상투적 도입!
  /오늘날.*빠르게 변화/,
  /현대 사회에서/,
  /많은 사람들이/,
  /~에 대해 알아보겠습니다/,
  /~해 보도록 하겠습니다/,
  // 상투적 연결!
  /또한,/,
  /뿐만 아니라/,
  /이러한 관점에서/,
  /마지막으로/,
  // AI 특유 마무리!
  /~하시기 바랍니다/,
  /~해 보시는 건 어떨까요/,
  /도움이 되셨기를 바랍니다/,
];

function detectAIPatterns(text) {
  const found = [];
  for (const pattern of AI_PATTERNS) {
    const matches = text.match(new RegExp(pattern, 'g'));
    if (matches) found.push({ pattern: pattern.source, count: matches.length });
  }
  return found;
}

// 문장 길이 변화율 (burstiness!)
function measureBurstiness(text) {
  const sentences = text.split(/[.!?]\s/);
  const lengths = sentences.map(s => s.length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - avg) ** 2, 0) / lengths.length;
  const stddev = Math.sqrt(variance);
  // 사람 글: stddev/avg > 0.5 / AI 글: stddev/avg < 0.3!
  return { avg, stddev, ratio: stddev / avg, human: stddev / avg > 0.4 };
}

// 구체성 점수!
function measureSpecificity(text) {
  const numbers = (text.match(/\d+/g) || []).length;
  const properNouns = (text.match(/[가-힣]{2,}[점관원실]/g) || []).length;
  const quotes = (text.match(/["""'']/g) || []).length;
  return { numbers, properNouns, quotes, score: numbers + properNouns * 2 + quotes };
}
```

### Task B-4: 경쟁 분석 활용!

```javascript
// bots/blog/scripts/collect-competition-results.ts 확장!
// 상위 블로그 패턴 분석 → 전략 반영!

async function analyzeTopPosts(competitionData) {
  // 상위 3개 포스트의 패턴!
  const patterns = {
    avgLength: 0,        // 평균 글 길이!
    imageCount: 0,       // 평균 이미지 수!
    headingCount: 0,     // 제목 수!
    hasPersonalStory: false,  // 개인 경험!
    hasData: false,      // 데이터/통계!
  };
  // ... 분석 로직 ...
  
  // 다음 포스팅에 반영!
  return {
    recommendedLength: patterns.avgLength * 1.1,  // 10% 더!
    recommendedImages: Math.max(3, patterns.imageCount),
    mustInclude: ['개인 경험', '구체적 숫자'],
  };
}
```

### Task B-5: 토픽 클러스터링!

```javascript
// bots/blog/lib/curriculum-planner.ts 확장!
// 5개 주제 묶음 → 내부 링크!

const TOPIC_CLUSTERS = {
  '카페 창업': {
    pillar: '카페 창업 완전 가이드',
    spokes: [
      '카페 인테리어 비용과 팁',
      '카페 메뉴 구성 전략',
      '카페 마케팅 방법',
      '카페 운영 비용 분석',
      '카페 창업 후기와 현실',
    ],
  },
  '스터디카페': {
    pillar: '스터디카페 운영 가이드',
    spokes: [
      '스터디카페 좌석 배치',
      '스터디카페 방음 솔루션',
      '스터디카페 시간권 vs 기간권',
      '스터디카페 무인 운영',
    ],
  },
};

// 포스팅 생성 시 클러스터 내 이전 글 링크 자동 삽입!
function getInternalLinks(topic, cluster) {
  // 같은 클러스터 내 발행된 글 URL 반환!
}
```

---

## Part C: 이미지 품질 업그레이드!

### 현재 문제!
```
❌ SDXL 1.0 (2023년!) — 2세대 뒤쳐짐!
❌ SVG 한글 오버레이 — 품질 낮음!
❌ 브랜드 일관성 없음 — 매번 다른 스타일!
❌ 인스타 카드 — 프로 수준과 격차!
```

### Task C-1: FLUX.2 Dev 모델 교체!

```
Mac Studio M4 Max = 128GB 통합 메모리!
FLUX.2 Dev GGUF Q8 = ~12GB!
= 충분히 로컬 실행!

설치:
1. ComfyUI에 FLUX.2 Dev GGUF 모델 다운로드!
   https://huggingface.co/city96/FLUX.1-dev-gguf
   → flux1-dev-Q8_0.gguf (~12GB!)

2. ComfyUI-GGUF 커스텀 노드 설치!
   cd ComfyUI/custom_nodes
   git clone https://github.com/city96/ComfyUI-GGUF

3. 워크플로우 업데이트!
   SDXL 워크플로우 → FLUX.2 워크플로우!
```

```javascript
// packages/core/lib/local-image-client.ts 수정!
// 체크포인트 교체!

const DEFAULT_CHECKPOINT = 'flux1-dev-Q8_0.gguf';  // ← SDXL에서 교체!
const DEFAULT_STEPS = 20;  // FLUX는 20~30 steps!
const DEFAULT_CFG = 3.5;   // FLUX는 낮은 CFG!
const DEFAULT_SAMPLER = 'euler';
const DEFAULT_SCHEDULER = 'simple';

// 워크플로우 템플릿도 FLUX용으로!
// FLUX는 T5 텍스트 인코더 사용 → 프롬프트 이해도 훨씬 높음!
```

### Task C-2: 프롬프트 템플릿 브랜드화!

```javascript
// bots/blog/lib/img-gen.ts 수정!
// 브랜드 일관 프롬프트!

const BRAND_STYLE = [
  'warm cafe atmosphere',
  'soft natural lighting',
  'cozy interior with wooden elements',
  'Korean cafe aesthetic',
  'clean minimalist composition',
  'professional photography style',
  'shallow depth of field',
].join(', ');

const NEGATIVE_PROMPT = [
  'text', 'watermark', 'logo', 'signature',
  'blurry', 'low quality', 'cartoon', 'anime',
  'oversaturated', 'dark', 'gloomy',
].join(', ');

// 포스트 이미지 프롬프트!
function buildBlogImagePrompt(title, category) {
  const categoryStyles = {
    '카페': 'cozy cafe interior, coffee cups, pastries, warm ambiance',
    '스터디카페': 'modern study space, clean desks, focused atmosphere',
    '맛집': 'beautifully plated food, restaurant interior, appetizing',
    '리뷰': 'product close-up, clean background, editorial style',
    '일상': 'lifestyle photography, natural moments, warm tones',
  };
  const style = categoryStyles[category] || categoryStyles['카페'];
  return `${style}, ${BRAND_STYLE}, inspired by ${title}`;
}
```

### Task C-3: 인스타 카드 — 당분간 수동! (Canva!)

```
⚠️ 인스타 카드는 AI 이미지 품질이 부족!
→ 당분간 마스터가 Canva로 직접 작성!

자동화 유지:
  ✅ social.ts 요약 텍스트 생성 (LLM!) → 유지!
  ✅ 캡션 + 해시태그 생성 (LLM!) → 유지!
  ❌ generateInstaCard (이미지!) → 비활성화!
  ✅ 마스터가 Canva에서 카드 제작!

코드 변경:
```

```javascript
// bots/blog/lib/social.ts 수정!

async function generateInstaContent(content, title, category, cardCount = 3) {
  // N40: 요약 텍스트 — 유지!
  const summaries = await summarizeSections(content);
  
  // N41: 카드 이미지 — 비활성화! 마스터 수동!
  // const cards = await generateCards(summaries);
  console.log(`[소셜] ⚠️ 인스타 카드 이미지: 수동 제작 필요!`);
  console.log(`[소셜] 요약 텍스트 ${summaries.length}건 생성됨 — Canva에서 사용!`);
  
  // 요약 텍스트를 파일로 저장! (마스터 참고용!)
  const textPath = path.join(INSTA_DIR, `insta-text-${Date.now()}.txt`);
  fs.writeFileSync(textPath, summaries.map((s, i) =>
    `=== 카드 ${i + 1} ===\n${s}\n`
  ).join('\n'));
  
  // N42: 캡션 + 해시태그 — 유지!
  const caption = await generateInstaCaption(content, title, category);
  
  return {
    summaries,
    caption,
    // cards: [], // 이미지 비활성화!
    textPath,  // 마스터 참고용!
    manualRequired: true,  // 플래그!
  };
}
```

### Task C-4: Canva 템플릿 가이드! (마스터용!)

```
Canva 무료! → https://www.canva.com

추천 템플릿:
  1. 인스타 카드 (1080x1080!)
     - 배경: 카페 톤 (웜 베이지/브라운!)
     - 폰트: Noto Sans KR Bold!
     - 레이아웃: 상단 제목 + 중앙 요약 + 하단 워터마크!
     
  2. 블로그 썸네일 (800x450!)
     - FLUX.2가 배경 생성!
     - Canva에서 텍스트만 추가!
     
  3. 시리즈 카드 (3장 세트!)
     - 통일된 색상/폰트!
     - 번호 표시 (1/3, 2/3, 3/3!)

워크플로우:
  AI → 요약 텍스트 생성 → insta-text-xxx.txt!
  마스터 → Canva에서 템플릿에 텍스트 배치!
  마스터 → 인스타 업로드!
```

### Task C-5: 중기 — 인스타 카드 자동화 복원!

```
FLUX.2 안정화 + LoRA 학습 후!

방법 1: Puppeteer + HTML 템플릿!
  → HTML/CSS로 카드 디자인!
  → Puppeteer로 스크린샷!
  → 한글 렌더링 완벽!

방법 2: Sharp + Canvas!
  → Node.js canvas 라이브러리!
  → 프로그래밍으로 이미지 생성!

방법 3: Figma API!
  → Figma 템플릿 → API로 텍스트 교체!
  → 가장 프로 수준!

= Phase 2에서 결정! 당장은 Canva 수동!
```

---

## 전체 테스트 체크리스트!

```
Part A (TS 실전환!):
  [ ] .legacy.js → .ts 통합 (20파일!)
  [ ] .legacy.js → .backup.js 리네임!
  [ ] scripts/ 14파일 .ts 통합!
  [ ] npm run typecheck 통과!
  [ ] tsx 실행 테스트!
  [ ] 블로그 발행 1건!
  [ ] 커밋: "feat(blog): TS 실전환!"

Part B (포스팅 품질!):
  [ ] 3단계 프롬프트 도입!
  [ ] REAL_EXPERIENCE 데이터 주입!
  [ ] AI 패턴 감지 추가!
  [ ] 경쟁 분석 활용!
  [ ] 토픽 클러스터링!
  [ ] 커밋: "feat(blog): 포스팅 품질 향상!"

Part C (이미지!):
  [ ] FLUX.2 Dev GGUF 설치!
  [ ] ComfyUI-GGUF 노드!
  [ ] 워크플로우 업데이트!
  [ ] 브랜드 프롬프트 템플릿!
  [ ] 인스타 카드 수동 전환!
  [ ] social.ts manualRequired 플래그!
  [ ] 커밋: "feat(blog): FLUX.2 + 인스타 수동!"
```

---

## 실행 순서!

```
1일차: Part A (TS 실전환!)
  .legacy.js → .ts 통합!
  tsx 실행 확인!

2일차: Part C-1~C-2 (이미지 모델 교체!)
  FLUX.2 설치 + 프롬프트 템플릿!
  테스트 이미지 5장!

3일차: Part C-3 (인스타 수동 전환!)
  social.ts 수정!
  Canva 템플릿 준비!

4~5일차: Part B (포스팅 품질!)
  3단계 프롬프트!
  경험 데이터 주입!
  품질 체커 강화!
  테스트 포스팅 2~3건!
```

## Part D: 제목 다양성 개선! (긴급!)

### 현재 문제!
```
모든 일반 포스팅 제목이 동일 패턴:
  "[카테고리] 왜 XXX는 YYY보다 ZZZ가 더 중요해졌을까"

근본 원인:
  1. LLM이 "왜...~일까" 질문형만 생성!
  2. 카테고리명이 제목 시작부에 반복 삽입!
  3. "A보다 B가 더 중요" 비교 구문 고정!
  4. 대체 프레임 템플릿 부재!
```

### Task D-1: 제목 프레임 다양화!

```javascript
// bots/blog/lib/gems-writer.ts 수정!

// 제목 생성 프레임 템플릿 — 카테고리별 10+ 패턴!
const TITLE_FRAME_TEMPLATES = [
  // 질문형 (다양한!)
  '{주제}을 시작하기 전에 반드시 점검해야 할 3가지',
  '{주제}, 지금 바꾸지 않으면 늦는 이유',
  '{주제}에서 초보자가 가장 먼저 실수하는 것',
  // 방법형
  '{주제} 완벽 가이드: 실전에서 바로 쓰는 핵심 정리',
  '{주제}을 한 단계 끌어올리는 실무 팁 5선',
  // 경험형
  '직접 해보고 깨달은 {주제}의 진짜 핵심',
  '3개월간 {주제}를 운영하며 배운 것들',
  // 비교형 (기존과 다른!)
  '{A} vs {B}: 실무자가 선택하는 기준',
  // 트렌드형
  '2026년 {주제} 트렌드: 달라진 것과 변하지 않는 것',
  // 리스트형
  '{주제}을 위한 체크리스트 7가지',
  // 스토리형
  '{주제}를 도입한 뒤 달라진 일상',
  // 문제 해결형
  '{주제}에서 막힐 때 가장 먼저 확인할 포인트',
];

// 최근 사용한 프레임 추적!
const TITLE_FORBIDDEN_FRAMES = [
  /^왜\s/,                        // "왜 ..." 시작 전면 금지!
  /보다.*더.*중요/,               // "A보다 B가 더 중요" 금지!
  /보다.*더.*먼저/,               // "A보다 B가 더 먼저" 금지!
  /~(일까|할까|될까|겠는가)\s*$/,  // 질문형 어미 연속 금지!
];
```

### Task D-2: 제목 생성 로직 수정!

```javascript
// gems-writer.ts _buildRecentGeneralThemeBlock 수정!

// 기존 프롬프트에 추가!
const titleInstructions = `
[제목 다양화 필수 규칙]
1. "왜 ...일까" 질문형 제목 사용 금지! 최근 3개 글이 모두 이 패턴이다.
2. 카테고리명을 제목 첫 단어로 넣지 마라. "[카테고리]" 태그로 충분하다.
3. "A보다 B가 더 중요/먼저" 비교 구문 금지!
4. 아래 제목 프레임 중 최근 사용하지 않은 것을 우선 선택하라:
${TITLE_FRAME_TEMPLATES.slice(0, 5).map((t, i) => `  ${i+1}. ${t}`).join('\n')}

5. 제목 길이: 20~35자 (너무 길면 검색에 불리!)
6. 독자가 "이건 나한테 필요하다"고 느끼는 구체적 상황을 담아라.
7. 숫자, 기간, 횟수 등 구체적 요소를 포함하라.

나쁜 예:
  ❌ "왜 홈페이지와 앱은 빨라지는 것보다 지금 무슨 일이 일어나는지 먼저 설명해야 신뢰를 얻을까"
  ❌ "왜 요즘 최신 기술은 더 대단한 기능보다 덜 흔들리는 기본기가 먼저 주목받을까"

좋은 예:
  ✅ "폼 입력 완료율 80% 넘기는 UX 설계 5원칙"
  ✅ "신규 서비스 런칭 3개월, 초기 사용자가 이탈하는 진짜 이유"
  ✅ "직접 비교해본 React vs Next.js: 소규모 팀이 선택하는 기준"
  ✅ "스터디카페 매출 30% 올린 좌석 배치 변경기"
`;
```

### Task D-3: 제목 검증 강화!

```javascript
// gems-writer.ts 제목 후처리 검증!

function validateTitle(title, recentTitles = []) {
  const issues = [];
  
  // 금지 프레임 검사!
  if (/^왜\s/.test(title)) issues.push('"왜..." 시작 금지!');
  if (/보다.*더.*(중요|먼저|필요)/.test(title)) issues.push('"A보다 B가 더" 비교 금지!');
  if (/[일할될겠]까\s*$/.test(title)) issues.push('질문형 어미 금지!');
  
  // 길이 검사!
  const cleanTitle = title.replace(/^\[[^\]]+\]\s*/, '');
  if (cleanTitle.length > 50) issues.push(`제목 너무 김 (${cleanTitle.length}자)!`);
  if (cleanTitle.length < 10) issues.push(`제목 너무 짧음 (${cleanTitle.length}자)!`);
  
  // 최근 제목과 유사도!
  for (const recent of recentTitles) {
    const similarity = calculateSimilarity(cleanTitle, recent);
    if (similarity > 0.5) issues.push(`최근 제목과 유사 (${(similarity*100).toFixed(0)}%): ${recent.slice(0,30)}...`);
  }
  
  return { valid: issues.length === 0, issues };
}

// 유사도 계산 (자카드!)
function calculateSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x));
  const union = new Set([...setA, ...setB]);
  return intersection.length / union.size;
}

// 제목 생성 후 검증 + 재생성!
async function generateValidTitle(context, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const post = await generatePost(context);
    const { valid, issues } = validateTitle(post.title, context.recentTitles);
    if (valid) return post;
    console.warn(`[블로] 제목 검증 실패 (시도 ${i+1}): ${issues.join(', ')}`);
    // 다음 시도에 issues를 프롬프트에 추가!
    context.titleFeedback = issues;
  }
  // 3회 실패 시 프레임 템플릿에서 강제 선택!
  return generatePostWithForcedFrame(context);
}
```

### Task D-4: 카테고리별 구체적 제목 풀!

```javascript
// 카테고리마다 구체적 제목 후보 10+개!
const CATEGORY_TITLE_POOL = {
  '홈페이지와App': [
    '회원가입 완료율을 2배로 올린 온보딩 개선 사례',
    '모바일 로딩 3초의 법칙: 실제 이탈률 데이터',
    '검색 UX 하나 바꿨더니 전환율이 달라졌다',
    '결제 페이지에서 이탈하는 5가지 마찰 포인트',
    '디자인 시스템 도입 6개월: 기대와 현실의 차이',
  ],
  '최신IT트렌드': [
    'AI 도구 10개 써보고 남긴 건 3개뿐이었다',
    '2026년 개발자 채용 시장에서 달라진 것들',
    'SaaS 구독 피로: 대안은 있는가',
    '오픈소스 의존성의 숨은 비용 계산법',
    '클라우드 비용 절감, 실제로 효과 있었던 방법',
  ],
  '자기계발': [
    '매일 30분 학습 루틴이 1년 후 만든 변화',
    '번아웃 직전에 깨달은 우선순위 정리법',
    '사이드 프로젝트 3개월 만에 수익화한 과정',
    '독서 100권 vs 실행 10번: 뭐가 더 남았나',
    '아침형 인간 도전기: 45일차 솔직 후기',
  ],
  '성장과성공': [
    '1인 창업 첫 해: 월별로 달라진 마인드셋',
    '실패한 프로젝트에서 건진 3가지 교훈',
    '팀 리더가 되고 나서 가장 먼저 바꾼 것',
    '매출 0원에서 월 100만원까지: 타임라인',
    '네트워킹 50회 후 깨달은 인맥의 진짜 의미',
  ],
  'IT정보와분석': [
    'PostgreSQL vs MySQL: 2026년 선택 기준',
    'Docker 컨테이너 보안, 놓치기 쉬운 5가지',
    'CI/CD 파이프라인 구축 실전 가이드',
    '모니터링 도구 비교: Grafana vs Datadog',
    'API 설계 실수 톱 5: 실무에서 만난 사례',
  ],
  '개발기획과컨설팅': [
    '요구사항 정의서, 이것만 포함하면 80점',
    '개발 일정 산정: 왜 항상 2배가 되는가',
    '고객이 "다 바꿔주세요"라고 할 때 대응법',
    '기획서 한 장으로 개발팀 설득하는 구조',
    '프로젝트 킥오프 미팅 체크리스트',
  ],
};
```

### 테스트!

```
[ ] TITLE_FORBIDDEN_FRAMES에 "왜..." 추가!
[ ] TITLE_FRAME_TEMPLATES 10+ 패턴!
[ ] validateTitle 검증 함수!
[ ] 카테고리별 CATEGORY_TITLE_POOL!
[ ] 테스트: 같은 카테고리 3회 생성 → 제목 모두 다른지!
[ ] 기존 "왜 ...일까" 패턴 나오지 않는지!
[ ] 커밋: "fix(blog): 제목 다양성 개선!"
```
