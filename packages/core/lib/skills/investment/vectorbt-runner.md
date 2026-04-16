---
name: VectorBT Runner
description: Python VectorBT 백테스팅 실행 헬퍼 — Node.js에서 Python 백테스트 실행 + 결과 파싱
type: reference
---

# VectorBT Runner

## 목적
Node.js(TypeScript) 환경에서 Python VectorBT 백테스팅 스크립트를 동기 실행하고,
결과를 파싱해 TypeScript 객체로 반환한다.

## 핵심 함수 API
- `runVectorBtBacktest(symbol, days, opts?)` → `VectorBtResult | null`
- `runVectorBtGrid(symbol, days)` → `VectorBtResult[] | null`

## 입력/출력

### runVectorBtBacktest
```ts
runVectorBtBacktest(
  symbol: string,      // 'BTC/USDT'
  days: number,        // 조회 기간 (일)
  opts?: {
    tpPct?: number;    // TP 비율 (예: 0.06 = 6%)
    slPct?: number;    // SL 비율 (예: 0.03 = 3%)
  }
) => {
  status: 'ok' | 'dependency_missing' | 'error';
  sharpe_ratio?: number;
  total_return?: number;    // %
  max_drawdown?: number;    // %
  win_rate?: number;        // 0~1
  total_trades?: number;
  missing?: string[];       // 의존성 부족 시 패키지명
  install?: string;         // pip3 install 명령어
}
```

## 동작 방식
1. `spawnSync('python3', ['scripts/backtest-vectorbt.py', '--symbol', ...])` 동기 실행
2. stdout을 JSON 파싱
3. `dependency_missing` 상태 시 설치 가이드 포함 반환
4. 타임아웃: 60초 (백테스팅 시간 여유)

## 의존성 확인
```bash
python3 -c "import vectorbt; print(vectorbt.__version__)"
python3 -c "import pandas, ccxt"
```

## 설치 (OPS에서 최초 1회)
```bash
pip3 install vectorbt pandas numpy ccxt --break-system-packages
```

## 사용 예시
```ts
import { runVectorBtBacktest, runVectorBtGrid } from '../shared/vectorbt-runner.ts';

// 단일 시나리오 백테스트
const result = runVectorBtBacktest('BTC/USDT', 90, { tpPct: 0.06, slPct: 0.03 });
if (result?.status === 'ok') {
  console.log(`샤프: ${result.sharpe_ratio}, 수익률: ${result.total_return}%`);
}

// 그리드 서치 (여러 TP/SL 조합)
const grid = runVectorBtGrid('BTC/USDT', 90);
grid?.sort((a, b) => (b.sharpe_ratio ?? 0) - (a.sharpe_ratio ?? 0));
```

## 주의사항
- 동기(sync) 실행이므로 Node.js 이벤트 루프 블로킹 주의
- 백테스팅 시간: 30일 약 5~10초, 90일 약 15~30초
- Python 환경 없으면 `dependency_missing` 반환 (throw 없음)

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/vectorbt-runner.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/backtest-vectorbt.py`
