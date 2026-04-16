# 블로팀 통합 구현 계획 — 10단계!

> 메티 | 2026-04-10 | OPS 구현
> 현황: TS경로수정 완료! Draw Things 전환 완료! Phase 1~8 구현 완료! 숏폼 MP4 1차 렌더 완료! 경쟁 OFF(config), 로컬 실행 경로 안정화!
> 핵심: 주제다양화 + 페르소나 + RAG Agentic화 + 자기진화 + 썸네일1장 + 인스타숏폼 + ffmpeg 렌더!
> 원칙: 경쟁 시스템 = config.yaml 토글 (당분간 OFF!)
>
> **[2026-04-17 상태] Phase 0~9 실질 완료 (모든 기능 분산 구현)**
> - Phase 1~8(Elixir 전환, 경쟁 토글, 페르소나, 주제다양화, RAG, 자기진화, 썸네일 1장) ✅
> - Phase 9 기능: video-gen → star.ts(shortform-renderer.ts ffmpeg), insta-uploader → insta-crosspost.ts ✅
>   - CODEX_BLOG_IMAGE_REDESIGN.md 분석 결과 모든 Part(A/B/C) 확인 → archive 이동 완료
> - 자율 루프(autonomous-ops Phase A~D) ✅ — archive 이동 완료
> - 남은 작업: Meta 실업로드 운영 검증 (공개 URL 파이프라인 완성 후)

---

## 세션 진행 상태 (2026-04-10 업데이트!)

### ✅ 완료!
- Phase 0: TS 경로 수정 (__dirname → PROJECT_ROOT!) — 코덱스 완료!
- Phase 1: TS 실전환 완료! — `.ts` 우선 로드 + 블로그 전용 typecheck 추가!
- Phase 2: 로컬 실행 경로 정리! — `run-daily --verify/--dry-run`, 병렬 수집, n8n 기본 비활성화!
- Phase 3: 경쟁 토글 완료! — `competition.enabled=false` 설정 기반 반영!
- Phase 4: 주제 사전 검토 + 제목 다양화 완료!
- Phase 5: 작가/편집자 페르소나 주입 완료!
- Phase 6: Agentic RAG 루프 + 발행 전 연구 반복 검색 완료!
- Phase 7: 주간 전략 진화 + weekly-evolution 자동화 완료!
- Phase 8: Draw Things 전환 완료! ComfyUI → Draw Things (localhost:7860!)
  - Draw Things 로그인 자동실행 등록!
  - ComfyUI plist.disabled 비활성화!
  - 블로그팀 런타임 반영 (ai.blog.daily, ai.blog.node-server!)
  - 썸네일 1장 전용 생성 완료! (mid 제거, 클릭 유도형!)
  - 네이버 포스팅 HTML mid 삽입 제거 완료!
  - 숏폼 준비 파이프라인 완료! (기획 JSON + 캡션 + ffmpeg 초안!)
  - ffmpeg 설치 완료! (`ffmpeg 8.1`)
  - 숏폼 MP4 1차 렌더 완료!
  - 인스타 릴스 업로드 스캐폴드 + Hub secret 연동 완료!
- .claude/rules/ 4파일 생성! (security/coding-style/git-workflow/team-jay!)
- docs/strategy/ECC_APPLICATION_GUIDE.md (434줄!) — ECC+Hermes 적용!
- docs/codex/CODEX_BLOG_IMAGE_REDESIGN.md (534줄!) — 썸네일+숏폼+자동등록!
- CLAUDE.md 최신 운영 상태 반영 완료!
- .claude/hooks/hooks.json + blog hooks 스크립트 골격 완료!

### 🔲 대기!
- Phase 9: 인스타 자동 등록!
  - 마스터 선행: Meta Developer 앱 등록 → Instagram Business 연결 → 토큰 발급!
  - secrets-store.json에 instagram 섹션 추가! (access_token + ig_user_id!)
  - 확인: `npm --prefix bots/blog run check:instagram -- --json` → ready: true!
- 숏폼 강화: 자막/BGM/오버레이 + 텍스트 모션!
- Phase 7 확장: 전략 결과를 강의 글/편집 2차 루프까지 확대!
- 블로팀 JS→TS 실전환: @ts-nocheck 제거 + import/타입 추가! (CODEX_BLOG_TS_CONVERSION.md 참조!)
- .legacy.js 정리: 1주 안정 운영 후 삭제 검토!

### ❌ 실패한 접근 (반복 금지!)
- 128GB 기준 모델 추천 → 32GB에서 OOM! → 양자화 모델 필수!
- .legacy.js 기준 분석 → .ts 코드와 불일치! → 반드시 .ts 기준!
- P1~P2 이슈 이미 코덱스가 수정 완료 → .ts 확인 없이 미수정 판단 금지!

### 📋 결정 사항!
- Draw Things 전용! ComfyUI OFF!
- 32GB: FLUX.1 schnell 1순위, 양자화 필수!
- 경쟁 시스템 = 기본 OFF, config 토글만 유지!
- 썸네일 1장! (mid 제거, 클릭 유도형!)
- 인스타: 카드 → 숏폼 릴스!
- 숏폼 렌더는 ffmpeg 우선! (이미 1차 MP4 렌더 완료!)
- Qwen Image 한글 = 맥스튜디오 업그레이드(64GB+) 후!

---

## 전체 구조: 이중 루프 자기진화!

```
┌──── Outer Loop (매주!) ────────────────┐
│  성과수집 → 진단 → 전략진화 → 적용!  │
│  ┌── Inner Loop (매일!) ──────────┐   │
│  │ 주제선정(Agentic!)            │   │
│  │  → 연구수집(Agentic RAG!)     │   │
│  │  → 작가고용(페르소나!)        │   │
│  │  → 품질검증(자기수정!)        │   │
│  │  → 편집 → 발행!              │   │
│  │  → RAG축적 + event_lake!     │   │
│  └────────────────────────────────┘   │
└────────────────────────────────────────┘
```

---

## Phase 0: TS 전환 긴급 수정! (P1+P2 4건!)

### 근본 원인: dist/ts-runtime에서 __dirname 변경!

```
TS 전환 후 실행 경로가 바뀜:
  기존: bots/blog/lib/publ.js → __dirname = bots/blog/lib/
  현재: dist/ts-runtime/bots/blog/lib/publ.js → __dirname = dist/ts-runtime/bots/blog/lib/

→ ../output, ../config.json, ../context/ 등 상대 경로가 전부 깨짐!
→ dist/ts-runtime/bots/blog/ 에는 output/config.json/context/ 없음!
```

### Task 0-1: [P1] __dirname → PROJECT_ROOT 재고정!

```javascript
// 영향 파일: publ.ts, runtime-config.ts, seed-curriculum.ts, setup-blog-workflows.ts
// 패턴: __dirname 기반 상대 경로 → env.PROJECT_ROOT 기반 절대 경로!

// 기존 (깨진!):
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const CURRICULUM_PATH = path.join(__dirname, '..', 'context', 'curriculum.txt');
const WORKFLOW_PATH = path.join(__dirname, '..', 'api', 'n8n-workflow.json');

// 수정:
const env = require('../../../packages/core/lib/env');
const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');

const OUTPUT_DIR = path.join(BLOG_ROOT, 'output');
const CONFIG_PATH = path.join(BLOG_ROOT, 'config.json');
const CURRICULUM_PATH = path.join(BLOG_ROOT, 'context', 'curriculum.txt');
const WORKFLOW_PATH = path.join(BLOG_ROOT, 'api', 'n8n-workflow.json');
```

### 영향 파일 전수 목록!

```
publ.ts (L18!):
  OUTPUT_DIR = path.join(__dirname, '..', 'output')
  → path.join(BLOG_ROOT, 'output')

runtime-config.ts (L8!):
  CONFIG_PATH = path.join(__dirname, '..', 'config.json')
  → path.join(BLOG_ROOT, 'config.json')

seed-curriculum.ts (L23!):
  CURRICULUM_PATH = path.join(__dirname, '..', 'context', 'curriculum.txt')
  → path.join(BLOG_ROOT, 'context', 'curriculum.txt')

setup-blog-workflows.ts (L20!):
  WORKFLOW_PATH = path.join(__dirname, '..', 'api', 'n8n-workflow.json')
  → path.join(BLOG_ROOT, 'api', 'n8n-workflow.json')

추가 확인! __dirname 사용하는 모든 파일:
  grep -rn "__dirname" bots/blog/ --include="*.ts" --include="*.legacy.js"
  → 모든 건을 env.PROJECT_ROOT 기반으로!
```

### Task 0-2: [P2] Commenter 테스트 모드 완화!

```javascript
// bots/blog/lib/commenter.ts (L262~343!)
// connectBrowser가 managed browser 없으면 throw!
// 테스트 모드에서는 skip 가능하게!

// 기존:
async function connectBrowser() {
  // managed browser 연결 시도 → 실패 시 throw!
}

// 수정: testMode일 때 graceful skip!
async function connectBrowser(options = {}) {
  if (options.testMode) {
    try {
      // 연결 시도!
      return await _connectManaged();
    } catch (e) {
      console.warn('[댓글] 테스트 모드: 브라우저 없음 → 스킵!');
      return null;  // null이면 하위 로직에서 스킵!
    }
  }
  return await _connectManaged();  // 운영 모드: 기존대로!
}

// run-commenter.ts에서:
if (process.env.BLOG_COMMENTER_TEST === 'true') {
  const browser = await connectBrowser({ testMode: true });
  if (!browser) {
    console.log('[댓글] 테스트 완료: 브라우저 없이 구조 검증만!');
    process.exit(0);
  }
}
```

### Task 0-3: [P2] collect-views 추출 강화!

```javascript
// bots/blog/scripts/collect-views.ts (L31~49!)
// 현재: 조회수/댓글/공감 정규식이 네이버 마크업 변경에 취약!
// views=0, source=puppeteer_zero 반환!

// 강화: 다중 추출 전략!
async function extractViews(page) {
  // 전략 1: 기존 정규식!
  let views = await tryRegexExtract(page);
  if (views > 0) return { views, source: 'regex' };

  // 전략 2: 네이버 블로그 API 직접 호출!
  views = await tryNaverApiExtract(page);
  if (views > 0) return { views, source: 'naver_api' };

  // 전략 3: 메타 태그에서!
  views = await tryMetaTagExtract(page);
  if (views > 0) return { views, source: 'meta' };

  // 전략 4: 셀렉터 기반!
  views = await trySelectorsExtract(page, [
    '.blog_count .count',           // 네이버 블로그 조회수!
    '[data-type="view"] .count',    // 대체 셀렉터!
    '.post_title .count',           // 또 다른 대체!
    'span.pcol1',                   // 레거시!
  ]);
  if (views > 0) return { views, source: 'selector' };

  return { views: 0, source: 'puppeteer_zero' };
}
```

### 검증!

```bash
# Task 0-1 검증!
node -e "const p = require('./bots/blog/lib/publ'); console.log('publ OK')"
node -e "const r = require('./bots/blog/lib/runtime-config'); console.log(r)"
node bots/blog/scripts/health-report.js --json  # "파일 없음" 경고 해소!

# Task 0-2 검증!
BLOG_COMMENTER_TEST=true node bots/blog/scripts/run-commenter.js
# → "테스트 완료: 브라우저 없이 구조 검증만!" (에러 아님!)

# Task 0-3 검증!
node bots/blog/scripts/collect-views.js --dry-run --json --limit=1
# → views > 0 또는 source !== 'puppeteer_zero'!

# 전체!
node bots/blog/scripts/health-check.js  # 통과!
```

```
[ ] __dirname → PROJECT_ROOT 전수 수정!
[ ] health-report "파일 없음" 경고 해소!
[ ] commenter 테스트 모드 graceful skip!
[ ] collect-views 다중 추출 전략!
[ ] 커밋: "fix(blog): TS 전환 경로 수정 + 테스트/추출 강화!"
```

---

## Phase 1: TS 실전환 완료! (진행중!)

### 현재: .ts = @ts-nocheck 복사본, .js = shim, .legacy.js = 실 로직!

```
패턴: 각 파일마다!
1. .legacy.js 내용 → .ts에 통합! (@ts-nocheck 유지!)
2. .legacy.js → .backup.js 리네임!
3. .js shim → .ts require로 수정!
4. tsx 실행 확인!

순서 (큰 파일부터!):
  blo(1041) → commenter(859) → publ(567) → curriculum(565)
  → richer(440) → maestro(405) → img-gen(386) → star(284)
  → quality-checker(278) → social(232) → 나머지!

scripts/ 14파일도 동일!
```

### 검증!
```
[ ] 모든 .legacy.js → .ts 통합!
[ ] npm run typecheck 통과!
[ ] tsx bots/blog/scripts/run-daily.ts 실행!
```

---

## Phase 2: Elixir 전환 + n8n 정리!

### 2-A: BlogShadow → BlogSupervisor!

```elixir
# blog_supervisor.ex (신규! shadow 교체!)
defmodule TeamJay.Teams.BlogSupervisor do
  use Supervisor
  @blog_agents [
    %{name: :blog_daily, script: "bots/blog/scripts/run-daily.js",
      schedule: {:cron, "0 6 * * *"}, team: "blog"},
    %{name: :blog_commenter, script: "bots/blog/scripts/run-commenter.js",
      schedule: {:cron, "0 12 * * *"}, team: "blog"},
    %{name: :blog_collect_performance, script: "bots/blog/scripts/collect-performance.js",
      schedule: {:cron, "0 20 * * *"}, team: "blog"},
    %{name: :blog_collect_competition, script: "bots/blog/scripts/collect-competition-results.js",
      schedule: {:cron, "0 21 * * *"}, team: "blog"},
    %{name: :blog_health_check, script: "bots/blog/scripts/health-check.js",
      schedule: {:interval, 600_000}, team: "blog"},
    %{name: :blog_node_server, script: "bots/blog/api/node-server.js",
      schedule: :once, team: "blog"},
  ]
  # ... PortAgent children! (Phase 3 Week1과 동일 패턴!)
end
```

```bash
# application.ex: BlogShadowSupervisor → BlogSupervisor!
# launchd 비활성화! (ComfyUI만 유지!)
for p in ~/Library/LaunchAgents/ai.blog.*.plist; do
  [ "$(basename $p)" != "ai.blog.comfyui.plist" ] && launchctl unload "$p"
done
launchctl kickstart -k gui/$(id -u)/ai.elixir.supervisor
```

### 2-B: n8n 정리! (방안 A: 제거!)

```
현재: n8n 가동 중이지만 실제 사용 0! (pipeline_store 8건!)
결정: n8n 블로팅 경로 제거 + Promise.all 병렬 수집!

1. blo.js에서 n8nTriggered 분기 제거!
2. n8n launchd 유지 (다른 팀 사용 가능!)
3. 병렬 수집 함수 추가!
```

```javascript
// bots/blog/lib/parallel-collector.ts (신규!)
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
  };
}
```

### 검증!
```
[ ] BlogSupervisor 6에이전트!
[ ] n8nTriggered 분기 제거!
[ ] parallel-collector Promise.all!
```

---

## Phase 3: 경쟁 시스템 config 토글!

```yaml
# config.yaml 추가!
blog:
  competition:
    enabled: false          # ★ 당분간 OFF!
    days: [1, 3, 5]
    min_writers: 2
```

```javascript
// maestro.legacy.js (또는 .ts!) 수정!
// 기존 하드코딩:
// const COMPETITION_ENABLED = true;
// 수정:
const { getConfig } = require('runtime-config');
function isCompetitionEnabled() {
  const comp = getConfig()?.blog?.competition || {};
  if (!comp.enabled) return false;
  return (comp.days || [1,3,5]).includes(new Date().getDay());
}
```

### 재가동 조건!
```
✅ "왜...~일까" 제목 0건!
✅ 에이전트별 스타일 차이 확인!
✅ 품질 통과율 90%+!
✅ 10건+ 안정 발행 후!
→ config.yaml에서 enabled: true!
```

---

## Phase 4: 주제 사전 검토 + 제목 다양화! (긴급!)

### 현재 문제: 100% "왜...~일까" 패턴!

```javascript
// bots/blog/lib/topic-selector.ts (신규!)
async function selectAndValidateTopic(category, recentPosts) {
  const recentTitles = recentPosts.map(p => p.title);

  // 금지 패턴!
  const banned = [/^왜\s/, /보다.*더.*(중요|먼저)/, /[일할될겠]까\s*$/];

  // 프레임 템플릿 12+!
  const FRAMES = [
    '{주제}을 시작하기 전에 반드시 점검해야 할 3가지',
    '{주제}, 지금 바꾸지 않으면 늦는 이유',
    '직접 해보고 깨달은 {주제}의 진짜 핵심',
    '3개월간 {주제}를 운영하며 배운 것들',
    '{A} vs {B}: 실무자가 선택하는 기준',
    '2026년 {주제} 트렌드: 달라진 것과 변하지 않는 것',
    '{주제}을 위한 체크리스트 7가지',
    '{주제}에서 막힐 때 가장 먼저 확인할 포인트',
    '{숫자}가지 {주제} 실전 노하우',
    '{기간} 만에 {주제}로 {결과}를 만든 과정',
    '{주제}에서 초보자가 가장 먼저 실수하는 것',
    '{주제}를 도입한 뒤 달라진 일상',
  ];

  // LLM에게 후보 3개 요청 + 검증!
  const topicPrompt = `
카테고리: ${category}
[최근 발행 — 유사 금지!]
${recentTitles.slice(0,10).map((t,i) => `${i+1}. ${t}`).join('\n')}

[절대 금지!] "왜...일까" / "A보다B가더중요" / 카테고리명 시작 / 50자 초과!
[프레임 참고] ${FRAMES.slice(0,5).join(' | ')}

서로 다른 스타일의 제목+주제 3개! JSON: [{"title":"...","question":"...","diff":"..."}]`;

  const result = await callWithFallback({...});
  const candidates = JSON.parse(result.text);

  // 검증: 금지 패턴 + 유사도!
  return candidates.filter(c => {
    if (banned.some(r => r.test(c.title))) return false;
    if (c.title.length > 50) return false;
    if (recentTitles.some(r => similarity(r, c.title) > 0.4)) return false;
    return true;
  })[0] || { title: `${category} 실전 가이드`, forced: true };
}
```

### 카테고리별 제목 풀!

```javascript
// bots/blog/lib/title-diversity.ts (신규!)
const CATEGORY_TITLE_POOL = {
  '홈페이지와App': [
    '회원가입 완료율을 2배로 올린 온보딩 개선 사례',
    '모바일 로딩 3초의 법칙: 실제 이탈률 데이터',
    '결제 페이지에서 이탈하는 5가지 마찰 포인트',
  ],
  '최신IT트렌드': [
    'AI 도구 10개 써보고 남긴 건 3개뿐이었다',
    'SaaS 구독 피로: 대안은 있는가',
    'AI 코딩 도구 3개월 사용기: 생산성 변화 리포트',
  ],
  '자기계발': [
    '매일 30분 학습 루틴이 1년 후 만든 변화',
    '번아웃 직전에 깨달은 우선순위 정리법',
  ],
  // ... 나머지 카테고리!
};
```

### blo.js 주제 사전 검토 삽입!

```javascript
// _prepareGeneralContext 수정!
const { selectAndValidateTopic } = require('./topic-selector');
const recentPosts = await getRecentPosts(category, 10);
const topic = await selectAndValidateTopic(category, recentPosts);
// context에 topicHint, topicQuestion, topicDiff 추가!
```

---

## Phase 5: 에이전트 페르소나 + 편집 파이프라인!

### 6명 작가 페르소나!

```javascript
// bots/blog/lib/writer-personas.ts (신규!)
const WRITER_PERSONAS = {
  gems:  { style: '체계적 강의', tone: '교수→학생, 논리적',
           promptPrefix: 'IT 강사. 단계별 체계적 설명.' },
  pos:   { style: '경험 스토리텔링', tone: '카페 사장님, 편안하게',
           promptPrefix: '카페 운영 블로거. 실제 경험 기반.' },
  nero:  { style: '날카로운 칼럼', tone: '칼럼니스트, 예리하게',
           promptPrefix: '통념에 도전. 독자를 생각하게.' },
  socra: { style: '질문 탐구', tone: '소크라테스식',
           promptPrefix: '질문으로 이끌기. 답보다 질문.' },
  answer:{ style: '데이터 리포트', tone: '객관적, 데이터 중심',
           promptPrefix: '숫자와 근거. 팩트 체크.' },
  'tutor-blog': { style: '초보 튜토리얼', tone: '친절한 선배',
           promptPrefix: '완전 초보도 가능하게 쉽게.' },
};
```

### 3명 편집자!

```javascript
const EDITOR_PERSONAS = {
  hooker:  { focus: '제목+도입부 CTR', instruction: '클릭하게 만들어라.' },
  styler:  { focus: '문체+SEO', instruction: '문체 통일+키워드 자연 배치.' },
  polish:  { focus: '최종 다듬기', instruction: '맞춤법+흐름+완성도.' },
};
```

### 작가 선택 시 페르소나 주입!

```javascript
async function runWriter(writerName, { topic, research, context }) {
  const persona = WRITER_PERSONAS[writerName] || WRITER_PERSONAS['gems'];
  const enhancedContext = {
    ...context,
    systemPrompt: `${persona.promptPrefix}
[스타일] ${persona.tone}
이 스타일을 일관되게 유지하며 작성하세요.`,
  };
  return await generateDraftWithPersona(enhancedContext, topic, research);
}
```

---

## Phase 6: Agentic RAG!

### 현재: 단발 검색 (Naive RAG!)
### 목표: 검색→평가→불충분?→재검색 루프!

```javascript
// bots/blog/lib/agentic-rag.ts (신규!)
async function agenticSearch(topic, category, maxRetries = 3) {
  let context = { episodes: [], relatedPosts: [], quality: 0 };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const results = await searchRealExperiences(topic);
    const posts = await searchRelatedPosts(topic);
    const evaluation = evaluateSearchResults(results, posts, topic);

    if (evaluation.sufficient) {
      context = { episodes: results, relatedPosts: posts, quality: evaluation.score };
      break;
    }
    // 불충분 → 쿼리 재구성!
    topic = await reformulateQuery(topic, evaluation.gaps);
  }
  return context;
}

function evaluateSearchResults(episodes, posts, topic) {
  let score = 0;
  const gaps = [];
  if (episodes.length >= 3) score += 0.3; else gaps.push('에피소드 부족');
  if (posts.length >= 2) score += 0.2; else gaps.push('관련 포스팅 부족');
  // 주제 관련성 + 소스 다양성!
  return { sufficient: score >= 0.6, score, gaps };
}
```

### 발행 후 RAG 자동 축적!

```javascript
// bots/blog/lib/rag-accumulator.ts (신규!)
async function accumulatePostExperience(post, quality) {
  // rag_blog에 포스팅 저장!
  await rag.store('blog', `[${post.category}] ${post.title}\n${post.content.slice(0,500)}`, {
    category: post.category, writerName: post.writerName, qualityScore: quality.score,
  });
  // rag_experience에 품질 결과!
  await rag.store('experience', JSON.stringify({
    action: 'blog_post_published', topic: post.title,
    writer: post.writerName, quality, timestamp: new Date().toISOString(),
  }), { type: 'blog_quality' });
  // event_lake!
  await eventLake.record({
    eventType: 'blog_post_published', team: 'blog', agent: post.writerName,
    summary: `${post.category}: ${post.title}`,
    details: { charCount: post.charCount, qualityScore: quality.score },
    why: `${post.writerName}가 ${post.category} 발행`,
  });
}
```

---

## Phase 7: Outer Loop — 주간 전략 진화!

### 매주 자동으로 포스팅 전략이 진화!

```javascript
// bots/blog/lib/performance-diagnostician.ts (신규!)
async function diagnoseWeeklyPerformance() {
  const posts = await getRecentPosts(null, 7);
  const performance = await getPerformanceData(posts);
  return {
    byCategory: groupAndScore(performance, 'category'),
    byWriter: groupAndScore(performance, 'writerName'),
    byTitlePattern: analyzeTitlePatterns(performance),
    primaryWeakness: identifyPrimaryWeakness(analysis),
    recommendations: generateRecommendations(analysis),
  };
}

// bots/blog/lib/strategy-evolver.ts (신규!)
async function evolveStrategy(diagnosis) {
  // 잘 된 작가 점수 boost!
  if (diagnosis.bestWriter) await adjustAgentScore(diagnosis.bestWriter, +0.5);
  // 안 된 카테고리 제목 풀 교체!
  if (diagnosis.worstCategory) await refreshCategoryTitlePool(diagnosis.worstCategory);
  // 성과 좋은 제목 패턴 우선순위!
  if (diagnosis.bestTitlePattern) await promoteTitleFrame(diagnosis.bestTitlePattern);
  // RAG에 진화 결과 저장!
  await rag.store('experience', JSON.stringify({
    action: 'strategy_evolved', diagnosis: diagnosis.primaryWeakness,
  }), { type: 'strategy_evolution' });
  // event_lake!
  await eventLake.record({
    eventType: 'blog_strategy_evolved', team: 'blog', agent: 'strategy-evolver',
    summary: `전략 진화: ${diagnosis.recommendations.length}건`,
  });
}

// bots/blog/scripts/weekly-evolution.ts (신규!)
// Elixir Quantum: 매주 월요일!
async function weeklyEvolution() {
  const diagnosis = await diagnoseWeeklyPerformance();
  await evolveStrategy(diagnosis);
  await postAlarm({ message: `📊 주간 진화!\n최고: ${diagnosis.bestCategory}\n약점: ${diagnosis.primaryWeakness}`, team: 'blog' });
}
```

---

## 전체 파이프라인 통합!

```javascript
// bots/blog/lib/self-improving-pipeline.ts (신규!)
// 7단계 Inner Loop!

async function runSelfImprovingPipeline(category, context) {
  // 1. 주제 선정! (Phase 4!)
  const topic = await selectAndValidateTopic(category, context.recentPosts);

  // 2. 연구 수집! (Phase 6 Agentic RAG!)
  const research = await agenticSearch(topic.title, category);

  // 3. 작가 고용 + 초안! (Phase 5 페르소나!)
  const writer = await selectBestAgent('writer', 'blog', { taskHint: topic.title });
  const draft = await runWriter(writer?.name || 'gems', { topic, research, context });

  // 4. 품질 검증 (자기수정 루프!)
  let finalDraft = draft;
  let quality = await checkQualityEnhanced(draft.content, 'general', {});
  let retries = 0;
  while (!quality.passed && retries < 2) {
    const failExp = await rag.search('experience', `quality_failed ${quality.issues?.join(' ')}`, { limit: 2 });
    finalDraft = await repairDraft(finalDraft, quality, failExp);
    quality = await checkQualityEnhanced(finalDraft.content, 'general', {});
    retries++;
  }

  // 5. 편집!
  const editor = await selectBestAgent('editor', 'blog', { taskHint: topic.title });
  const edited = await runEditor(editor?.name || 'hooker', finalDraft);

  // 6. 발행!
  const published = await publish(edited, context);

  // 7. 경험 축적! (피드백 루프!)
  await accumulatePostExperience(edited, quality);
  return published;
}
```

---

## 신규 파일 목록!

```
신규 생성:
  bots/blog/lib/topic-selector.ts          — 주제 사전 검토!
  bots/blog/lib/title-diversity.ts         — 제목 프레임+풀!
  bots/blog/lib/writer-personas.ts         — 작가 페르소나!
  bots/blog/lib/parallel-collector.ts      — 병렬 수집!
  bots/blog/lib/agentic-rag.ts            — Agentic RAG!
  bots/blog/lib/rag-accumulator.ts         — 발행 후 축적!
  bots/blog/lib/performance-diagnostician.ts — 주간 진단!
  bots/blog/lib/strategy-evolver.ts        — 전략 진화!
  bots/blog/lib/self-improving-pipeline.ts — 통합 파이프라인!
  bots/blog/scripts/weekly-evolution.ts    — 주간 진화 스크립트!
  elixir/.../teams/blog_supervisor.ex      — Elixir Supervisor!

수정:
  maestro.ts    — 경쟁 config 토글!
  blo.ts        — 주제 사전 검토 + n8n 분기 제거!
  config.yaml   — blog.competition 섹션!
  application.ex — BlogShadow → BlogSupervisor!
```

---

## 테스트 체크리스트!

```
Phase 0 (경로 수정! 긴급!):
  [ ] __dirname → PROJECT_ROOT 전수 수정!
  [ ] health-report "파일 없음" 해소!
  [ ] commenter 테스트 graceful skip!
  [ ] collect-views 다중 추출!

Phase 1 (TS!):
  [x] .legacy.js → .ts 우선 로드 경로 정리!
  [x] 블로그 전용 typecheck 통과!

Phase 2 (Elixir+n8n!):
  [ ] BlogSupervisor 6에이전트!
  [x] n8n 기본 비활성화 + 로컬 directRunner 기본화!
  [x] parallel-collector 동작!

Phase 3 (경쟁 토글!):
  [x] config enabled=false!
  [x] maestro config 읽기!

Phase 4 (주제!):
  [x] topic-selector 독립 단계!
  [x] 최근 제목 유사도 차단!
  [x] 전략 파일 기반 제목 패턴 선호/회피 반영!

Phase 5 (페르소나!):
  [x] 작가/편집자 페르소나 주입!
  [x] 같은 주제 다른 스타일 프롬프트 반영!

Phase 6 (Agentic RAG!):
  [x] 검색→평가→재검색 루프!
  [ ] 발행 후 자동 축적!

Phase 7 (Outer Loop!):
  [x] 주간 진단!
  [x] 전략 진화!
  [x] weekly-evolution launchd 자동화!
  [ ] 텔레그램 리포트!

E2E:
  [ ] 7일 연속 발행!
  [ ] RAG 21건+ 축적!
  [ ] 주간 진화 1회!
```

---

## Phase 8: 블로그 썸네일 1장 + Draw Things 전환!

### 현재 문제!

```
img-gen.js: thumb + mid = 2장 생성!
모델: SDXL 1.0 (2023년 — 구식!)
프롬프트: 포스팅 내용 밀착형 (복잡한 카테고리별 분기!)
→ 비효율 + 품질 낮음!
```

### 변경: 썸네일 1장만, 클릭 유도형!

```
핵심 전환:
  ❌ 포스팅 내용 밀착형 → 카테고리별 복잡 프롬프트
  ✅ 클릭 유도형 → 사람들이 누르고 싶은 시선 끄는 이미지!

이미지 엔진:
  ❌ ComfyUI + SDXL 1.0 (포트 8188)
  ✅ Draw Things + FLUX.1 schnell (포트 7860) — 이미 전환 완료!
```

### Task 8-1: img-gen 수정!

```
파일: bots/blog/lib/img-gen.legacy.js (→ img-gen.ts!)

변경사항:
  1. _buildMidPrompt() 삭제!
  2. generatePostImages()에서 mid 생성 제거!
     → thumb 1장만 반환!
  3. _buildThumbPrompt()를 클릭 유도형으로 교체!

새 프롬프트 방향:
  - 포스팅 내용과 밀접하지 않아도 됨!
  - 시선을 끄는 비주얼! (호기심, 감성, 놀라움!)
  - 카테고리별 "무드"만 반영!
  - 텍스트 없는 깨끗한 이미지!
  - 16:9 비율! (네이버 블로그 썸네일!)

예시:
  최신IT트렌드 → "cinematic futuristic cityscape, neon lights, moody atmosphere"
  자기계발 → "person silhouette at sunrise on mountain peak, dramatic golden light"
  도서리뷰 → "aesthetic coffee and open book by window, warm soft lighting, cozy"
```

### Task 8-2: local-image-client Draw Things 전환!

```
파일: packages/core/lib/local-image-client.legacy.js (→ .ts!)

변경사항:
  이미 런타임 config에서 Draw Things(7860)로 전환됨!
  ComfyUI workflow 템플릿 방식 → Draw Things txt2img API 직접 호출!

Draw Things API (A1111 호환!):
  POST http://127.0.0.1:7860/sdapi/v1/txt2img
  {
    "prompt": "...",
    "negative_prompt": "text, watermark, blurry, low quality",
    "width": 1536, "height": 864,  // 16:9!
    "steps": 20,
    "cfg_scale": 3.5,
    "seed": -1
  }
  → 응답: { "images": ["base64..."] }
```

### Task 8-3: blo.js 통합!

```
blo.js에서 generatePostImages() 호출 부분:
  기존: { thumb, mid } = await generatePostImages(...)
  변경: { thumb } = await generatePostImages(...)
  → mid 참조 전부 제거!
  → 포스팅 HTML에 mid 이미지 삽입 로직 제거!
```

### 검증!

```
[x] Draw Things API 응답 정상!
[x] 썸네일 1장만 생성!
[x] 16:9 비율!
[x] 클릭 유도형 이미지 (내용 밀착X!)
[x] 네이버 포스팅에 정상 삽입!
[x] 생성 속도 측정 가능! (실사용 생성 검증 완료)
```

---

## Phase 9: 인스타 숏폼 영상 + 자동 등록!

### 현재 → 목표!

```
현재: star.js → 카드 이미지 3장 + 캡션 + 해시태그!
목표: 숏폼 영상 1개 + 캡션(블로그 링크) + 인스타 자동 등록!
```

### Task 9-1: 숏폼 영상 생성!

```
방안 A (안전 — 우선!): 이미지 → ffmpeg 모션!
  블로그 썸네일 1장 → Ken Burns 효과 (줌+팬!)
  + 텍스트 오버레이 (제목!)
  + BGM (무료 라이선스!)
  = 5~15초 릴스!

  구현:
    const { execSync } = require('child_process');
    // 이미지 → 모션 영상!
    execSync(`ffmpeg -loop 1 -i ${thumbPath} -c:v libx264 \
      -t 10 -pix_fmt yuv420p -vf "zoompan=z='min(zoom+0.001,1.3)':d=250:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',scale=1080:1920" \
      ${outputPath}`);

방안 B (고급 — Draw Things 비디오!):
  Draw Things Wan 2.2 5B / LTX-2.3!
  프롬프트 기반 비디오 직접 생성!
  ⚠️ 32GB 메모리 주의!

방안 C (중간 — Remotion!):
  React 기반 프로그래밍 영상 생성!
  텍스트 애니메이션 + 이미지 전환!
  비디오팀 Twick과 유사!

현재 구현 상태:
  ✅ shortform-planner.ts — 훅/스토리보드/CTA/ffmpeg 초안 생성
  ✅ prepare-shortform.ts — 숏폼 준비 JSON + 인스타 캡션 초안 생성
  ✅ render-shortform.ts — ffmpeg 기반 1080x1920 MP4 렌더 완료
  ✅ 샘플 산출물: bots/blog/output/shortform/*_reel.mp4
```

### Task 9-2: 캡션 + 블로그 링크!

```
기존 generateInstaCaption() 활용!
변경:
  CTA에 블로그 URL 자동 삽입!
  "자세한 내용은 프로필 링크에서! 👉"
  → 실제 네이버 블로그 포스팅 URL!

캡션 구조:
  [후킹 1줄!]
  [핵심 내용 2줄!]
  [CTA: 블로그 링크!]
  [해시태그 15~25개!]
```

### Task 9-3: 인스타 자동 등록!

```
방안 A (추천!): Instagram Graph API (비즈니스 계정!)
  1. Meta Developer 앱 생성!
  2. Instagram Business 계정 연결!
  3. 릴스 업로드 API:
     POST /v21.0/{ig-user-id}/media
     { video_url, caption, media_type: "REELS" }
     → POST /v21.0/{ig-user-id}/media_publish
  4. 토큰 관리: secrets-store.json에 추가!

방안 B (대안!): Puppeteer 브라우저 자동화!
  스카팀 Playwright 패턴 재사용!
  ⚠️ 인스타 봇 차단 위험!
  ⚠️ UI 변경 시 깨짐!

방안 C (유료!): Buffer/Later API!
  안전하지만 월 비용 발생!
```

### Task 9-4: star.js 전면 교체!

```
기존 star.js 흐름:
  N40: 요약 → N41: 카드 이미지 3장 → N42: 캡션!

새 흐름:
  N40: 요약 (유지!)
  N41: 숏폼 영상 1개 (카드 대신!)
  N42: 캡션 + 블로그 링크 (강화!)
  N43: 인스타 자동 등록 (신규!)

산출물 변경:
  기존: insta_content.html + 카드 PNG 3장!
  변경: 숏폼 영상 MP4 1개 + 인스타 등록 완료!
```

### 검증!

```
[x] 숏폼 영상 생성 (5~15초!)
[x] 영상 품질 확인 (1080x1920 세로!)
[x] 캡션에 블로그 URL 포함!
[ ] 인스타 API 토큰 발급!
[ ] 릴스 자동 업로드 성공!
[x] 해시태그 정상 포함!
```

```
Day 0: Phase 0 (경로 수정!) — ✅ 코덱스 완료!
Day 1: Phase 1 (TS 마무리!) + Phase 2 (Elixir+n8n!) + Phase 3 (경쟁 OFF!)
Day 2: Phase 4 (주제 검토!) — ✅ 구현 완료!
Day 3: Phase 5 (페르소나!) — ✅ 구현 완료!
Day 4: Phase 6 (Agentic RAG!) — ✅ 1차 루프 완료!
Day 5: Phase 7 (Outer Loop!) + 통합 파이프라인! — ✅ weekly-evolution 자동화 완료!
Day 6: Phase 8 (썸네일 1장 + Draw Things!) — ✅ 썸네일 1장 + Draw Things 완료!
Day 7: Phase 9 (인스타 숏폼 + 자동 등록!) — ✅ ffmpeg 설치 + MP4 1차 렌더 완료!
Day 8~: Meta API 연결 + 자동 업로드 — Meta Developer 등록 후!
Week 2~: 운영 + 모니터링 + 안정화!

마스터 선행 작업:
  Meta Developer 앱 등록 (developers.facebook.com!)
  Instagram Business 계정 연결!
  Instagram 비즈니스/크리에이터 계정 전환!

관련 문서:
  docs/codex/CODEX_BLOG_IMAGE_REDESIGN.md (534줄!) — Phase 8~9 상세!
  docs/codex/CODEX_DRAW_THINGS_TEST.md (263줄!) — Draw Things 테스트!
  docs/strategy/ECC_APPLICATION_GUIDE.md (434줄!) — ECC+Hermes 패턴!
  .claude/rules/ — 4파일 (보안/스타일/git/팀제이!)

파일 상태:
  .claude/rules/security.md       ✅ 16줄
  .claude/rules/coding-style.md   ✅ 21줄
  .claude/rules/git-workflow.md   ✅ 20줄
  .claude/rules/team-jay.md       ✅ 27줄
  ECC_APPLICATION_GUIDE.md        ✅ 434줄
  CODEX_DRAW_THINGS_TEST.md       ✅ 263줄 테스트완료
  CODEX_BLOG_IMAGE_REDESIGN.md    ✅ 534줄 코덱스전달대기
  CODEX_BLOG_MASTER.md            ✅ 본 문서
```
