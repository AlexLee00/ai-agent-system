# CODEX_CHRONOS_PHASE_A 테스트 체크리스트

작성일: 2026-03-31  
범위: Chronos Phase A (Layer 1~3 + local-llm-client + OHLCV cache)

## 1. 구현 범위

- [x] `bots/investment/migrations/ohlcv-cache.sql`
- [x] `bots/investment/shared/ohlcv-fetcher.js`
- [x] `bots/investment/shared/ta-indicators.js`
- [x] `packages/core/lib/local-llm-client.js`
- [x] `packages/core/lib/env.js` `LOCAL_LLM_BASE_URL` 추가
- [x] `bots/investment/team/chronos.js` Layer 1~3 확장
- [x] `bots/investment/team/chronos.js` `--max-signals` 테스트 옵션 추가

## 2. 소프트 테스트

- [x] `node --check bots/investment/shared/ohlcv-fetcher.js`
- [x] `node --check bots/investment/shared/ta-indicators.js`
- [x] `node --check packages/core/lib/local-llm-client.js`
- [x] `node --check bots/investment/team/chronos.js`
- [x] `npm install technicalindicators`
- [x] `npm ls technicalindicators --depth=0`

## 3. 하드 테스트

### local-llm-client

- [x] `GET /v1/models` 성공
- [x] `qwen2.5-7b` 응답 성공
- [x] `deepseek-r1-32b` 응답 성공

### OHLCV

- [x] `node bots/investment/shared/ohlcv-fetcher.js --symbol=BTC/USDT --from=2026-03-01 --to=2026-03-03 --timeframe=1h`
- [x] 캔들 49개 수집 확인

### Chronos

- [x] Layer 1
  - `2026-03-01 ~ 2026-03-30` 기준 697개 캔들, 신호/백테스트 결과 생성
- [x] Layer 2
  - `2026-03-01 ~ 2026-03-06 --max-signals=3` 기준 `layer2Status=ok`
- [x] Layer 3
  - `2026-03-01 ~ 2026-03-06 --max-signals=1` 기준 `layer3Status=ok`
  - 최종 `judge.action = SELL`, `finalAction = SELL` 확인

## 4. 보정 사항

- [x] DEV에서 `REDACTED_TAILSCALE_IP:11434` 직접 접근 확인
- [x] deep 모델 응답의 `<think>` / 코드펜스 때문에 JSON 파싱 실패하던 문제 보정
- [x] 테스트 시간을 줄이기 위해 `--max-signals` 옵션 추가

## 5. 현재 판정

- Phase A 핵심 경로 구현 완료
- Layer 1~3 실행 경로 확인 완료
- MLX 연동 정상
- 커밋/푸시 가능 상태

## 6. 남은 개선 아이디어

- Layer 2/3 병렬 처리 또는 배치화
- deep 모델 JSON 강제력 추가 개선
- Chronos 결과 저장 테이블/리포트 구조 추가
