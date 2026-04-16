---
name: Pipeline Decision Runner
description: 루나팀 전체 매매 파이프라인 오케스트레이터 — 분석→판단→네메시스→체결 전체 흐름 관리
type: reference
---

# Pipeline Decision Runner

## 목적
루나팀의 매매 파이프라인을 오케스트레이션한다.
여러 분석가(aria/sophia/hermes/oracle) 신호를 수집 → 루나 종합 판단 → 네메시스 리스크 평가 → 헤파이스토스/한울 체결까지 전체 흐름을 관리한다.

## 핵심 함수 API
- `runDecisionPipeline(symbol, opts?)` → `PipelineResult`
- `runDecisionPipelineForExchange(exchange, symbol, opts?)` → `PipelineResult`

## 파이프라인 흐름
```
1. 데이터 수집
   aria.ts  → 기술 분석 (RSI/MACD/BB)
   sophia.ts → 감성 분석 (뉴스 감성)
   hermes.ts → 매크로 분석 (뉴스/공시)
   oracle.ts → 온체인 분석 (공포탐욕/펀딩비)

2. 루나 종합 판단 (luna.ts)
   → 가중 투표 → BUY/SELL/HOLD + confidence

3. 네메시스 리스크 평가 (nemesis.ts)
   → 하드룰 체크 → LLM 리스크 평가 → APPROVE/REJECT/ADJUST

4. 체결
   binance → hephaestos.ts
   kis/kis_overseas → hanul.ts
```

## PipelineResult 구조
```ts
{
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  approved: boolean;
  adjustedAmount?: number;
  traceId: string;
  analysts: {
    aria?: AnalystResult;
    sophia?: AnalystResult;
    hermes?: AnalystResult;
    oracle?: AnalystResult;
  };
  lunaDecision?: {
    signal: string;
    confidence: number;
    reasoning: string;
  };
  nemesisVerdict?: string;  // 'APPROVE' | 'REJECT' | 'ADJUST'
  executionResult?: object;
}
```

## 사용 규칙
- `persist: false` 옵션으로 DB 저장 없이 dry-run 가능
- `traceId`는 자동 생성 (`LNA-BTCUSDT-{timestamp}`)
- 분석가 실패는 개별 무시 (partial result 허용)
- 네메시스 REJECT 시 즉시 파이프라인 종료

## 환경 분기
- `trade_mode: 'live'` → 실거래 체결
- `trade_mode: 'paper'` → 모의 기록만 (DB 저장)
- `trade_mode: 'mock'` → 로그만 (DB 저장 없음)

## 주의사항
- 실투자 파이프라인 — tp_sl_set 없이 체결 금지
- 한 번에 최대 6개 포지션 제한 (하드룰)
- 심야(01:00~07:00 KST) BUY 신호 자동 50% 축소

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-decision-runner.ts`
