---
name: Signal Types
description: 루나팀 신호 타입, 상태 상수, 분석가 ID 규약 문서
type: reference
---

# Signal Types

## 목적
루나팀 전체가 공유하는 신호(매매 지시) 타입과 상태 상수를 정의한다.
모든 에이전트는 이 규약을 따라야 신호 파이프라인이 일관되게 동작한다.

## 핵심 상수

### ACTIONS (매매 방향)
```ts
ACTIONS.BUY   = 'BUY'    // 매수
ACTIONS.SELL  = 'SELL'   // 매도
ACTIONS.HOLD  = 'HOLD'   // 관망
```

### SIGNAL_STATUS (파이프라인 상태)
```ts
SIGNAL_STATUS.PENDING   = 'PENDING'    // 분석 대기
SIGNAL_STATUS.EVALUATED = 'EVALUATED'  // 루나 판단 완료
SIGNAL_STATUS.APPROVED  = 'APPROVED'   // 네메시스 승인
SIGNAL_STATUS.REJECTED  = 'REJECTED'   // 네메시스 거절
SIGNAL_STATUS.EXECUTED  = 'EXECUTED'   // 헤파이스토스 체결
SIGNAL_STATUS.FAILED    = 'FAILED'     // 체결 실패
SIGNAL_STATUS.CANCELLED = 'CANCELLED'  // 취소
```

### ANALYST_TYPES (분석가 ID)
```ts
ANALYST_TYPES.TECHNICAL  = 'aria'      // 기술 분석
ANALYST_TYPES.SENTIMENT  = 'sophia'    // 감성 분석
ANALYST_TYPES.NEWS       = 'hermes'    // 뉴스/매크로
ANALYST_TYPES.ONCHAIN    = 'oracle'    // 온체인/파생상품
ANALYST_TYPES.COMBINED   = 'luna'      // 종합 판단 (팀장)
```

## 신호 객체 구조
```ts
interface Signal {
  id?: number;
  symbol: string;           // 'BTC/USDT', '005930.KS' 등
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;       // 0.0~1.0
  reasoning: string;        // 한국어 근거
  amount_usdt?: number;     // 거래 금액 (USD)
  exchange?: string;        // 'binance' | 'kis' | 'kis_overseas'
  trade_mode?: string;      // 'live' | 'paper' | 'mock'
  status?: string;          // SIGNAL_STATUS
  scoutData?: object;       // 스카우트 인텔
}
```

## 사용 규칙
- 모든 분석가는 `{ action, confidence, reasoning }` 최소 필드 반환
- `confidence < 0.5` 이면 HOLD 권장 (ACTIONS.HOLD 반환)
- `reasoning` 은 반드시 한국어, 2문장 이내
- 네메시스 통과 시 `status = APPROVED` + `amount_usdt` 확정

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/signal.ts`
