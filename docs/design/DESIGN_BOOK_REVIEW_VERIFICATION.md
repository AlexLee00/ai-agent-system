# DESIGN_BOOK_REVIEW_VERIFICATION.md

## 목적

블로그팀 `도서리뷰` 카테고리에서 존재하지 않는 책, 잘못된 저자, ISBN 누락 상태의 책을 바탕으로 글이 생성되는 문제를 막는다.

핵심 원칙:

- `fallback` 도서 정보는 리뷰 본문 생성에 사용하지 않는다
- `ISBN13`이 확보되지 않으면 실존 검증 실패로 본다
- 국내 도서 기준 2개 이상 소스에서 제목/저자 정합성이 맞아야 통과한다
- 검증 실패 시 `도서리뷰`는 스킵하고 다음 일반 카테고리로 넘긴다

## 현재 문제

현재 [book-research.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/book-research.js)는 다음 순서로 책 정보를 가져온다.

1. 네이버 책 검색
2. Google Books
3. fallback 책 목록

이 구조는 API가 비어 있거나 실패해도 `book_info`가 생성되기 때문에, writer가 잘못된 책 정보를 바탕으로 리뷰를 작성할 여지가 있다.

## 목표 구조

### 1. 수집

- `searchNaverBook()`
- `searchKakaoBook()` 또는 `searchAladinBook()`
- `searchGoogleBook()`

### 2. 검증 스킬

새 스킬:

- `book-source-verify`

입력:

- `primaryCandidate`
- `secondaryCandidates[]`
- `category`

출력:

- `ok`
- `book`
- `reasons[]`
- `verification`
  - `isbn13`
  - `matched_sources`
  - `title_consistent`
  - `author_consistent`

통과 조건:

- `isbn13` 존재
- `matched_sources >= 2`
- 제목 정규화 후 일치
- 저자 정규화 후 일치
- `source === fallback`이면 실패

### 3. 파이프라인 정책

`blo.js`

- 카테고리가 `도서리뷰`일 때 `researchBook()` 다음에 `book-source-verify` 실행
- 실패 시:
  - `도서리뷰 스킵`
  - 다음 일반 카테고리로 advance
  - schedule 메타에는 `book_verification_failed` 기록

### 4. writer 정책

`gems-writer.js`

- 검증된 `book_info`만 받는다
- 프롬프트에 아래 규칙을 명시:
  - 제공된 책 외의 책을 지어내지 말 것
  - ISBN 없는 책은 실존 검증 실패로 간주
  - 책 정보가 없으면 리뷰를 작성하지 말 것

### 5. post-check 정책

`quality-checker.js`

- 카테고리가 `도서리뷰`일 때 제목/본문의 책명이 검증된 `book_info.title`과 다르면 `passed=false`
- ISBN이 비어 있으면 `passed=false`

## 소스 우선순위

권장 순서:

1. `네이버 책 검색 API`
2. `카카오 책 검색 API` 또는 `알라딘 TTB`
3. `Google Books`

이유:

- 국내 도서는 네이버/카카오/알라딘 쪽 커버리지가 더 현실적이다
- Google Books는 보조 검증 소스로 적합하다

## 운영 원칙

- `도서리뷰`는 `일반 카테고리 중 예외적으로 더 엄격한 검증`을 받는다
- 검증 실패 시 억지로 글을 쓰지 않는다
- 도서리뷰 생산량보다 `허구 리뷰 0건`을 우선한다

## 구현 우선순위

1. `book-source-verify` 스킬 추가
2. `book-research.js`에 2차 국내 소스 추가
3. `blo.js`에서 검증 실패 시 스킵
4. `gems-writer.js` 프롬프트 강화
5. `quality-checker.js` post-verification 추가

## 기대 효과

- 허구 도서 리뷰 차단
- schedule/book metadata 신뢰도 상승
- 블로그팀 `도서리뷰` 카테고리 품질 안정화
