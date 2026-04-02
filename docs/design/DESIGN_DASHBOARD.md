# 모니터링 대시보드 설계서

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-02
> 상태: 설계 단계
> Phase 1 두 번째: 워커 포털(4001)에 에이전트 오피스 페이지 추가

---

## 1. 개요

```
위치: 워커 포털 (bots/worker/web) — Next.js + Tailwind + Express
경로: /admin/agent-office (새 페이지)
데이터: agent.registry + agent.performance_history + agent.contracts (PostgreSQL)
실시간: WebSocket (기존 ws 인프라 재활용)

기존 패턴 참고:
  /admin/monitoring (LLM 모니터링 — 865줄, lucide-react 아이콘)
  AdminPageHero + AdminQuickNav 컴포넌트 재활용
  api.js 통신 레이어 재활용
```

---

## 2. 페이지 레이아웃

```
┌─────────────────────────────────────────────────────────┐
│ [AdminPageHero] AGENT OFFICE                            │
│ 활성 56  작업중 12  대기 44  학습중 2                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ┌─ 상시 에이전트 상태 바 (고정) ──────────────────────┐  │
│ │ 🟢dexter 🟢andy 🟢eve 🟢hub 🟡doctor 🟢archer     │  │
│ │ 🟢deploy 🟢write  마지막 점검: 13:31              │  │
│ └───────────────────────────────────────────────────┘  │
│                                                         │
│ [팀 탭] 전체 | 블로 | 루나 | 클로드 | 스카 | 워커 |     │
│         에디 | 연구 | 감정 | 데이터 | 제이              │
│                                                         │
│ ┌──────────────────────────────────────────────────┐    │
│ │               팀별 에이전트 카드 그리드              │    │
│ │                                                    │    │
│ │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │    │
│ │  │ 🤖 포스  │  │ 🤖 젬스  │  │ 🤖 리처  │          │    │
│ │  │ IT작가   │  │ 감성작가 │  │ 수집     │          │    │
│ │  │ ⭐ 9.2   │  │ ⭐ 8.7   │  │ ⭐ 9.0   │          │    │
│ │  │ 🟢 활성  │  │ 🟢 활성  │  │ ⚪ 대기  │          │    │
│ │  └─────────┘  └─────────┘  └─────────┘          │    │
│ │                                                    │    │
│ └──────────────────────────────────────────────────┘    │
│                                                         │
│ ┌──────────────────────────────────────────────────┐    │
│ │               하단 실시간 차트                      │    │
│ │  [토큰 소비] [비용 추정] [에러율] [품질 트렌드]     │    │
│ └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 핵심 컴포넌트

### 3-1. AlwaysOnBar — 상시 에이전트 상태 바

```jsx
// 상단 고정, 8개 상시 에이전트 실시간 상태
// agent.registry WHERE is_always_on = true
{
  agents: [
    { name: 'dexter', status: 'ok', lastActive: '13:31:02', score: 9.1 },
    { name: 'andy', status: 'ok', lastActive: '13:30:45', score: 8.8 },
    { name: 'doctor', status: 'warn', lastActive: '13:25:00', score: 7.2 },
    ...
  ]
}

상태 표시:
  🟢 ok — 정상 (5분 이내 활동)
  🟡 warn — 지연 (5~15분 미활동)
  🔴 error — 중단 (15분+ 미활동 또는 에러)
  ⚪ off — 비활성 (의도적 중단)

스타일: sticky top, bg-slate-50, border-b, h-12
```

### 3-2. AgentCard — 에이전트 카드 (핵심 UI)

```jsx
// 각 에이전트 1장 = 1카드
{
  name: 'pos',
  displayName: '포스',
  team: 'blog',
  role: 'IT기술작가',
  score: 9.2,
  scoreTrend: +0.3,       // 이번 주 변화
  status: 'active',       // active/idle/learning/archived
  emotion: {
    confidence: 8,
    fatigue: 2,
    motivation: 9
  },
  dotCharacter: {
    primaryColor: '#6366f1',
    secondaryColor: '#a5b4fc',
    accessory: 'glasses',  // 안경
    animation: 'bounce'    // 흔들흔들 애니메이션
  },
  lastTask: 'Node.js 56강 (21,244자)',
  contractCount: 28,
  successRate: 92
}

카드 크기: w-40 h-52 (모바일 반응형: w-full sm:w-40)
카드 레이아웃:
  ┌─────────────┐
  │  [도트캐릭터] │  ← 16x16 픽셀 아트, CSS animation: bounce 2s infinite
  │   포스 (POS) │  ← display_name + name
  │   IT기술작가  │  ← role
  │  ⭐ 9.2 ↑0.3 │  ← score + trend (초록=상승, 빨강=하락)
  │  🟢 활성     │  ← status 뱃지
  │  자신감 8/10  │  ← emotion.confidence
  │  28건 | 92%  │  ← contractCount + successRate
  └─────────────┘

팀별 테두리 색상:
  blog: border-blue-400
  luna: border-amber-400
  claude: border-emerald-400
  ska: border-teal-400
  worker: border-purple-400
  video: border-pink-400
  research: border-indigo-400
  legal: border-slate-400
  data: border-cyan-400
  jay: border-orange-400
```

### 3-3. DotCharacter — 도트 캐릭터 SVG 컴포넌트

```jsx
// 각 에이전트별 고유 16x16 픽셀 아트
// props: { color, accessory, status, animation }

애니메이션 종류 (CSS):
  bounce — 위아래 흔들흔들 (기본, 활성 에이전트)
  pulse — 깜빡깜빡 (작업 중)
  sleep — 좌우 살짝 기울기 (대기 중)
  study — 위아래 느리게 (학습 중)
  alert — 빨간 깜빡 (에러)
  none — 정지 (아카이브)

@keyframes agent-bounce {
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-3px); }
}
@keyframes agent-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
@keyframes agent-sleep {
  0%, 100% { transform: rotate(0deg); }
  50% { transform: rotate(5deg); }
}

악세서리 (에이전트 특성 표현):
  glasses — 안경 (포스, 개발자)
  pen — 펜 (젬스, 작가)
  shield — 방패 (네메시스, 수호자)
  magnifier — 돋보기 (덱스터, 탐정)
  chart — 차트 (아리아, 분석가)
  crown — 왕관 (팀장들)
  book — 책 (스칼라, 연구자)
  cross — 십자 (닥터, 치료)
  gavel — 망치 (저스틴, 법률)
  compass — 나침반 (서칭 에이전트들)
```

### 3-4. ContractFlow — 동적 렌더링 (고용 계약 시 카드 이동)

```
고용 발생 시 WebSocket 이벤트:
  { type: 'contract_start', agent: 'pos', team: 'blog', group: 'A' }
  { type: 'contract_end', agent: 'pos', result: 'success', score: 9.2 }

카드 이동 애니메이션 (Tailwind + CSS transition):
  고용 시: 에이전트 풀 → 팀 그룹 (translateX + opacity 0→1, 500ms)
  완료 시: 팀 그룹 → 에이전트 풀 (reverse, 300ms)
  학습 편입: 팀 → 학습 영역 (translateX + scale 0.9, 400ms)

그룹 경쟁 시:
  팀 영역이 A/B로 분리 (flex gap-4)
  각 그룹 테두리: A=blue-300, B=amber-300
  승리 표시: 그룹 테두리 gold + ⭐ 아이콘
```

### 3-5. AgentDetailModal — 에이전트 상세 모달

```
카드 클릭 시 모달 표시:
  ┌─────────────────────────────────────────┐
  │ 🤖 포스 (POS) — IT기술작가              │
  │                                         │
  │ 팀: 블로팀 | 모델: gpt-5.4             │
  │ 상태: 🟢 활성                           │
  │                                         │
  │ 성과: 9.2/10 (↑0.3 이번 주)            │
  │ 고용: 28건 | 성공률: 92%                │
  │ Shapley 기여도: 0.35 (팀 내 1위)        │
  │                                         │
  │ 내적 상태:                              │
  │  자신감 ████████░░ 8/10                │
  │  피로도  ██░░░░░░░░ 2/10                │
  │  동기    █████████░ 9/10                │
  │                                         │
  │ 최근 작업 이력:                          │
  │  ✅ Node.js 56강 (21,244자) — 9.5점     │
  │  ✅ Node.js 55강 (19,800자) — 9.2점     │
  │  ⚠️ Node.js 54강 (8,200자) — 7.1점     │
  │                                         │
  │ [성과 트렌드 차트] [작업 이력] [민원]    │
  └─────────────────────────────────────────┘

차트: Recharts LineChart (7일간 점수 추이)
```

### 3-6. StatsCharts — 하단 실시간 차트

```
4개 탭 차트 (Recharts):

  [토큰 소비 추이] — AreaChart
    x: 날짜 (7일), y: 토큰 수
    팀별 색상 구분 스택

  [비용 추정] — BarChart
    x: 날짜, y: USD
    모델별 비용 분리 (local=$0, groq, anthropic)

  [에러율] — LineChart
    x: 날짜, y: 에러 수
    팀별 라인 + 전체 평균선

  [품질 트렌드] — LineChart
    x: 날짜, y: 평균 점수
    팀별 라인 (목표선 8.0 표시)

데이터 소스: llm_usage_log + agent.performance_history
```

---

## 4. API 엔드포인트 (Express, server.js 확장)

```
GET  /api/agents                     — 전체 에이전트 목록
GET  /api/agents/:name               — 개별 에이전트 상세
GET  /api/agents/team/:team          — 팀별 에이전트
GET  /api/agents/always-on           — 상시 에이전트 상태
GET  /api/agents/:name/history       — 성과 이력 (7일)
GET  /api/agents/:name/contracts     — 계약 이력
GET  /api/agents/stats/overview      — 대시보드 통계 (활성/대기/학습 수)
GET  /api/agents/stats/charts        — 차트 데이터 (토큰/비용/에러/품질)

WebSocket 이벤트:
  agent:status_change    — 에이전트 상태 변경
  agent:score_update     — 점수 갱신
  agent:contract_start   — 고용 계약 시작
  agent:contract_end     — 고용 계약 종료
```

---

## 5. 파일 구조

```
bots/worker/web/
├── app/admin/agent-office/
│   └── page.js                      ← 메인 페이지 (에이전트 오피스)
├── components/
│   ├── AlwaysOnBar.js               ← 상시 에이전트 상태 바
│   ├── AgentCard.js                 ← 에이전트 카드
│   ├── AgentDetailModal.js          ← 에이전트 상세 모달
│   ├── DotCharacter.js              ← 도트 캐릭터 SVG
│   ├── ContractFlow.js              ← 동적 렌더링 (카드 이동)
│   ├── TeamTabFilter.js             ← 팀 탭 필터
│   └── StatsCharts.js               ← 하단 차트 4개
├── lib/
│   └── agent-api.js                 ← 에이전트 API 호출 래퍼
└── routes/
    └── agents.js                    ← Express 에이전트 라우트
```

---

## 6. 구현 계획

```
Step 1: API 엔드포인트 (Express)
  → routes/agents.js 생성
  → server.js에 라우트 등록
  → Agent Registry DB 연동

Step 2: 기본 페이지 + 카드 뷰
  → app/admin/agent-office/page.js
  → AgentCard.js + TeamTabFilter.js
  → agent-api.js (API 호출)

Step 3: 상시 에이전트 바
  → AlwaysOnBar.js
  → /api/agents/always-on 연동

Step 4: 도트 캐릭터 + 애니메이션
  → DotCharacter.js (SVG 픽셀 아트)
  → CSS 애니메이션 (bounce, pulse, sleep, study, alert)

Step 5: 에이전트 상세 모달
  → AgentDetailModal.js
  → 성과 이력 차트 (Recharts)

Step 6: 동적 렌더링
  → ContractFlow.js
  → WebSocket 이벤트 연동
  → 카드 이동 애니메이션

Step 7: 하단 차트
  → StatsCharts.js (Recharts)
  → 토큰/비용/에러/품질 4탭

Step 8: AdminQuickNav에 "Agent Office" 메뉴 추가
```

---

## 7. 안전 원칙

```
① 대시보드는 읽기 전용 (에이전트 수정/삭제 불가)
② 마스터만 접근 가능 (기존 admin 인증 재활용)
③ WebSocket은 브로드캐스트만 (클라이언트→서버 명령 불가)
④ 소스코드/시크릿 노출 없음 (API 응답에서 code_path 제외)
```
