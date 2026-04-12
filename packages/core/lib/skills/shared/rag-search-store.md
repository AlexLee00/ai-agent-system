# RAG Search Store

## 목적
루나팀과 공용 봇들이 쓰는 RAG 검색/저장 인터페이스를 정리한다.
대상은 safe wrapper를 통한 `search`, `store`, `storeBatch`, guard status 확인이다.

## 입력/출력
- 입력:
  - `collection`
  - `query`
  - `opts?`
  - `meta?`
  - `content`
  - `metadata?`
  - `sourceBot?`
- 출력:
  - `search`: 검색 결과 배열
  - `store`: 저장 결과
  - `storeBatch`: 배치 저장 결과
  - `getRagGuardStatus`: guard 상태 객체

## 핵심 함수 API
- `getRagGuardStatus()`
- `initSchema()`
- `search(collection, query, opts = {}, meta = {})`
- `store(collection, content, metadata = {}, sourceBot = 'luna')`
- `storeBatch(collection, items, sourceBot = 'luna')`

## 사용 규칙
- 직접 raw RAG 모듈 대신 safe wrapper를 우선 사용한다.
- guard가 닫혀 있거나 DB가 막히면 best-effort로 동작해야 한다.
- 실시간 경로에서는 저장 실패를 hard fail로 다루지 않는다.

## 사용 예시
```ts
import { search, store } from '../../../../bots/investment/shared/rag-client.ts';

const docs = await search('investment_memory', 'BTC breakout');
await store('investment_memory', 'breakout recap', { symbol: 'BTC/USDT' }, 'luna');
```

## 주의사항
- 컬렉션명과 메타데이터 스키마는 호출자 레이어에서 일관되게 관리해야 한다.
- guard 상태는 운영 환경별로 다를 수 있으므로, 검색 결과가 비어도 바로 장애로 해석하지 않는다.

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/rag-client.ts`

