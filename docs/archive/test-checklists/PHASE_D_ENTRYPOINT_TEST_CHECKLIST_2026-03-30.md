# Phase D 엔트리포인트 Hub 연결 테스트 체크리스트 — 2026-03-30

> 범위:
> - Phase D 엔트리포인트 Hub 초기화 연결
> - `investment` 3개 market 엔트리포인트
> - `claude` / `blog` / `worker` 실사용 엔트리포인트
> - 관련 안전 보정 및 공용 리팩터링

---

## 1. 코드 점검

### 변경 파일

- `bots/investment/markets/crypto.js`
- `bots/investment/markets/domestic.js`
- `bots/investment/markets/overseas.js`
- `bots/investment/shared/secrets.js`
- `bots/claude/src/dexter.js`
- `bots/claude/src/archer.js`
- `bots/claude/src/claude-commander.js`
- `bots/blog/scripts/run-daily.js`
- `bots/blog/api/node-server.js`
- `bots/worker/src/worker-lead.js`
- `bots/worker/src/task-runner.js`

### 공용 리팩터링 포함 범위

- `packages/core/lib/llm-control/service.js`
- `packages/core/lib/llm-control/snapshot.js`
- `packages/core/lib/llm-control/tester-support.js`
- `packages/core/lib/llm-control/tester.js`
- `packages/core/lib/runtime-config-loader.js`
- `scripts/llm-selector-report.js`
- `scripts/speed-test.js`
- `bots/*/runtime-config.js` 일괄 공용화

### 점검 결과

- [x] 투자팀 엔트리포인트는 `initHubSecrets()`를 시작 지점에서 호출
- [x] `claude/blog/worker` 엔트리포인트는 `initHubConfig()`를 시작 지점에서 호출
- [x] `orchestrator/mainbot`은 LLM 키 직접 의존이 없어 Phase D 제외
- [x] DEV에서 Hub 경유 시 `investment`가 live로 흘러갈 수 있던 위험을 발견
- [x] `investment/shared/secrets.js`에 DEV paper-safe 보정 추가

### 코드 점검 판정

- Phase D 연결 자체는 설계 의도와 일치
- 푸시 전 반드시 필요했던 DEV 안전 보정까지 반영 완료

---

## 2. 소프트 테스트

### 2-1. 문법 검사

- [x] `bots/investment/markets/crypto.js`
- [x] `bots/investment/markets/domestic.js`
- [x] `bots/investment/markets/overseas.js`
- [x] `bots/claude/src/dexter.js`
- [x] `bots/claude/src/archer.js`
- [x] `bots/claude/src/claude-commander.js`
- [x] `bots/blog/scripts/run-daily.js`
- [x] `bots/blog/api/node-server.js`
- [x] `bots/worker/src/worker-lead.js`
- [x] `bots/worker/src/task-runner.js`
- [x] `bots/investment/shared/secrets.js`
- [x] `packages/core/lib/llm-control/*.js`
- [x] `packages/core/lib/runtime-config-loader.js`

결과:

```text
SYNTAX_OK
```

### 2-2. 로컬 폴백 경로

- [x] `USE_HUB_SECRETS=false`에서 `initHubConfig()` 후 LLM 키 로드 정상
- [x] `USE_HUB_SECRETS=false`에서 `initHubSecrets()` 후 investment 로컬 설정 유지

결과:

```json
{"anthropic":true}
{"paper":true,"trading":"paper","anthropic":true}
```

### 2-3. 리팩터링 공용 계층

- [x] `llm-selector-report.js --json` 실행 정상
- [x] `llm-control` snapshot write/load round-trip 정상
- [x] 팀별 runtime-config getter 로드 정상

---

## 3. 하드 테스트

### 3-1. Hub health

- [x] `curl http://127.0.0.1:17788/hub/health`

결과:

- `status=ok`
- `mode=ops`
- `postgresql ok`
- `n8n ok`

### 3-2. LLM Hub 경유

환경:

- `. ~/.zprofile`
- `USE_HUB_SECRETS=true`
- `HUB_BASE_URL=http://127.0.0.1:17788`
- `HUB_AUTH_TOKEN` 로드

- [x] `initHubConfig()` 성공
- [x] `getAnthropicKey()` truthy

결과:

```json
{"hub":true,"token":true,"anthropic":true}
```

### 3-3. investment Hub 경유

- [x] `initHubSecrets()` 성공
- [x] DEV paper-safe 보정 적용 확인

결과:

```json
{
  "paper": true,
  "trading": "paper",
  "binance_testnet": true,
  "kis_paper_trading": true,
  "getTradingMode": "paper",
  "isPaperMode": true
}
```

판정:

- Hub 원본이 OPS live config여도, DEV에서는 최종 결과가 paper-safe로 강제됨

### 3-4. speed-test 실행 경로

- [x] 임시 OpenClaw 환경에서 `scripts/speed-test.js` 기동
- [x] 모델 필터링 / snapshot 저장 정상
- [ ] 실제 모델 응답 성공

결과:

- 기동 정상
- snapshot 저장 정상
- 실제 Ollama 호출은 로컬 미구동 또는 샌드박스 제한으로 실패

판정:

- 구조 검증은 통과
- 외부/로컬 모델 응답 성공은 운영 환경 추가 확인 필요

---

## 4. 최종 판정

### 통과

- [x] Phase D 엔트리포인트 연결 완료
- [x] 로컬 폴백 유지
- [x] Hub 경유 LLM 초기화 정상
- [x] Hub 경유 investment 초기화 정상
- [x] DEV paper-safe 보정 확인
- [x] 공용 리팩터링 계층 정상

### 잔여 확인

- [ ] 실제 `blog/worker/claude` 프로세스 풀 런은 배포 후 관찰 필요
- [ ] full speed-test 외부 provider 성공 케이스는 운영 환경에서 추가 확인 권장

---

## 5. 브리핑 요약

### 잘 된 점

- 원래 목표였던 Phase D 엔트리포인트 연결이 완료됐다
- 단순 연결에 그치지 않고 `llm-control`과 `runtime-config`까지 공용화해서 구조가 더 단순해졌다
- 테스트 중 드러난 DEV live 리스크를 실제로 수정했다

### 구조 검토 메모

- `orchestrator/mainbot`은 현재 OpenClaw와 동일 프로세스가 아니다
- `mainbot`은 `mainbot_queue` 소비, 알람 필터링, Telegram 발송 전용이다
- `OpenClaw gateway`는 별도 launchd 서비스(`ai.openclaw.gateway`)로 동작한다
- 따라서 이번 Phase D에서는 `mainbot`을 `initHubConfig()` 연결 대상에서 제외한 판단이 맞다
- 다만 장기적으로는 `mainbot + OpenClaw` 병합 가능성을 검토할 가치가 있다
- 병합 검토의 핵심 기준은 “알람 큐 처리”와 “대화/게이트웨이”를 하나의 런타임으로 묶었을 때 장애 격리, 재시작 단위, 운영 복잡도가 더 좋아지는지 여부다
- 결론: 이번 커밋에서는 분리 유지가 맞고, 다음 구조 정리 단계에서 병합 타당성을 별도 검토한다

### 핵심 결론

**이제 Phase D는 기능적으로 닫혔고, 푸시 가능한 수준이다.**
