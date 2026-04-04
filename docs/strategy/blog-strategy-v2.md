# 블로팀 전략기획서 v2 — 2026-04-04

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 이전 버전: docs/strategy/blog-strategy.md (2026-03-30, v1)
> 커뮤니티 근거: Multi-Agent Content Generation (2026), Frase SEO Agent, CrewAI Role-Based, 네이버 검색광고 MCP

---

## 1. 블로팀 미션

```
"매일 양질의 블로그 글 2편을 자동 발행하고,
 성과 데이터로 자기 학습하여 지속적으로 품질을 향상시키는
 멀티 에이전트 콘텐츠 팀"
```

---

## 2. 현재 상태 (2026-04-04 기준)

### 2-1. 팀 구성 (26에이전트!)

```
팀장: 블로 (blo.js, 991줄) — 전체 오케스트레이션
작가 6명:
  포스    — IT기술작가 (강의 시리즈)
  젬스    — 감성에세이작가 (일반 포스팅)
  앤서    — 분석리포트작가 ⭐ 5.75
  네로    — 대화형캐주얼작가 ⭐ 5.66
  소크라  — 질문형탐구작가
  튜터    — 교육튜토리얼작가
편집 2명:
  폴리쉬  — 문체일관성편집
  훅커    — 제목/인트로최적화
수집 2명:
  리처    — 정보수집 (날씨/뉴스/RAG)
  딥서치  — 심층리서치전문(arXiv+논문+GitHub)
전문 5명:
  크리틱  — 콘텐츠비평가(논리적약점+팩트체크+설득력점검)
  보이스  — 브랜드보이스관리자(톤+말투+승호아빠정체성)
  비주얼  — 시각콘텐츠전략가(이미지+인포그래픽+카드뉴스)
  메트릭스 — 성과분석가(조회수+체류시간+공감수추적)
  소셜    — 소셜미디어전략가(크로스플랫폼+인스타+댓글)
기타:
  마에스트로 — 파이프라인 변형 (maestro.js)
  스타    — 인스타 소셜 카드 (star.js)
  커멘터  — 댓글 자동화 (commenter.js, 859줄)
  스케줄러 — 스케줄 관리 (schedule.js)
```

### 2-2. 일일 파이프라인

```
매일 자동 실행 (launchd):
  06:00 → blog-daily 실행
    ① 스케줄 조회 (강의 + 일반 카테고리 순환)
    ② 리서치 수집 (날씨/뉴스/Node.js/RAG)
    ③ 작가 동적 선택 (ε-greedy + taskHint 매칭!)
    ④ 본문 생성 (분할 4그룹 or 단일)
    ⑤ 품질 검증 + 자동 보정 (2회 시도)
    ⑥ 이미지 생성 (SDXL 기본 + FLUX 고품질)
    ⑦ HTML 발행 + 구글드라이브 저장
    ⑧ 인스타 소셜 카드 생성
    ⑨ 성과 수집 (7일 후)

  출력: 강의 1편 + 일반 1편 = 매일 2편
  카테고리: 7개 순환 (자기계발/도서리뷰/성장/홈페이지/IT트렌드/IT분석/기획)
```

### 2-3. 최근 완료된 개선 (v1 → v2)

```
v1 발견 (2026-03-30):
  F1: 젬스 글자수 심각 미달 → ✅ 분할생성+최소보장으로 해소
  F2: 날씨 수치 미반영 → ✅ _weatherToContext 개선
  F3: 품질 판단 관대 → ✅ AI탐지+섹션마커+코드검증 강화
  F4: 프롬프트 과도 복잡 → ✅ POS_PERSONA.md/GEMS_PERSONA.md 분리
  F5: 피드백 루프 부재 → ✅ collect-performance.js + ai-feedback.js
  F6: 도서 hallucination → ✅ book-review-book.js + book-source-verify.js

v2 추가 완료 (2026-04-03~04):
  ✅ ε-greedy 자율적 고용 (80% 최적 + 20% 탐색)
  ✅ taskHint specialty 매칭 (카테고리별 작가 선택)
  ✅ 인사말 반복 금지 (Group B/C/D 지시 추가)
  ✅ 도서 ISBN 보충 + quality-checker 완화
  ✅ FLUX 이미지 경로 (도서리뷰 고품질)
  ✅ ComfyUI MPS 전환 (CPU→GPU, 6배 속도 향상)
  ✅ 블로그 댓글 자동화 (commenter.js 859줄)
  ✅ 에이전트 26명 확장 (기존 16 + 보강 10)
  ✅ 런타임 셀렉터 분리
```

---

## 3. 전략 목표 (2026 Q2)

### 3-1. 품질 목표

```
글자수: 강의 10,000자+ / 일반 9,000자+ (현재 달성율 95%+)
AI탐지: riskScore < 3.0 (low) 유지
도서리뷰: ISBN 검증 100% (허구 도서 0건!)
이미지: 매 포스팅 2장+ (SDXL 기본 + FLUX 특수)
```

### 3-2. 성과 목표

```
네이버 노출: 월 평균 조회수 200+ per post (현재 측정 시작)
체류 시간: 평균 3분+ (현재 미측정 → 구현 필요)
공감수: 평균 5+ per post (현재 수집 시작)
AI검색 인용: ChatGPT/Claude/Perplexity에서 인용 시작 (GEO)
```

### 3-3. 시스템 목표

```
자동화율: 95%+ (현재 ~85%, 이미지 불안정 포함)
실패율: < 5% (현재 ~10%, 도서리뷰 이슈)
피드백 루프: 성과 → RAG → 다음 생성 반영 (미완성)
경쟁 시스템: 월/수/금 작가 경쟁 → 최적 작가 자연 수렴
```

---

## 4. 커뮤니티 벤치마크 — 2026 업계 패턴

### 4-1. 멀티에이전트 콘텐츠 생성 (업계 표준)

```
커뮤니티 합의 — 6단계 파이프라인:
  ① 리서치 에이전트 — 검색의도+경쟁분석+정보수집
  ② 계획 에이전트 — 아웃라인+헤딩구조+키워드배치
  ③ 작성 에이전트 — 브랜드보이스+톤+스타일 일관성
  ④ SEO 에이전트 — 키워드밀도+메타태그+내부링크
  ⑤ GEO 에이전트 — AI검색 인용 최적화+구조화
  ⑥ 팩트체크 에이전트 — 수치/인용/사실 검증

우리 블로팀 현황:
  ① 리서치: ✅ richer.js (날씨/뉴스/RAG/관련글)
  ② 계획: ⚠️ 부분 (maestro.js 변형만, 아웃라인 미생성)
  ③ 작성: ✅ pos-writer + gems-writer (분할생성!)
  ④ SEO: ❌ 부재! (해시태그만)
  ⑤ GEO: ❌ 부재!
  ⑥ 팩트체크: ⚠️ 부분 (코드검증만, 수치/인용 미검증)
```

### 4-2. 피드백 루프 (핵심 차별점)

```
커뮤니티:
  "피드백 루프가 없으면 같은 실수 반복"
  "발행 후 성과 추적 → 패턴 학습 → 다음 생성 반영"
  "작가 에이전트가 어떤 서두 스타일이 조회수가 높은지 학습"

우리 현황:
  수집: ✅ collect-performance.js (7일 후)
  분석: ⚠️ ai-feedback.js (커리큘럼 전용)
  반영: ❌ 미완성! 수집 데이터가 생성에 반영 안 됨!
  RAG: ⚠️ searchPopularPatterns() 있지만 성과 기반 아님
```

### 4-3. SEO + GEO 이중 최적화 (2026 필수)

```
커뮤니티:
  "전통적 검색(구글/네이버) + AI검색(ChatGPT/Claude/Perplexity) 동시 최적화"
  "Frase MCP: SEO+GEO 이중 채점이 업계 표준"
  "네이버 AI Briefing이 검색 쿼리 20%+ 차지"

우리 현황:
  SEO: ❌ 키워드 밀도, 메타태그, 내부 링크 전략 없음
  GEO: ❌ AI 인용 최적화 없음
  네이버: ❌ 검색광고 MCP 미연결 (오픈소스 존재!)
```

### 4-4. 카테고리별 전문화 (CrewAI 패턴)

```
커뮤니티:
  CrewAI: "매니저가 태스크 성격에 따라 전문가를 자동 배정"
  "도서리뷰 → 감성 작가, 기술강의 → 기술 작가"
  "에이전트가 다른 에이전트에게 위임 가능"

우리 현황:
  동적 선택: ✅ ε-greedy + taskHint (구현 완료!)
  전문화: ⚠️ taskHint 매칭이 점수 차이에 밀림
  위임: ❌ 작가 간 협업/위임 없음
```

---

## 5. 개선 로드맵

### Phase A: 기반 안정화 (즉시, 진행 중)

```
A-1: book_info 정규화 ← 진행 중!
  - scheduledBook book_title/book_isbn → title/isbn 매핑
  - quality-checker ISBN error → warn 완화
  파일: blo.js + quality-checker.js

A-2: 이미지 안정화 ← 진행 중!
  - ComfyUI MPS 전환 (✅ 완료)
  - FLUX 도서리뷰 경로 (✅ 설치, 튜닝 중)
  - SDXL 기본 경로 안정화

A-3: 코드 정리
  - 중복 함수 공용화: _weatherToContext, _estimateCost, loadPersonaGuide
  → packages/core/lib/blog-utils.js로 추출
```

### Phase B: 피드백 루프 완성 (1~2주)

```
B-1: 성과 데이터 → RAG 저장
  - 7일 후 수집된 조회수/체류시간/공감수를 pgvector에 저장
  - 카테고리+작가+스타일 조합별 성과 벡터화
  파일: collect-performance.js → rag.js 연동

B-2: 성과 기반 생성 반영
  - 다음 생성 시 "이 카테고리에서 이전 인기 패턴" RAG 검색
  - 성과 좋은 서두 스타일, 해시태그 패턴 자동 참조
  파일: richer.js searchPopularPatterns() 강화

B-3: Standing Orders 승격
  - 3회 연속 성공 패턴 → Standing Orders 자동 등록
  - 예: "도서리뷰에서 질문형 서두가 조회수 2배"
  파일: ai-feedback.js → openclaw standing orders

B-4: 작가별 성과 대시보드
  - 에이전트 오피스에서 작가별 평균 조회수/품질 점수 표시
  - 경쟁 시스템과 연동 (월/수/금 결과 비교)
  파일: bots/worker/web/routes/agents.js 확장
```

### Phase C: SEO + GEO 최적화 (2~4주)

```
C-1: 네이버 검색광고 MCP 연동 (비용 $0!)
  - 키워드 검색량, 경쟁강도, 연관키워드 실시간 조회
  - 카테고리별 최적 키워드 자동 선정
  - 오픈소스: retn.kr (네이버 검색광고 MCP 서버)
  파일: packages/core/lib/mcp/ 연동

C-2: SEO 스킬 구현
  - 키워드 밀도 분석 (본문 내 키워드 출현 빈도)
  - 메타태그 자동 생성 (title, description, og:tags)
  - 내부 링크 자동 삽입 (과거 글 URL DB 기반)
  파일: packages/core/lib/skills/blog/seo-optimizer.js

C-3: GEO 스킬 구현
  - AI 인용 친화 구조화 (명확한 정의, 번호 목록, 팩트 밀도)
  - 질문-답변 형식 섹션 강화 (AEO FAQ 개선)
  - 인용 가능한 통계/수치 포함 가이드
  파일: packages/core/lib/skills/blog/geo-optimizer.js

C-4: 이중 채점 시스템
  - quality-checker에 SEO 점수 + GEO 점수 추가
  - SEO: 키워드밀도+메타태그+내부링크+해시태그
  - GEO: 구조화+팩트밀도+인용가능성+질문답변
  파일: quality-checker.js 확장
```

### Phase D: 콘텐츠 심화 (1~2개월)

```
D-1: 팩트체킹 스킬
  - 본문의 수치/통계/인용 자동 추출
  - 웹 검증 (검색 결과와 교차 확인)
  - 불확실 주장 → [검증 필요] 마킹 또는 제거
  파일: packages/core/lib/skills/blog/fact-checker.js

D-2: 아웃라인 에이전트
  - 리서치 결과 기반 아웃라인 자동 생성
  - 경쟁 글 분석 → 차별화 포인트 도출
  - 키워드 배치 전략 포함
  커뮤니티: "아웃라인 단계에서 인간 검토가 가장 효과적"

D-3: 멀티모달 강화
  - 코드 블록 → 이미지 변환 (carbon.now.sh 스타일)
  - 핵심 개념 → Mermaid 다이어그램 자동 생성
  - 통계/비교 → 인포그래픽 자동 생성
  파일: img-gen.js 확장

D-4: 크로스 플랫폼 자동 발행
  - 블로그 → 인스타 카드 (✅ 구현 완료!)
  - 블로그 → 트위터/X 스레드
  - 블로그 → 네이버 카페 포스팅
  - 블로그 → 유튜브 쇼츠 스크립트
  파일: social.js 확장
```

### Phase E: 자율 진화 (장기 비전)

```
E-1: 자기 개선 사이클
  - 매주 성과 리포트 자동 생성
  - 저성과 카테고리 자동 진단 + 개선안 제시
  - 고성과 패턴 자동 확산 (Standing Orders)
  커뮤니티: "에이전트 최적화를 지속적 프로세스로"

E-2: 독자 반응 학습
  - 댓글 감성 분석 (commenter.js 확장)
  - 독자 선호 주제/스타일 패턴 추출
  - 다음 콘텐츠 기획에 반영

E-3: Gemma 4 도입 (테스트 후)
  - 리서치 보조: gemma4-26b MoE (빠른 요약/분류)
  - 구조화 출력: JSON 네이티브 (프롬프트 엔지니어링 불필요)
  - Shadow Mode 2주 → 본격 배치
  참조: docs/codex/CODEX_GEMMA4_ROLLOUT.md
```

---

## 6. 코드 리팩토링 계획

```
현재 (7,658줄):
  blo.js 991줄 — 너무 비대! 오케스트레이션+구현 혼재
  gems-writer.js 1,099줄 — 품질보정 로직이 작가와 혼재
  중복 함수 3개: _weatherToContext, _estimateCost, loadPersonaGuide

리팩토링 계획:
  ① blog-utils.js 추출 (공용 유틸)
    - _weatherToContext, _estimateCost, loadPersonaGuide
    - _buildBookReviewSkillInput, _extractTopicKeywords

  ② blo.js 분리 (991줄 → 3파일)
    - blo.js: 오케스트레이션만 (run, _prepareDailyRun, _sendDailyReport)
    - lecture-pipeline.js: 강의 파이프라인 (_prepareLecture, runLecture, _finalizeLecture)
    - general-pipeline.js: 일반 파이프라인 (_prepareGeneral, runGeneral, _finalizeGeneral)

  ③ quality 분리
    - gems-writer.js에서 품질보정 로직 → quality-repair.js로 이동
    - _runGeneralPostRepairPasses, _ensureGeneralQualityFloor
```

---

## 7. 핵심 파일 참조

```
전략: docs/strategy/blog-strategy-v2.md (본 문서)
분석: docs/strategy/blog-analysis.md (2026-03-30, v1 분석)
코드: bots/blog/lib/ (18파일, 7,658줄)
코덱스: docs/codex/CODEX_BLOG_*.md (9개 프롬프트)
설계: docs/design/DESIGN_BOOK_*.md (2개)
MCP: 네이버 검색광고 MCP (retn.kr), Frase SEO MCP
스킬: packages/core/lib/skills/blog/ (2파일)
```

---

## 변경 이력

| 날짜 | 변경 |
|------|------|
| 2026-04-04 | v2 전략기획서 신규 작성. 26에이전트+커뮤니티 벤치마크+5Phase 로드맵+리팩토링 계획 |
| 2026-03-30 | v1 전략 재설계 (hallucination 계기) + 코드 딥분석 (7,467줄/25파일) |
