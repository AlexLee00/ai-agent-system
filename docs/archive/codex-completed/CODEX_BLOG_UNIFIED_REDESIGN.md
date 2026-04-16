# 블로팀 통합 재설계 — n8n + RAG + 포스팅 = 자기진화 파이프라인!

> 메티 | 2026-04-10 | 설계 문서 + 코덱스 프롬프트
> 핵심: 3시스템을 피드백 루프 + 에이전트 진화 관점에서 통합!
> 연구: Agentic RAG 2026 + Self-Evolving Agents + EvoScientist
>
> **[2026-04-17 상태] Part 1~4 기능 구현 완료 (분산 구현)**
> - Part 1(n8n→parallel-collector.ts 병렬 수집) ✅
> - Part 2(Agentic RAG: agentic-rag.ts, rag-accumulator.ts 5500줄) ✅
> - Part 3(Outer Loop: performance-diagnostician.ts, strategy-evolver.ts) ✅
> - Part 4(Inner Loop): self-improving-pipeline.ts 단일 파일은 없으나 기능이 분산 구현됨
>   (blo.ts + loadLatestStrategy() + feedback-learner + autonomy-gate + quality-checker)
>   weekly: revenue-strategy-updater.ts → evolveStrategy() → latest-strategy.json → blo.ts
> - 데이터 축적 진행 중 (1개월 이상 필요)

---

## 연구 인사이트 (2026!)

```
1. Agentic RAG = 파이프라인 → 루프!
   "검색 → 평가 → 불충분하면 재검색 → 도구 호출 → 검증"
   결정 포인트가 핵심 가치!
   (ByteByteGo: "decision points are the entire value add")

2. Self-Correcting RAG!
   AI가 검색 결과를 평가 → "쓰레기"면 → 쿼리 재구성 → 재검색!
   Corrective RAG (CRAG): 자체 검색 결과 비판!

3. EvoScientist 패턴!
   Researcher Agent: 아이디어 생성!
   Engineer Agent: 실험 구현!
   Evolution Manager: 이전 상호작용에서 통찰 추출 → 재사용!
   = 팀 제이 3역할(제이/메티/코덱스)과 유사!

4. Self-Improving Pipeline (FareedKhan-dev/autonomous-agentic-rag)!
   Inner Loop: 멀티에이전트 RAG 파이프라인!
   Outer Loop: 평가 → 진단 → SOP 돌연변이 → 파레토 최적!
   performance_diagnostician = 닥터!
   SOP Architect = 진화 관리자!

5. Memory Self-Iteration (OpenViking)!
   세션 종료 → 실행 결과+피드백 비동기 분석!
   → User Memory + Agent Experience 자동 갱신!
   = "쓰면 쓸수록 똑똑해짐"!

6. Naive RAG는 죽었다!
   2026 = Modular + Agentic RAG!
   반복적 + 자기수정적! 단발성 검색 → 의사결정 루프!
```

---

## 현재 vs 목표

```
현재 (3시스템 분리!):
  n8n: 미사용! (pipeline_store 8건!)
  RAG: richer.js만 사용! (단발 검색!)
  포스팅: 단일 프롬프트 → 품질체크 → 발행!
  = 피드백 없음! 진화 없음! 학습 없음!

목표 (자기진화 파이프라인!):
  n8n → "오케스트레이션 허브" (병렬 수집 + 스케줄 + 품질 게이트!)
  RAG → "Agentic RAG" (루프 + 자기수정 + 경험 축적!)
  포스팅 → "Inner Loop" (다단계 파이프라인!)
  + "Outer Loop" (성과 분석 → 전략 진화!)
  = 매 포스팅이 다음 포스팅을 개선!
```

---

## 아키텍처: 이중 루프 (Inner + Outer!)

```
┌─────────── Outer Loop (주간 진화!) ───────────┐
│                                                │
│  성과 수집 → 진단 → 전략 돌연변이 → 적용!    │
│  collect-performance → diagnostician           │
│  → strategy-evolver → config 업데이트!        │
│                                                │
│  ┌──── Inner Loop (매일 포스팅!) ────┐        │
│  │                                    │        │
│  │  주제 선정 (Agentic!)             │        │
│  │    ↓                               │        │
│  │  연구 수집 (RAG + 웹!)            │        │
│  │    ↓                               │        │
│  │  초안 작성 (에이전트 경쟁!)       │        │
│  │    ↓                               │        │
│  │  품질 검증 ──→ 불합격? → 수정!   │        │
│  │    ↓                               │        │
│  │  편집 + 발행!                      │        │
│  │    ↓                               │        │
│  │  결과 기록 → RAG 저장!            │        │
│  │    ↓                               │        │
│  │  경험 축적 → event_lake!          │        │
│  │                                    │        │
│  └────────────────────────────────────┘        │
│                                                │
└────────────────────────────────────────────────┘
```

---

## Part 1: n8n → 오케스트레이션 허브!

### 현재 n8n 문제!
```
워크플로우 존재하지만 미사용!
blo.js가 모든 걸 순차 실행!
n8n의 병렬 실행, 스케줄, 에러 핸들링 활용 안 됨!
```

### 재설계: n8n = 품질 게이트 + 병렬 수집!

```
n8n 활용 방안 2가지:

방안 A (추천!): n8n 제거, Node.js로 통합!
  이유: n8n 자격증명 에러 미해결!
  이유: blo.js에서 Promise.all 병렬 가능!
  이유: 시스템 복잡도 감소!
  → n8n launchd 해제!
  → 병렬 수집을 blo.js Promise.all로!

방안 B: n8n 부활!
  이유: 시각적 워크플로우!
  이유: 에러 재시도 내장!
  → 자격증명 에러 해결 필요!
  → webhook 경유 파이프라인!

★ 마스터 결정 필요! (A 추천!)
```

### Task 1-1: 병렬 수집 (n8n 대체!)

```javascript
// bots/blog/lib/parallel-collector.ts (신규!)
// n8n의 병렬 수집을 Node.js로!

async function collectAllResearch(category, topic) {
  const [weather, itNews, ragExperiences, relatedPosts, trendData] =
    await Promise.allSettled([
      collectWeather(),
      collectITNews(topic),
      searchRagExperiences(topic),
      searchRelatedPosts(topic),
      collectTrendData(category),
    ]);

  return {
    weather: weather.status === 'fulfilled' ? weather.value : null,
    itNews: itNews.status === 'fulfilled' ? itNews.value : [],
    ragExperiences: ragExperiences.status === 'fulfilled' ? ragExperiences.value : [],
    relatedPosts: relatedPosts.status === 'fulfilled' ? relatedPosts.value : [],
    trendData: trendData.status === 'fulfilled' ? trendData.value : null,
    collectedAt: new Date().toISOString(),
    failedSources: [weather, itNews, ragExperiences, relatedPosts, trendData]
      .filter(r => r.status === 'rejected')
      .map((r, i) => ({ source: ['weather','itNews','rag','posts','trend'][i], error: r.reason?.message })),
  };
}
```

---

## Part 2: RAG → Agentic RAG!

### 현재 RAG 문제!
```
단발 검색! 검색 결과 평가 없음!
검색 실패 시 → 빈 결과 그대로 사용!
발행 후 경험 축적 미흡! (rag_blog 77건!)
= "Naive RAG" 상태!
```

### 재설계: Self-Correcting Agentic RAG!

```javascript
// bots/blog/lib/agentic-rag.ts (신규!)
// 검색 → 평가 → 불충분하면 재검색!

async function agenticSearch(topic, category, maxRetries = 3) {
  let context = { episodes: [], relatedPosts: [], quality: 0 };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Step 1: 검색!
    const results = await searchRealExperiences(topic);
    const posts = await searchRelatedPosts(topic);

    // Step 2: 검색 결과 평가!
    const evaluation = evaluateSearchResults(results, posts, topic);

    if (evaluation.sufficient) {
      context = { episodes: results, relatedPosts: posts, quality: evaluation.score };
      console.log(`[AgenticRAG] 충분! (${evaluation.score}점, 시도 ${attempt + 1})`);
      break;
    }

    // Step 3: 불충분! 쿼리 재구성!
    console.log(`[AgenticRAG] 불충분 (${evaluation.score}점) → 쿼리 재구성!`);
    topic = await reformulateQuery(topic, evaluation.gaps);
  }

  // Step 4: 여전히 부족하면 웹 검색 폴백!
  if (context.quality < 0.5) {
    console.log('[AgenticRAG] RAG 부족 → 웹 검색 폴백!');
    // 추후 구현: 웹 검색으로 보충!
  }

  return context;
}

function evaluateSearchResults(episodes, posts, topic) {
  let score = 0;
  const gaps = [];

  // 에피소드 수!
  if (episodes.length >= 3) score += 0.3;
  else gaps.push(`에피소드 부족 (${episodes.length}/3)`);

  // 관련 포스팅!
  if (posts.length >= 2) score += 0.2;
  else gaps.push(`관련 포스팅 부족 (${posts.length}/2)`);

  // 주제 관련성!
  const relevant = episodes.filter(e =>
    e.content && topic.split(/\s+/).some(w => e.content.includes(w))
  );
  if (relevant.length >= 2) score += 0.3;
  else gaps.push(`주제 관련성 낮음 (${relevant.length}/${episodes.length})`);

  // 다양성!
  const sources = new Set(episodes.map(e => e.source));
  if (sources.size >= 2) score += 0.2;
  else gaps.push(`소스 다양성 부족 (${sources.size}종)`);

  return { sufficient: score >= 0.6, score, gaps };
}

async function reformulateQuery(originalTopic, gaps) {
  // 갭에 따라 쿼리 확장!
  const expansions = {
    '에피소드 부족': '실전 사례 운영 경험 트러블슈팅',
    '관련 포스팅 부족': '블로그 시리즈 연결',
    '주제 관련성 낮음': originalTopic.split(/\s+/).slice(0, 2).join(' '),
    '소스 다양성 부족': `${originalTopic} 기술 운영 비즈니스`,
  };
  const expansion = gaps.map(g => {
    const key = Object.keys(expansions).find(k => g.includes(k));
    return key ? expansions[key] : '';
  }).filter(Boolean).join(' ');

  return `${originalTopic} ${expansion}`.trim();
}
```

### 발행 후 RAG 자동 축적!

```javascript
// bots/blog/lib/rag-accumulator.ts (신규!)
// 매 발행 후 RAG에 자동 저장!

async function accumulatePostExperience(post, quality, performance) {
  const rag = require('rag-safe');

  // 1. 포스팅 내용 → rag_blog!
  await rag.store('blog', `[${post.category}] ${post.title}\n${post.content.slice(0, 500)}`, {
    category: post.category,
    postType: post.postType,
    writerName: post.writerName,
    charCount: post.charCount,
    qualityScore: quality.score,
  });

  // 2. 품질 결과 → rag_experience!
  await rag.store('experience', JSON.stringify({
    action: 'blog_post_published',
    topic: post.title,
    category: post.category,
    writer: post.writerName,
    quality: quality,
    aiPatterns: quality.aiPatterns || [],
    timestamp: new Date().toISOString(),
  }), {
    type: 'blog_quality',
    category: post.category,
  });

  // 3. event_lake 기록!
  const eventLake = require('event-lake');
  await eventLake.record({
    eventType: 'blog_post_published',
    team: 'blog',
    agent: post.writerName,
    summary: `${post.category} 발행: ${post.title}`,
    details: {
      charCount: post.charCount,
      qualityScore: quality.score,
      aiRisk: quality.aiRisk,
      writerName: post.writerName,
    },
    why: `${post.writerName}가 ${post.category} 카테고리에서 ${post.charCount}자 포스팅 발행`,
  });

  console.log(`[RAG] 경험 축적 완료: ${post.title}`);
}
```

---

## Part 3: Outer Loop — 성과 분석 → 전략 진화!

### 핵심: 매주 자동으로 포스팅 전략이 진화!

```
주간 사이클:
  월: 지난주 성과 수집! (조회수, 공감, 댓글!)
  화: 성과 진단! (어떤 카테고리/작가/제목이 잘 됐는지!)
  수: 전략 돌연변이! (잘 된 패턴 강화 + 안 된 패턴 약화!)
  목~일: 개선된 전략으로 포스팅!
```

### Task 3-1: 성과 진단 에이전트 (Diagnostician!)

```javascript
// bots/blog/lib/performance-diagnostician.ts (신규!)
// EvoScientist의 Evolution Manager 패턴!

async function diagnoseWeeklyPerformance() {
  // 1. 지난주 포스팅 수집!
  const posts = await getRecentPosts(null, 7);
  const performance = await getPerformanceData(posts);

  // 2. 차원별 분석!
  const analysis = {
    // 카테고리별 성과!
    byCategory: groupAndScore(performance, 'category'),
    // 작가별 성과!
    byWriter: groupAndScore(performance, 'writerName'),
    // 제목 패턴별 성과!
    byTitlePattern: analyzeTitlePatterns(performance),
    // 시간대별 성과!
    byPublishTime: analyzePublishTimes(performance),
    // 글 길이별 성과!
    byLength: analyzeLengthCorrelation(performance),
  };

  // 3. 진단! (primary_weakness 식별!)
  const diagnosis = {
    bestCategory: findBest(analysis.byCategory),
    worstCategory: findWorst(analysis.byCategory),
    bestWriter: findBest(analysis.byWriter),
    bestTitlePattern: findBest(analysis.byTitlePattern),
    primaryWeakness: identifyPrimaryWeakness(analysis),
    rootCause: analyzeRootCause(analysis),
    recommendations: generateRecommendations(analysis),
  };

  // 4. event_lake 기록!
  await eventLake.record({
    eventType: 'blog_weekly_diagnosis',
    team: 'blog',
    agent: 'diagnostician',
    summary: `주간 진단: 최고 ${diagnosis.bestCategory} / 최저 ${diagnosis.worstCategory}`,
    details: diagnosis,
    why: `${diagnosis.primaryWeakness} 개선 필요`,
  });

  return diagnosis;
}
```

### Task 3-2: 전략 진화 에이전트 (Strategy Evolver!)

```javascript
// bots/blog/lib/strategy-evolver.ts (신규!)
// "SOP 돌연변이" 패턴!

async function evolveStrategy(diagnosis) {
  const currentConfig = getConfig();
  const blogStrategy = currentConfig.blog || {};

  // 1. 잘 된 패턴 강화!
  if (diagnosis.bestWriter) {
    // 최고 작가의 고용 점수 boost!
    await adjustAgentScore(diagnosis.bestWriter, +0.5);
  }

  // 2. 안 된 패턴 약화!
  if (diagnosis.worstCategory) {
    // 최저 카테고리의 제목 풀 교체!
    await refreshCategoryTitlePool(diagnosis.worstCategory);
  }

  // 3. 제목 프레임 진화!
  if (diagnosis.bestTitlePattern) {
    // 성과 좋은 제목 패턴을 우선 순위에!
    await promoteTitleFrame(diagnosis.bestTitlePattern);
  }

  // 4. 카테고리 순환 가중치 조정!
  // 성과 좋은 카테고리 빈도↑, 나쁜 카테고리 빈도↓!
  await adjustCategoryWeights(diagnosis.byCategory);

  // 5. RAG에 진화 결과 저장!
  await rag.store('experience', JSON.stringify({
    action: 'strategy_evolved',
    diagnosis: diagnosis.primaryWeakness,
    changes: diagnosis.recommendations,
    timestamp: new Date().toISOString(),
  }), { type: 'strategy_evolution' });

  // 6. event_lake!
  await eventLake.record({
    eventType: 'blog_strategy_evolved',
    team: 'blog',
    agent: 'strategy-evolver',
    summary: `전략 진화: ${diagnosis.recommendations.length}건 적용`,
    details: { diagnosis, changes: diagnosis.recommendations },
    why: `${diagnosis.primaryWeakness} 해결을 위한 전략 조정`,
  });

  console.log(`[진화] 전략 업데이트 완료! ${diagnosis.recommendations.length}건`);
}
```

### Task 3-3: 주간 진화 스케줄!

```javascript
// bots/blog/scripts/weekly-evolution.ts (신규!)
// 매주 월요일 실행! (Elixir Quantum 스케줄!)

async function weeklyEvolution() {
  console.log('[진화] 주간 블로팀 전략 진화 시작!');

  // 1. 성과 수집!
  const performance = await collectWeeklyPerformance();

  // 2. 진단!
  const diagnosis = await diagnoseWeeklyPerformance();

  // 3. 전략 진화!
  await evolveStrategy(diagnosis);

  // 4. 텔레그램 리포트!
  await postAlarm({
    message: `📊 블로팀 주간 진화 리포트!
최고 카테고리: ${diagnosis.bestCategory}
최저 카테고리: ${diagnosis.worstCategory}
최고 작가: ${diagnosis.bestWriter}
핵심 약점: ${diagnosis.primaryWeakness}
적용 변경: ${diagnosis.recommendations.length}건`,
    team: 'blog',
    fromBot: 'strategy-evolver',
  });
}
```

---

## Part 4: Inner Loop — 매일 포스팅 자기수정!

### 포스팅 파이프라인 전체!

```javascript
// bots/blog/lib/self-improving-pipeline.ts (신규!)
// Inner Loop: 주제→연구→작성→검증→수정→발행→학습!

async function runSelfImprovingPipeline(category, context) {
  // ── Stage 1: 주제 선정 (Agentic!) ──
  const topic = await selectAndValidateTopic(category, context.recentPosts);
  console.log(`[파이프] 주제: ${topic.title}`);

  // ── Stage 2: 연구 수집 (Agentic RAG!) ──
  const research = await agenticSearch(topic.title, category);
  console.log(`[파이프] 연구: ${research.episodes.length}건, 품질 ${research.quality}`);

  // ── Stage 3: 작가 고용 + 초안! ──
  const writer = await selectBestAgent('writer', 'blog', { taskHint: topic.title });
  const draft = await runWriter(writer?.name || 'gems', { topic, research, context });
  console.log(`[파이프] 초안: ${writer?.name} (${draft.charCount}자)`);

  // ── Stage 4: 품질 검증 (자기수정 루프!) ──
  let finalDraft = draft;
  let quality = await checkQualityEnhanced(draft.content, 'general', {});
  let retries = 0;

  while (!quality.passed && retries < 2) {
    console.log(`[파이프] 품질 미달 → 수정 시도 ${retries + 1}!`);
    // RAG에서 비슷한 실패 경험 검색!
    const failureExperience = await rag.search('experience',
      `blog_quality_failed ${quality.issues?.join(' ')}`, { limit: 2 });
    // 수정 지시에 실패 경험 반영!
    finalDraft = await repairDraft(finalDraft, quality, failureExperience);
    quality = await checkQualityEnhanced(finalDraft.content, 'general', {});
    retries++;
  }

  // ── Stage 5: 편집! ──
  const editor = await selectBestAgent('editor', 'blog', { taskHint: topic.title });
  const edited = await runEditor(editor?.name || 'hooker', finalDraft);

  // ── Stage 6: 발행! ──
  const published = await publish(edited, context);

  // ── Stage 7: 경험 축적! (피드백 루프 완성!) ──
  await accumulatePostExperience(edited, quality, {
    topic: topic.title,
    writerName: writer?.name,
    editorName: editor?.name,
    retries,
    ragQuality: research.quality,
  });

  return published;
}
```

---

## 통합 데이터 흐름!

```
매일 (Inner Loop!):
  주제 선정 → Agentic RAG 검색 → 작가 고용 → 초안!
  → 품질 검증 ──→ 실패? → RAG에서 실패 경험 검색 → 수정!
  → 편집 → 발행!
  → rag_blog 저장 + rag_experience 저장 + event_lake!
  
  데이터 축적: 매일 +3건! (blog + experience + event!)

매주 (Outer Loop!):
  성과 수집 (조회수/공감!) → 진단!
  → 전략 돌연변이 (작가 점수 / 카테고리 가중치 / 제목 패턴!)
  → config 업데이트!
  → 다음 주 Inner Loop에 반영!

  진화 축적: 매주 +1건! (strategy_evolution!)

매월:
  RAG 경험 100건+ 축적!
  event_lake 포스팅 이벤트 30건+!
  전략 진화 4회+!
  = 시스템이 스스로 개선 방향을 찾음!
```

---

## 테스트 체크리스트!

```
Part 1 (n8n 정리!):
  [ ] n8n launchd 해제 (방안 A 선택 시!)
  [ ] parallel-collector.ts Promise.all!
  [ ] 병렬 수집 5소스 동시!

Part 2 (Agentic RAG!):
  [ ] agentic-rag.ts 검색 → 평가 → 재검색!
  [ ] evaluateSearchResults 다차원 평가!
  [ ] reformulateQuery 쿼리 재구성!
  [ ] rag-accumulator.ts 발행 후 자동 저장!
  [ ] rag_blog 축적 확인!

Part 3 (Outer Loop!):
  [ ] performance-diagnostician.ts 진단!
  [ ] strategy-evolver.ts 전략 돌연변이!
  [ ] weekly-evolution.ts 주간 스케줄!
  [ ] 텔레그램 진화 리포트!

Part 4 (Inner Loop!):
  [ ] self-improving-pipeline.ts 전체!
  [ ] 품질 미달 → RAG 경험 검색 → 수정!
  [ ] 경험 축적 완전 자동!

통합:
  [ ] 7일 연속 발행 → RAG 21건+ 축적!
  [ ] 주간 진화 1회 실행!
  [ ] 다음 주 포스팅에 진화 반영!
  [ ] 커밋: "feat(blog): 자기진화 파이프라인!"
```

---

## 실행 순서!

```
1단계: Part 1 (n8n 정리!) — 즉시!
2단계: Part 2 (Agentic RAG!) — 핵심!
3단계: Part 4 (Inner Loop!) — 통합!
4단계: Part 3 (Outer Loop!) — 주간 진화!
5단계: 1개월 운영 → 데이터 축적 → 진화 확인!
```
