# 블로팀 파이프라인 런타임 정리

## 기준 경로

- 메인 엔트리: `scripts/run-daily.js`
- 최상위 오케스트레이터: `lib/blo.js`
- 실행 백엔드 선택: `lib/maestro.js`
- 노드 API 실행기: `api/node-server.js`
- 세션 저장소: `lib/pipeline-store.js`

## 실행 원칙

1. `blo.js`가 일일 실행과 포스트 실행의 최상위 흐름을 가진다.
2. `maestro.js`는 실행 백엔드를 고른다.
   - 우선: n8n webhook
   - 실패 시: local direct runner
3. `node-server.js`는 개별 노드 실행만 담당한다.
4. 세션 결과는 `pipeline-store`로 회수한다.

## 단계 구분

### 일일 단위

- `prepare daily`
- `run scheduled posts`
- `report results`

### 포스트 단위

- `prepare`
- `execute`
- `finalize`

## 현재 해석

- `n8n`은 메인 백엔드
- `direct runner`는 폴백 백엔드
- `pipeline-store`는 RAG 검색보다 "노드 결과 세션 저장소" 의미가 더 크다

## 다음 구조 후보

- `pipeline-store`를 장기적으로 공용 `pipeline session store`로 승격 검토
- 블로팀/워커팀/루나팀 공통 노드 세션 규약과 연결 검토
