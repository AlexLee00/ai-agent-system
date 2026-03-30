# 블로팀 코드 딥 분석 결과 — 2026-03-30

> 분석: 메티 (전략+설계)
> 범위: 7,467줄 / 25파일 전체 분석 완료
> 우선순위: 1순위=성능 개선, 2순위=hallucination 수정

---

## 분석 완료 파일 (전체)

| 파일 | 줄수 | 역할 | 분석 |
|------|------|------|------|
| config.json | 71 | LLM 체인 설정 | ✅ GPT-4o→mini→Gemini Flash |
| blo.js | 714 | 팀장 파이프라인 | ✅ 전체 흐름 추적 |
| gems-writer.js | 1027 | 일반 포스팅 | ✅ 프롬프트+구조+보정 |
| pos-writer.js | 632 | 강의 포스팅 | ✅ 프롬프트+이어쓰기+분할 |
| maestro.js | 342 | 컨트롤타워 | ✅ 변형+n8n+서킷브레이커 |
| richer.js | 252 | 정보 수집 | ✅ HN+Node.js+날씨+RAG |
| quality-checker.js | 147 | 품질 검증 | ✅ 6항목 AI탐지 리스크 |
| book-research.js | 207 | 도서 검색 | ✅ hallucination 근원 |
| bonus-insights.js | 171 | 보너스 인사이트 | ✅ POS/GEMS/STAR 풀 |
| section-ratio.js | 149 | 섹션 배분 | ✅ 동적 글자수 계산 |
| publ.js | 342 | 발행+HTML+DB | ✅ 파일+링크+RAG |
| ai-feedback.js | 207 | 피드백 루프 | ✅ 커리큘럼 전용 |

---

## 1순위: 글 작성 성능 — 핵심 발견

### F1. 젬스(general) 글자수 심각 미달

```
DB 통계:
  general 평균: 5,963자 (목표 7,000~8,000자)
  general 최소: 375자 (완전 실패)
  general 최대: 11,023자

  lecture 평균: 8,636자 (목표 9,000자) — 상대적 양호
  lecture 최소: 6,663자
  lecture 최대: 10,447자
```

원인: gems-writer의 프롬프트가 6,000자 이상만 요구 (MIN_CHARS general=7,000과 불일치)
→ 수정: 프롬프트의 글자수 요구를 MIN_CHARS와 일치시키기

### F2. 날씨 표현 기계적 — _weatherToContext() 수치 직접 노출

```javascript
// pos-writer.js / gems-writer.js 공통 문제
if (weather.temperature < 10) 
  return `기온 ${temp}${feels}의 쌀쌀한 오늘, 커피 한 잔이 생각나는`;
//       ^^^^^^^^ ❌ "기온 8°C (체감 5°C)의 쌀쌀한 오늘"
```

불변 원칙 위반: "20도의 날씨" 같은 수치 서술 금지
→ 수정: 수치 제거, 감성 표현으로 전환

### F3. 품질 검증이 너무 관대

```
quality-checker.js 문제:
  REQUIRED_SECTIONS general = ['스니펫', '인사말', '해시태그']
  → 본론 섹션 3개 누락해도 passed = true!
  → AI 탐지 리스크 high(50+)여도 발행 차단 안 함 (warn만)
```

→ 수정: 필수 섹션 확대 + AI 리스크 high 시 차단 or 재생성

### F4. 프롬프트 과도 복잡 — LLM 규칙 준수율 저하

```
GEMS_SYSTEM_PROMPT: 약 2,500자 분량
  - 필수 작성 규칙 10개
  - 필수 구조 19개 섹션
  - 카테고리별 방향 7개
  - 홍보 키워드 5개
  → GPT-4o가 모든 규칙을 동시에 따르기 어려움
  → 중요 규칙(글자수, 자연스러움)이 덜 중요한 규칙에 묻힘
```

→ 수정: 핵심 규칙 우선순위화, 프롬프트 구조화

### F5. 피드백 루프 부재 — 글 품질 학습 없음

```
ai-feedback.js: 커리큘럼 제안 전용
→ 글 품질 피드백(조회수, 체류시간, AI 리스크 점수)이 
  다음 글 생성에 반영되지 않음
→ 같은 실수 반복 가능
```

### F6. 잘 설계된 부분 (유지)

```
✅ maestro.js: 변형 다양성(인사말/카페위치/리스트) + 7일 패턴 회피
✅ bonus-insights.js: POS/GEMS별 보너스 풀 + 중복 회피
✅ section-ratio.js: 동적 글자수 배분 + ±20% 지터
✅ richer.js: RAG 실전 사례 + 관련 포스팅 내부 링킹
✅ publ.js: HTML 변환 + DB 기록 + RAG 저장 + 중복 방지
✅ blo.js: n8n→directRunner 폴백 + trace_id + State Bus
```

---

## 2순위: 도서리뷰 Hallucination — 근본 원인

### 경로 추적 (DB 증거 기반)

```
publish_schedule ID 38:
  book_title: "Composing Selfhood"   ← 허구
  book_author: "Stuart Ives Barbier" ← 허구
  book_isbn: (빈값)                  ← API 검증 안 됨

NAVER_CLIENT_ID: 미설정 (launchctl, .zprofile, ai.env.setup 모두 없음)
```

### 원인 체인

```
1. NAVER_CLIENT_ID 미설정 → searchNaverBook() 즉시 null 반환
2. GOOGLE_BOOKS_API_KEY 미설정 가능 → searchGoogleBook() 실패
3. getFallbackBook() → 폴백 도서 반환 (예: "클린 코드")
4. blo.js → researchBook() 성공, book_info에 폴백 도서 설정
5. gems-writer.js → _buildBookReviewBlock(book_info) 실행
6. GPT-4o가 폴백 도서 대신 자체 도서를 hallucinate
   (또는: book_info 전달 실패 시 도서 자체 생성)
7. 생성된 제목이 updateBookInfo()로 schedule에 기록
```

핵심: **API 검증 없는 도서 정보 + LLM의 자유 생성 허용**

---

## 개선 계획 — 코덱스 프롬프트 범위

### P1: 날씨 표현 자연스럽게 (pos-writer + gems-writer)

```
수정 대상: _weatherToContext() 함수 (양쪽 writer)
Before: "기온 20°C (체감 18°C)의 쾌청한 오늘, 습도 45%"
After:  "봄바람이 살랑이는 오후" / "빗소리가 창밖으로 들리는 아침"

원칙: 기온/습도 수치 절대 미포함. 감성 표현만.
```

### P2: 품질 검증 강화 (quality-checker.js)

```
수정 1: REQUIRED_SECTIONS general 확대
  현재: ['스니펫', '인사말', '해시태그']
  변경: ['스니펫', '인사말', '본론', '마무리', '해시태그']

수정 2: AI 탐지 high(50+) 시 passed=false
  현재: warn만 출력
  변경: passed=false → 초안 보정 트리거

수정 3: 수치 서술 탐지 추가
  정규식: /[0-9]+도|[0-9]+°C|습도\s*[0-9]+%/
  → "20도의 날씨" 패턴 발견 시 riskScore += 15
```

### P3: 프롬프트 최적화 (gems-writer + pos-writer)

```
수정 1: 글자수 요구를 MIN_CHARS와 일치
  gems: 프롬프트 "6,000자 이상" → "7,000자 이상"
  
수정 2: 핵심 규칙 상단 배치 + ★ 강조
  [최우선 규칙 — 이것만 못 지키면 실패]
  1. 글자수 7,000자 이상
  2. 모든 필수 섹션 빠짐없이
  3. 자연스러운 한국어 (수치 서술 금지)
  4. _THE_END_ 마커

수정 3: 불변 원칙 프롬프트에 삽입
  "존재하지 않는 도서/논문/사람을 지어내지 마라"
  "기온/습도 수치를 직접 서술하지 마라"
```

### P4: 도서리뷰 hallucination 방지

```
수정 1: book-research.js — source 검증
  researchBook() 결과에서 source가 'naver'|'google'이 아니면
  → book_info = null로 설정

수정 2: blo.js — book_info null이면 카테고리 스킵
  if (needsBook && !book_info?.isbn) {
    console.warn('도서 정보 미확보 → 도서리뷰 스킵, 다음 카테고리로');
    return advanceGeneralCategory(); // 다음 카테고리
  }

수정 3: gems-writer.js — 도서 프롬프트 강화
  "[절대 규칙] 위에 제공된 도서만 리뷰하라.
   도서 정보가 없으면 리뷰를 작성하지 마라.
   ISBN이 없는 도서는 존재하지 않는 도서로 간주한다."

수정 4: quality-checker.js — 도서리뷰 post-verification
  카테고리가 '도서리뷰'일 때:
  → 제목에서 도서명 추출 → 네이버 책 API로 실존 확인
  → 미확인 시 passed=false
```

### P5: 2026 SEO/AEO/GEO 최신 기술 적용

```
리서치 결과 핵심:
  - SEO → AEO/GEO 전환 가속 (AI 답변 내 브랜드 노출이 핵심)
  - E-E-A-T: 경험+전문성+권위+신뢰 강화
  - 네이버 C-Rank + D.I.A+: 채널 신뢰도 + 문서 품질
  - 질문-답변형 구조 우대 ("~하는 법", "~이란?")
  - 구조화 데이터(표/목차/Q&A)가 AI 요약에 포함
  - LEO(LLMEO): ChatGPT/Claude/Perplexity/Gemini 각각 최적화

적용 대상:
  1. gems-writer GEO_RULES 보강 — 질문형 소제목 권장
  2. pos-writer FAQ → AEO 최적화 형식 ("Node.js에서 ~하는 방법은?")
  3. quality-checker에 구조화 검증 추가:
     - Q&A 형식 FAQ 존재 여부
     - 표/비교 테이블 존재 여부
     - 내부 링킹 3개+ 여부
```

---

## 실행 순서

```
Phase 1 (즉시): P1 + P2 + P3
  → _weatherToContext() 수정 (양쪽 writer)
  → quality-checker 강화
  → 프롬프트 글자수/우선순위 최적화
  → DEV에서 구현 + 검증

Phase 2: P4
  → book-research 검증 강화
  → blo.js 도서리뷰 스킵 로직
  → gems-writer 도서 프롬프트 강화
  → NAVER_CLIENT_ID 설정 확인

Phase 3: P5
  → AEO/GEO 프롬프트 최적화
  → quality-checker 구조화 검증
```
