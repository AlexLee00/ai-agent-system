# Phase 2 설계서 — 에이전트 세분화 + 그룹 경쟁 + 차트 연동

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-02
> 상태: 설계 단계
> 선행: Phase 1 전부 완료 (Registry+대시보드+고용계약+trace-collector)
> 참고: docs/MULTI_AGENT_EXPANSION_v2.md §1-3, §2-1~2-3, Phase 2~3

---

## 1. Phase 2 범위

```
Phase 1에서 만든 기반:
  ✅ Agent Registry (27에이전트 시딩)
  ✅ 모니터링 대시보드 (에이전트 오피스)
  ✅ 고용 계약 시스템 (selectBestAgent + hire + evaluate)
  ✅ trace-collector (LLM 관측성)

Phase 2에서 만들 것:
  ① 에이전트 세분화 — 블로팀 4역할 확장 + 루나팀 재편성
  ② 그룹 경쟁 엔진 — 블로팀 A/B 그룹 병렬 실행
  ③ 대시보드 차트 — trace 데이터 시각화 (Recharts)
  ④ 팀장 오케스트레이터 연동 — 동적 고용 실전 적용
```

---

## 2. 에이전트 세분화

### 2-1. 블로팀 세분화 (마스터 확정)

```
현재 (6 에이전트):
  블로(팀장), 포스(IT작가), 젬스(감성작가), 리처(수집), 퍼블(발행), 마에스트로(파이프라인)

세분화 후 (16 에이전트):

  팀장: 블로 (기존 유지)
  오케스트레이터: 마에스트로 (기존 유지)

  작가 풀 (4명):
    포스 — IT기술작가 (기존, 강의 포스팅)
    젬스 — 감성에세이작가 (기존, 일반 포스팅)
    앤서 (Answer) — 분석리포트작가 (신규, 데이터 기반 분석글)
    튜터 (Tutor) — 교육튜토리얼작가 (신규, 실습 중심)

  기획 풀 (3명):
    커리 (Curry) — IT커리큘럼기획 (기존 curriculum-planner 역할 분리)
    트렌디 (Trendy) — 트렌드기획 (신규, 인기 주제 기획)
    무드 (Mood) — 감성주제기획 (신규, 감성 에세이 주제 기획)

  수집 풀 (4명):
    리처 — IT뉴스수집 (기존 역할 특화)
    북마크 (Bookmark) — 도서정보수집 (신규, 도서 추천글용)
    마인드 (Mind) — 심리학수집 (신규, 자기개발글용)
    시그널 (Signal) — SEO분석수집 (신규, 키워드/경쟁 분석)

  편집/검증 풀 (2명):
    스타일 (Style) — 문체통일+SEO최적화 편집 (신규)
    프루프B (ProofB) — 품질검증+AI탐지 체크 (신규, 기존 quality-checker 분리)

  발행: 퍼블 (기존 유지)

Registry 등록:
  → 신규 10에이전트를 agent.registry에 INSERT
  → 기존 6에이전트 specialty 업데이트
  → 도트 캐릭터 + LLM 모델 배정
```

### 2-2. 루나팀 재편성

```
현재 (8 에이전트):
  루나(팀장), 아리아(기술분석), 센티널(외부감시), 오라클(기술분석),
  크로노스(백테스팅), 네메시스(리스크), 제우스(실행), 아테나(실행)

재편성 (구성 변경만, 신규 추가 없음):
  → 오라클/아리아 역할 명확화: 오라클=장기 트렌드, 아리아=단기 시그널
  → Chronos Layer 2~3 정식 투입 (전략='3' 설정)
  → 그룹 경쟁 없음 — 전략 조합 최적화만
  → 연구팀 골드(투자 서칭) 결과 반영
```

---

## 3. 그룹 경쟁 엔진

### 3-1. 개요

```
블로팀 전용 (마스터 확정: 최대 2그룹)

그룹 A vs 그룹 B — 같은 주제, 다른 에이전트 조합으로 병렬 실행
  → 두 결과물을 품질 평가 → 승자 채택 → 패턴 RAG 저장

예시:
  주제: "Node.js 57강 — 에러 추적 시스템"
  그룹 A: 커리(기획) → 포스(작가) → 리처(수집) → 스타일(편집)
  그룹 B: 트렌디(기획) → 앤서(작가) → 시그널(수집) → 프루프B(검증)
  → 두 결과물 품질 비교 → 승자 발행 → 패배 그룹 학습
```

### 3-2. DB 스키마

```sql
-- 그룹 경쟁 기록
CREATE TABLE IF NOT EXISTS agent.competitions (
  id SERIAL PRIMARY KEY,
  team TEXT NOT NULL DEFAULT 'blog',
  topic TEXT NOT NULL,
  
  -- 그룹 A
  group_a_agents JSONB,              -- ["curry", "pos", "richer", "style"]
  group_a_contract_ids JSONB,        -- [101, 102, 103, 104]
  group_a_result JSONB,              -- { quality: 8.5, chars: 15000, ... }
  
  -- 그룹 B
  group_b_agents JSONB,
  group_b_contract_ids JSONB,
  group_b_result JSONB,
  
  -- 결과
  winner TEXT,                        -- 'a' or 'b'
  quality_diff NUMERIC(4,2),         -- 승자-패자 품질 차이
  winning_pattern JSONB,             -- 승리 패턴 (RAG 저장용)
  
  status TEXT DEFAULT 'running',     -- running/evaluated/completed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_comp_team ON agent.competitions(team);
CREATE INDEX IF NOT EXISTS idx_comp_status ON agent.competitions(status);
```

### 3-3. 경쟁 워크플로우

```
[1] 마에스트로(오케스트레이터)가 오늘의 주제 수신
  ↓
[2] 그룹 편성 (selectBestAgent 2회)
  → 그룹 A: 기획1 + 작가1 + 수집1 + 편집1
  → 그룹 B: 기획2 + 작가2 + 수집2 + 편집2
  → 같은 역할이지만 다른 에이전트 (포스 vs 앤서 등)
  → agent.competitions INSERT (status=running)
  ↓
[3] 병렬 실행
  → 그룹 A: 기획 → 수집 → 작성 → 편집 (순차)
  → 그룹 B: 동일 (병렬)
  → 각 에이전트에 hire() → 고용 계약 생성
  ↓
[4] 품질 평가 엔진
  → LLM 심사 (anthropic): 두 결과물을 블라인드 비교
    평가 항목: 글자수, 섹션 구조, 정확성, 가독성, SEO 적합성
  → 규칙 기반: 최소 글자수(9000), 섹션 수(6), AI탐지율(<70)
  → 종합 점수 = LLM 심사(60%) + 규칙 기반(40%)
  ↓
[5] 승자 결정 + 처리
  → 승자 그룹 결과물 → 발행 (퍼블)
  → 패자 그룹 결과물 → 아카이브 (참고용 보관)
  → 승리 패턴 → RAG 저장 (rag_competition 컬렉션)
  → 에이전트 점수 갱신: 승자 +보너스, 패자 -페널티
  ↓
[6] 학습 반영
  → 패자 그룹 에이전트: 승자 패턴 분석 → 프롬프트 개선 참고
  → 3회 연속 패배 → 멘토(연구팀) 재교육 트리거
  → 승리 패턴 축적 → Standing Orders 승격 후보
```

### 3-4. 품질 평가 엔진 (competition-evaluator.js)

```js
// 평가 항목 + 가중치
const EVAL_CRITERIA = {
  // 규칙 기반 (40%)
  char_count: { weight: 0.1, min: 9000 },
  section_count: { weight: 0.1, min: 6 },
  ai_risk: { weight: 0.1, max: 70 },
  code_blocks: { weight: 0.1, min: 2 },
  
  // LLM 심사 (60%)
  accuracy: { weight: 0.15 },     // 기술적 정확성
  readability: { weight: 0.15 },  // 가독성
  depth: { weight: 0.15 },        // 깊이/전문성
  seo: { weight: 0.15 },          // SEO 적합성
};
```

---

## 4. 대시보드 차트 연동

### 4-1. trace 데이터 → Recharts 시각화

```
기존 Step 4에서 만든 것:
  agent.traces 테이블 + trace-collector.js + Hub 엔드포인트
  /api/agents/stats/traces?days=7 → 일별 토큰/비용/에러 집계

Phase 2에서 추가:
  에이전트 오피스 페이지에 차트 탭 추가 (하단)

4가지 차트 (Recharts):

  [토큰 소비] — AreaChart (팀별 색상 스택)
    x: 날짜 (7일), y: total_tokens
    provider별 색상 구분

  [비용 추정] — BarChart
    x: 날짜, y: total_cost (USD)
    local=$0 vs openai-oauth vs groq vs anthropic

  [에러율] — LineChart
    x: 날짜, y: error_count / call_count × 100
    전체 평균 + 팀별 라인

  [품질 트렌드] — LineChart
    x: 날짜, y: 평균 quality_score
    목표선 8.0 표시

  [그룹 경쟁 결과] — BarChart (Phase 2 신규)
    x: 경쟁 회차, y: 그룹 A/B 점수
    승자 표시 (gold)
```

### 4-2. 구현 컴포넌트

```
파일: bots/worker/web/components/AgentCharts.js

import { AreaChart, BarChart, LineChart, XAxis, YAxis, Tooltip, ... } from 'recharts';

<AgentCharts>
  <TabPanel label="토큰">    <AreaChart data={tokenData} />  </TabPanel>
  <TabPanel label="비용">    <BarChart data={costData} />     </TabPanel>
  <TabPanel label="에러">    <LineChart data={errorData} />   </TabPanel>
  <TabPanel label="품질">    <LineChart data={qualityData} /> </TabPanel>
  <TabPanel label="경쟁">    <BarChart data={compData} />     </TabPanel>
</AgentCharts>

데이터 소스: /api/agents/stats/traces + /api/agents/stats/competitions
```

---

## 5. 팀장 오케스트레이터 연동

### 5-1. 마에스트로 (블로팀) 개선

```
현재: 마에스트로가 고정 순서로 에이전트 호출
  maestro → richer → pos/gems → publ (하드코딩)

Phase 2: 마에스트로가 hiring-contract.js 사용
  maestro → selectBestAgent('planner') → hire() → 기획
          → selectBestAgent('researcher') → hire() → 수집
          → selectBestAgent('writer') → hire() → 작성
          → selectBestAgent('editor') → hire() → 편집
          → evaluate() → 점수 갱신

그룹 경쟁 모드:
  maestro → 그룹 A 편성 + 그룹 B 편성
          → 병렬 실행 (Promise.all)
          → competition-evaluator → 승자 결정
          → 승자 발행
```

### 5-2. 점진적 전환 전략

```
Step 1: 기존 파이프라인 유지 + hire/evaluate 기록만 추가
  → 실제 에이전트 선택은 기존 하드코딩 유지
  → 기록만 쌓아서 데이터 축적 (shadow mode)

Step 2: selectBestAgent 실전 적용 (1주 후)
  → 데이터 기반으로 동적 선택 시작
  → 기존 에이전트가 여전히 1순위이지만 점수에 따라 교체 가능

Step 3: 그룹 경쟁 시작 (2주 후)
  → 블로팀에서만, 주 2~3회 경쟁 실행
  → 경쟁 없는 날은 기존 방식
```

---

## 6. 구현 계획

```
Step 1: 블로팀 세분화 + Registry 등록
  → 신규 10에이전트 seed 스크립트
  → 기존 6에이전트 specialty 업데이트
  → agent.registry: 6 → 16 에이전트

Step 2: 그룹 경쟁 DB + 엔진
  → 008-competitions.sql 마이그레이션
  → competition-engine.js (편성+실행+평가)
  → competition-evaluator.js (품질 평가)
  → Hub 엔드포인트 추가

Step 3: 대시보드 차트
  → AgentCharts.js (Recharts 5탭)
  → 에이전트 오피스 page.js에 차트 섹션 추가
  → API: /api/agents/stats/traces + /api/agents/stats/competitions

Step 4: 마에스트로 오케스트레이터 연동
  → maestro.js에 hiring-contract 연동 (shadow mode)
  → 기록 축적 → 동적 선택 전환 → 경쟁 모드

Step 5: 루나팀 재편성
  → 오라클/아리아 역할 명확화
  → Chronos Layer 2~3 투입
  → Registry 업데이트
```

---

## 7. 안전 원칙

```
① 그룹 경쟁은 블로팀만 (루나팀은 구성 변경만)
② Shadow mode 먼저 — 기록만 쌓고 데이터 확인 후 실전 적용
③ 경쟁 실패 시 기존 파이프라인 폴백 (마에스트로 기존 로직 유지)
④ 비용 관리: 경쟁 시 2배 LLM 호출 → 주 2~3회로 제한
⑤ 기존 블로그 발행 품질 유지 — 경쟁 결과가 기존보다 나쁘면 기존 채택
```
