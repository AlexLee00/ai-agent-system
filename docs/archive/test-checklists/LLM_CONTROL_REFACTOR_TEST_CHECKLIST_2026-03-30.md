# LLM Control / Runtime Refactor 테스트 체크리스트 — 2026-03-30

> 범위:
> - `llm-control` 서비스 계층 신설
> - `speed-test.js` 본체 분리 (`tester`, `tester-support`, `snapshot`, `service`)
> - `llm-selector-report.js` 공용 서비스 연동
> - 팀별 `runtime-config.js` 공용 loader 적용

---

## 1. 코드 점검

### 변경 범위

- `packages/core/lib/llm-control/service.js`
- `packages/core/lib/llm-control/snapshot.js`
- `packages/core/lib/llm-control/tester-support.js`
- `packages/core/lib/llm-control/tester.js`
- `packages/core/lib/runtime-config-loader.js`
- `scripts/llm-selector-report.js`
- `scripts/speed-test.js`
- `bots/orchestrator/lib/runtime-config.js`
- `bots/worker/lib/runtime-config.js`
- `bots/blog/lib/runtime-config.js`
- `bots/reservation/lib/runtime-config.js`
- `bots/ska/lib/runtime-config.js`
- `bots/investment/shared/runtime-config.js`

### 확인 결과

- [x] `selector`, `snapshot`, `tester` 역할이 분리됨
- [x] `speed-test.js`가 CLI wrapper 성격으로 단순화됨
- [x] `llm-selector-report.js`가 speed snapshot 파일을 직접 읽지 않음
- [x] 팀별 `runtime-config` 중복 merge/parse 로직이 공용 loader로 이동함
- [x] `investment`는 legacy `capital_management` 호환을 유지함

### 코드 점검 판정

- 명확한 기능 회귀 버그는 발견하지 못함
- 다만 `worker/blog`는 기존보다 runtime config가 캐시되므로, 프로세스 재시작 없이 설정 파일 변경을 즉시 반영하던 운영 습관이 있었다면 동작 체감이 달라질 수 있음

---

## 2. 소프트 테스트

### 2-1. 문법 검사

- [x] `packages/core/lib/llm-control/snapshot.js`
- [x] `packages/core/lib/llm-control/service.js`
- [x] `packages/core/lib/llm-control/tester-support.js`
- [x] `packages/core/lib/llm-control/tester.js`
- [x] `packages/core/lib/runtime-config-loader.js`
- [x] `scripts/llm-selector-report.js`
- [x] `scripts/speed-test.js`
- [x] `bots/orchestrator/lib/runtime-config.js`
- [x] `bots/worker/lib/runtime-config.js`
- [x] `bots/blog/lib/runtime-config.js`
- [x] `bots/reservation/lib/runtime-config.js`
- [x] `bots/ska/lib/runtime-config.js`
- [x] `bots/investment/shared/runtime-config.js`

결과:

```text
SYNTAX_OK
```

### 2-2. 모듈 로드 테스트

- [x] `llm-control/service` export 확인
- [x] `tester-support` export 확인
- [x] `orchestrator/worker/blog/reservation/ska` runtime getter 로드 확인
- [x] `investment/shared/runtime-config.js` getter 로드 확인

결과:

```json
{"keys":["function","function","function","function","function"]}
{"orchestrator":true,"worker":true,"blog":true,"reservation":true,"ska":true}
{"runtime":true,"luna":true,"llm":true,"dedupe":true}
```

---

## 3. 하드 테스트

### 3-1. selector report 실제 실행

- [x] `node scripts/llm-selector-report.js --json`

결과:

- JSON 정상 출력
- speed snapshot이 없을 때도 리포트 생성 정상

### 3-2. speed snapshot round-trip

- [x] 임시 `HOME`에서 `writeLatestSpeedSnapshot()` 실행
- [x] 같은 경로에서 `loadLatestSpeedSnapshot()` 재로드
- [x] `llm-selector-report.js --json`이 저장된 snapshot을 읽는지 확인

결과:

```json
{"latestSaved":true,"historySaved":true,"model":"openai/gpt-4o-mini","ttft":123}
```

리포트 결과:

- `speedTest.capturedAt` 존재
- `speedTest.results[0].modelId == "openai/gpt-4o-mini"`

### 3-3. speed-test 실제 실행 경로

- [x] 임시 `HOME`에 최소 `openclaw.json` / `auth-profiles.json` 구성
- [x] `node scripts/speed-test.js --model=ollama --runs=1` 실행

결과:

- 스크립트 기동 정상
- 모델 필터링 정상
- snapshot 저장 정상
- 실제 모델 호출은 로컬 Ollama 미구동/샌드박스 제한으로 실패
- 종료 코드는 의도대로 실패(`2`)

판정:

- 리팩터링된 실행 경로는 정상
- 실패 원인은 환경(로컬 Ollama 미가동 또는 소켓 제한), 코드 구조 문제는 아님

---

## 4. 최종 판정

### 통과

- [x] 코드 구조 단순화
- [x] 공용 서비스 계층 도입
- [x] selector / snapshot / tester 연동 유지
- [x] runtime-config 공용화
- [x] 문법 검사 통과
- [x] 공용 계층 round-trip 테스트 통과
- [x] 실제 스크립트 기동 테스트 통과

### 보류 / 잔여 리스크

- [ ] 실제 외부 API가 연결된 speed-test 전체 성공 케이스는 아직 확인하지 못함
- [ ] `worker/blog` runtime-config 캐시화가 운영상 기대와 완전히 일치하는지는 배포 후 관찰 필요

---

## 5. 브리핑 요약

### 잘 된 점

- `speed-test`와 `selector`가 이제 코드 구조상 같은 시스템으로 묶였다
- snapshot 저장/조회 경로가 공용화돼 이후 피드백 루프 확장에 유리하다
- 팀별 runtime-config 중복 로직이 많이 줄어 유지보수성이 좋아졌다

### 확인된 한계

- 실제 외부 provider를 때리는 full hard test는 네트워크/로컬 서비스 상태에 영향을 받는다
- 이번 테스트에서는 공용 계층과 스크립트 기동 경로까지는 확인했고, 외부 API 성공 여부는 별도 운영 환경 검증이 필요하다

### 결론

**이번 리팩터링은 구조적 목표를 달성했고, 소프트 테스트와 가능한 하드 테스트 범위에서는 모두 양호하다.**
