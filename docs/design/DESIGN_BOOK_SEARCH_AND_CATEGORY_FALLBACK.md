# DESIGN_BOOK_SEARCH_AND_CATEGORY_FALLBACK.md

## 목적

블로그팀 `도서리뷰` 카테고리에서 랜덤 1권 수집 대신 `후보 검색 -> 선택 -> 검증` 구조로 바꾼다.

또한 도서 관련 API가 모두 실패하거나 검증 가능한 책을 찾지 못하면, 도서리뷰를 억지로 작성하지 않고 즉시 다음 일반 카테고리 포스팅으로 전환한다.

## 핵심 정책

- `랜덤 1권 수집` 금지
- `fallback` 도서는 리뷰 작성에 사용하지 않음
- `ISBN13` 없는 책은 검증 실패
- 국내 도서 API가 모두 실패하면 `도서리뷰 스킵`
- 스킵 시 같은 런에서 `다음 일반 카테고리`를 바로 작성

## 목표 흐름

### 1. 후보 검색

새 함수:

- `searchBookCandidates()`

역할:

- 네이버
- 카카오 또는 알라딘
- Google Books

에서 책 후보를 수집한다.

출력:

```js
[
  {
    title,
    author,
    isbn,
    publisher,
    pubDate,
    description,
    coverUrl,
    source,
  }
]
```

## 2. 후보 선택

새 함수:

- `selectBookCandidate()`

선택 기준:

- `ISBN13` 우선
- 최근 블로그에서 이미 리뷰한 책 제외
- 국내 도서/번역서 우선
- 설명과 표지가 있는 후보 우선
- 같은 책이 여러 소스에 등장하면 우선순위 상승

## 3. 검증

기존 검증 스킬 사용:

- `book-source-verify`

통과 조건:

- `ISBN13` 존재
- 제목 정합성
- 동일 ISBN이 최소 2개 소스에서 확인
- `fallback` source 금지

## 4. writer 전달

검증 통과 시에만:

- `preparedResearch.book_info`
- `schedule.book_*`

를 채운다.

## 5. 실패 시 일반 카테고리 전환

도서 API 전부 실패 또는 검증 실패 시:

1. 현재 `도서리뷰` 런을 종료하지 않는다
2. 다음 일반 카테고리로 한 칸 이동
3. 같은 런에서 새 일반 포스팅을 다시 준비
4. 이때는 도서리뷰가 아닌 일반 카테고리 글로 작성

즉 결과 정책은:

- `도서리뷰` 실패
- `일간 일반 포스팅 수`는 유지
- 허구 도서 리뷰는 0건

## 구현 포인트

### book-research.js

- `searchBookCandidates()`
- `selectBookCandidate()`
- `researchBook()`은 최종 단일 책만 반환하되 내부적으로는 위 두 단계를 거친다

### blo.js

- `_prepareGeneralContext()`에서 `도서리뷰` 후보 검색
- 실패 시 `advanceGeneralCategory()`
- 이후 `_prepareGeneralContext()`를 새 카테고리로 재호출

### schedule

- 검증된 책이 있을 때만:
  - `book_title`
  - `book_author`
  - `book_isbn`
업데이트

실패 시에는:

- `book_verification_failed`
- `book_lookup_skipped`
같은 메타만 남긴다

## 기대 효과

- 허구 도서 리뷰 차단
- 도서 API 장애 시에도 일반 포스팅 발행 유지
- 블로그 운영 안정성 향상
