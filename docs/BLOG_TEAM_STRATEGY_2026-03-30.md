# 블로팀 전략 재설계 — 2026-03-30

> 작성: 메티 (전략+설계)
> 계기: 젬스 도서 리뷰 hallucination 발견 ("Composing Selfhood" 허구 도서)
> 범위: 코드 딥 분석 + 양질 글 작성 성능 향상 + 장기 비전

---

## 우선순위 [확정]

```
1순위: 젬스(GEMS) + 포스(POS) 양쪽 글 작성 성능 개선
  → 양질의 블로그 글 작성 능력 향상
  → 최신 SEO/AEO/GEO 기술 적용
  → 자연스러운 한국어 표현 강화

2순위: 젬스 도서리뷰 hallucination 수정
  → 허구 도서 생성 방지
  → API 키 설정 + 검증 로직 추가
```

---

## 1. 핵심 문제: AI Hallucination

### 발견

- 2026-03-28 젬스가 도서 리뷰로 "Composing Selfhood" (Stuart Ives Barbier 저)를 작성
- 해당 도서는 **실제로 존재하지 않는 허구**
- 저자명도 실존하지 않음 (Ives, Barbier 각각 실존 성씨를 조합한 hallucination)

### 원인 가설 (코드 분석 필요)

```
book-research.js 경로:
  1순위: 네이버 책 API → NAVER_CLIENT_ID/SECRET 필요
  2순위: Google Books API → GOOGLE_BOOKS_API_KEY 필요
  폴백:  하드코딩된 베스트셀러 목록에서 랜덤 선택

가설 A: API 키 미설정 → 폴백 동작 → 폴백 목록에 없는 도서 → ???
가설 B: API 검색 성공했지만 GPT-4o가 검색 결과를 무시하고 자체 생성
가설 C: book_info가 gems-writer에 전달되지 않아 GPT-4o가 자유 생성
```

### 해결 전략 (5중 방어)

```
Layer 1: 도서 실존 확인 (book-research.js 강화)
  - researchBook() 결과에 source 필드 확인
  - source가 'naver' 또는 'google'이 아니면 → 도서 리뷰 중단
  - ISBN 유효성 검증 추가
  - 네이버 API 키 설정 상태 사전 점검

Layer 2: LLM 프롬프트 강화 (gems-writer.js)
  - "제공된 도서 정보만 사용. 도서를 지어내지 마라"
  - "ISBN이 없는 도서는 리뷰하지 마라"
  - 도서 정보가 없으면 해당 카테고리 스킵 → 다음 카테고리로 순환

Layer 3: 품질 검증 강화 (quality-checker.js)
  - 도서 리뷰 카테고리일 때: 도서 제목 + 저자명 실존 확인
  - 네이버 책 API로 post-verification
  - 검증 실패 시 발행 차단

Layer 4: 표현 자연스러움 검증
  - "20도의 날씨가 너무 좋다" → ❌ (수치 기반, 기계적)
  - "날씨가 매우 좋다" → ✅ (자연스러운 한국어)
  - 기온/습도 등 수치를 직접 서술하지 않는 규칙
  - 자연스러운 감성 표현 패턴 라이브러리 구축

Layer 5: 사후 검증 + 피드백 루프
  - 발행 전 마스터 승인 옵션 (고위험 카테고리)
  - 발행 후 RAG에 저장 → 과거 리뷰와 중복/유사도 체크
```

---

## 2. 불변 원칙: 에이전트가 지켜야 할 것

```
❌ 절대 금지:
  - 존재하지 않는 도서/논문/사람을 지어내는 것
  - 사실이 아닌 내용을 사실처럼 서술하는 것
  - 수치를 직접 나열하는 기계적 표현
    (❌ "20도의 맑은 날씨" → ✅ "창밖으로 봄바람이 살랑이는 오후")

✅ 반드시 지킬 것:
  - 모든 사실적 주장은 검증 가능한 소스 기반
  - 도서 리뷰는 실존 도서만 (API 검증 필수)
  - 자연스러운 한국어 감성 표현
  - 글을 읽는 사람이 "사람이 쓴 글"이라고 느낄 것
```

---

## 3. 장기 비전: 주제 기반 글 작성 서비스

### 현재 (v1.0)
```
블로(팀장) → 카테고리 자동 순환 → 젬스/포스 작성 → 네이버 블로그 발행
- 내부용: 커피랑도서관 블로그 전용
- 자동화: launchd 매일 실행
```

### 미래 (v2.0)
```
사용자 → 주제 입력 → 블로팀 파이프라인 → 고품질 글 생성
- 외부용: 다른 사람이 주제를 입력하면 맞춤 글 작성
- API: POST /blog/generate { topic, style, length }
- 검증: 5중 방어 (hallucination 차단 + 품질 + 자연스러움)
- 피드백: 발행 후 성과 → RAG → 다음 글 품질 개선
```

### 기술 로드맵
```
Phase 1 (지금): hallucination 방지 + 품질 강화
Phase 2: 퍼블 네이버 자동 발행 완성
Phase 3: 외부 주제 입력 → 글 생성 API
Phase 4: 성과 피드백 루프 (조회수/체류시간 → 학습)
Phase 5: 멀티 플랫폼 (네이버 + 티스토리 + 워드프레스)
```

---

## 4. 코드 딥 분석 프레임워크 (다음 세션)

### 분석 대상 (7,467줄, 25파일)

```
★ 1순위 — 글 작성 성능 (젬스 + 포스 공통):
  lib/gems-writer.js     1027줄  ← 일반 포스팅 작성 (LLM 프롬프트 핵심)
  lib/pos-writer.js       632줄  ← 강의 포스팅 작성 (LLM 프롬프트 핵심)
  lib/maestro.js          342줄  ← LLM 호출 래퍼 (모델 선택, 토큰 관리)
  lib/quality-checker.js  147줄  ← 품질 검증 (AI 탐지 리스크 포함)
  lib/richer.js           252줄  ← 정보 수집 (뉴스/날씨/SEO — 글 소재)
  lib/section-ratio.js    149줄  ← 섹션 비율 조정
  lib/bonus-insights.js   171줄  ← 추가 인사이트 생성

★ 2순위 — 도서리뷰 이슈:
  lib/book-research.js    207줄  ← 도서 검색 (hallucination 근원)

파이프라인/오케스트레이션:
  lib/blo.js              714줄  ← 팀장, 전체 파이프라인 오케스트레이션
  lib/daily-config.js     (크기 미확인) ← 일일 설정
  lib/category-rotation.js 102줄  ← 카테고리 순환
  lib/pipeline-store.js   (크기 미확인) ← 파이프라인 상태

발행/콘텐츠:
  lib/publ.js             342줄  ← 발행 (네이버 블로그)
  lib/schedule.js         218줄  ← 발행 스케줄
  lib/social.js           232줄  ← 소셜 미디어
  lib/img-gen.js          486줄  ← 이미지 생성
  lib/star.js             284줄  ← 별점/평가

커리큘럼/피드백:
  lib/curriculum-planner.js 582줄  ← 강의 커리큘럼
  lib/ai-feedback.js      207줄  ← AI 피드백 루프
  lib/runtime-config.js   101줄  ← 런타임 설정

인프라:
  api/node-server.js      438줄  ← HTTP 서버
  scripts/run-daily.js    (크기 미확인) ← 일일 실행
  scripts/health-check.js 254줄  ← 헬스체크
```

### 1차 분석 완료 (이번 세션)

```
[✅] config.json: LLM 체인 구조 분석 (GPT-4o → GPT-4o-mini → Gemini Flash)
[✅] book-research.js: 전체 207줄 분석 완료 — hallucination 근본 원인 추적
[✅] quality-checker.js: 전체 147줄 분석 완료 — AI 탐지 리스크 6개 항목
[✅] gems-writer.js: 시스템 프롬프트 + 도서리뷰 블록 + 섹션 구조 분석
[✅] blo.js: 도서리뷰 파이프라인 경로 추적 (273~310줄)
[✅] DB 분석: posts/publish_schedule 테이블 — hallucination 증거 확보
[✅] 2026 SEO/AEO/GEO 최신 트렌드 리서치
```

### 미분석 (다음 세션)

```
[ ] pos-writer.js: 강의 포스팅 프롬프트 + 품질 → 1순위
[ ] gems-writer.js 나머지: writeGeneralPost/writeGeneralPostChunked 상세
[ ] richer.js: 정보 수집 소스/품질 분석
[ ] maestro.js: LLM 호출 구조, 에러 처리, 재시도
[ ] blo.js 전체: 파이프라인 흐름 + 에러 처리
[ ] publ.js: 네이버 발행 자동화 상태
[ ] ai-feedback.js: 피드백 루프 동작 여부
[ ] curriculum-planner.js: 강의 커리큘럼 품질
```

---

## 5. 최신 블로그 기술 반영 (리서치 대상)

```
[ ] 2026 네이버 알고리즘 변화 (신뢰도 중심 랭킹)
[ ] AI 콘텐츠 탐지 우회 최신 기법
[ ] AEO (AI Engine Optimization) 구조화 전략
[ ] GEO (Generative Engine Optimization) AI 출처 인용 최적화
[ ] E-E-A-T (Experience, Expertise, Authority, Trust) 강화
[ ] 내부 링킹 자동화 (RAG 기반 관련 포스팅 추천)
[ ] 발행 성과 피드백 루프 (조회수 → 학습 → 다음 글 반영)
```

---

## 6. 다음 세션 액션 플랜

```
1. 블로팀 코드 딥 분석 (book-research.js부터)
   → hallucination 발생 정확한 경로 추적
   → API 키 설정 상태 확인
   → gems-writer.js LLM 프롬프트 분석

2. 최신 블로그 기술 리서치 (웹 검색)
   → 2026 네이버 알고리즘 + SEO/AEO/GEO

3. 코덱스 프롬프트 작성
   → hallucination 방지 5중 방어 구현
   → 자연스러운 표현 규칙 적용
   → 품질 검증 강화

4. 코덱스 구현 → 메티 점검 → 마스터 승인
```
