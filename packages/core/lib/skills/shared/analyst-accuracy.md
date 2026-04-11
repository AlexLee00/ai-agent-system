# Analyst Accuracy

## 목적
루나팀 분석가(aria, sophia, oracle, hermes)의 정확도 집계와 가중치 자동 조정 규칙을 문서화한다.

## 입력/출력
- 입력:
  - `trade_review`
  - `runtime_config.luna.analystWeights`
  - `analyst-weight-overrides.json`
- 출력:
  - 주간 정확도 리포트
  - 가중치 조정 제안
  - 3주 연속 저성과 알림
  - 적용된 effective analyst weights

## 핵심 함수 API
- `buildAccuracyReport({ days, weeksAgo } = {})`
- `checkConsecutiveLowWeeks(botName, nWeeks = 3)`
- `adjustAnalystWeights({ persist = true } = {})`
- `getEffectiveAnalystWeightProfiles()`

## 조정 규칙
- 주간 정확도 `70%+` → `+0.05`
- 주간 정확도 `50% 미만` → `-0.05`
- 최소 `0.05`, 최대 `0.40`
- `0.00`으로 꺼진 프로필은 자동 활성화하지 않는다.
- 실제 조정 대상만 경고한다.

## 저장 정책
- 원본 설정은 `config.yaml`
- 자동 조정 결과는 `bots/investment/data/analyst-weight-overrides.json`
- 실시간 판단 경로에서는 무거운 주간 조정 로직을 다시 돌리지 않고 effective weights만 읽는다.

## 사용 예시
```ts
import {
  adjustAnalystWeights,
  getEffectiveAnalystWeightProfiles,
} from '../../../../bots/investment/shared/analyst-accuracy.ts';

const preview = await adjustAnalystWeights({ persist: false });
const weights = getEffectiveAnalystWeightProfiles();
```

## 운영 포인트
- 주간 리뷰 스크립트가 자동 조정 진입점이다.
- 거래가 없는 주간에도 루틴은 실행되도록 설계돼 있다.
- 테스트 환경에서는 `dry-run`으로 먼저 결과를 보는 것이 안전하다.

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/analyst-accuracy.ts`
