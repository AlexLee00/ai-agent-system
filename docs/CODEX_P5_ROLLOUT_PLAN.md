# CODEX_P5_ROLLOUT_PLAN — 자동배포 기준 시크릿 Hub 전환 계획

> 기준 문서: `docs/CODEX_P5_SECRET_CONNECTOR.md`
> 목적: 자동배포 환경에서 P5를 안전하게 롤아웃하기 위한 실행 계획 확정
> 작성일: 2026-03-30

---

## 1. 결론 요약

P5는 **한 번에 전체 전환하지 않고**, 아래 방식으로 진행하는 것이 가장 자연스럽다.

1. **코드 배포**와 **기능 활성화**를 분리한다.
2. **Hub 1순위 → 로컬 파일 폴백** 구조를 먼저 심는다.
3. **1차는 `llm` + `investment`만 적용**한다.
4. `reservation`은 **2차 배포로 분리**한다.
5. 활성화는 `USE_HUB_SECRETS` 플래그로 마지막에 켠다.

즉:

```text
1차: 호환 코드 배포 (기본은 기존 동작 유지)
2차: Hub 응답/헬스 검증
3차: 플래그 활성화
4차: reservation 별도 전환
```

이 방식이 현재 CI/CD와 가장 잘 맞는다.

---

## 2. 왜 이 방식이 자동배포에 유리한가

현재 배포 흐름:

```text
git push → GitHub Actions CI → self-hosted deploy → git pull → smart-restart
```

이 구조에서는 배포 중간 상태가 잠깐이라도 생긴다.
따라서 새 코드가 들어왔을 때 아래 조건을 만족해야 한다.

- Hub가 아직 준비되지 않아도 서비스가 죽지 않아야 함
- 일부 서비스만 재시작돼도 이전 방식으로 계속 동작해야 함
- 배포 직후 장애가 나면 빠르게 원복할 수 있어야 함

문서 초안의 장점은 이미 여기와 잘 맞는다.

- 새 경로는 `Hub → 실패 시 로컬 폴백`
- 기존 `loadSecrets()` / `getAnthropicKey()` 호출 시그니처 유지
- 하위 호출부 대규모 수정 불필요

즉 자동배포에 필요한 핵심 속성인 **점진 전환 가능성**이 있다.

---

## 3. 현재 코드 기준 현실 제약

### 3-1. OPS 기본 Hub 사용은 아직 바로 못 켠다

`packages/core/lib/env.js` 현재 상태:

- `HUB_BASE_URL`은 DEV에서만 기본값이 생김
- `USE_HUB`도 DEV 전용

따라서 문서의 목표처럼 "OPS/DEV 모두 기본적으로 Hub 시크릿 사용"은
현재 코드 기준으로는 추가 정리가 필요하다.

### 3-2. reservation은 전역 전환 시 깨질 가능성이 높다

`bots/hub/lib/routes/secrets.js`의 `reservation` 카테고리는
운영 전용 자격증명을 의도적으로 마스킹한다.

하지만 예약팀 코드는 다음 패턴이 많다.

```javascript
const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
```

이 경우 Hub를 전역 1순위로 붙이면 일부 운영/관리 스크립트가 바로 깨질 수 있다.

### 3-3. init 함수는 "존재"만으로는 부족하고 시작점 연결이 필요하다

문서의 `initHubConfig()` / `initHubSecrets()`는 방향이 좋다.
하지만 자동배포 후 실제로 Hub를 쓰게 하려면
각 팀의 시작점에서 선초기화가 필요하다.

즉 P5는 아래 두 층으로 나뉜다.

- 1단계: 호환 로더 추가
- 2단계: 실제 시작점에서 활성화

---

## 4. 1차 구현 범위 확정안

### 포함

1. `packages/core/lib/env.js`
   - `USE_HUB_SECRETS` 추가
   - 단, **기본 활성 정책은 보수적**으로 둔다

2. `packages/core/lib/hub-client.js`
   - 신규 생성
   - `fetchHubSecrets(category, timeoutMs=3000)` 구현

3. `packages/core/lib/llm-keys.js`
   - `initHubConfig()` 추가
   - Hub `llm` 카테고리 1순위
   - 로컬 `config.yaml` 폴백 유지

4. `bots/investment/shared/secrets.js`
   - `initHubSecrets()` 추가
   - Hub `config` 카테고리 1순위
   - 기존 `loadSecrets()` 폴백 유지

5. 문법/기능 검증 스크립트
   - `node --check`
   - Hub 연결 단독 테스트
   - 폴백 테스트

### 제외

1. `bots/reservation/lib/secrets.js`의 전면 Hub 전환
2. `OPS 기본 Hub 사용` 강제
3. `Hub 응답 스키마 대개편`
4. `config.yaml 하나로 물리 통합` 작업
5. 전체 팀 시작점에서 일괄 `await initHub...()` 삽입

즉 1차는 **가장 파급효과가 큰 두 계통만 먼저 안전하게 연결**한다.

---

## 5. 1차 구현 후 기대 효과

### 즉시 얻는 효과

- LLM 키 접근 경로 통일 준비 완료
- investment 시크릿 접근 경로 통일 준비 완료
- Hub 장애 시 로컬 폴백으로 운영 안정성 유지
- 자동배포 후에도 중간 상태 장애 가능성 낮음

### 아직 남는 것

- reservation 운영 자격증명 분리 설계
- OPS 기본 활성 정책 정리
- 각 팀 엔트리포인트 선초기화

---

## 6. 플래그 정책 권장안

자동배포 기준으로 가장 자연스러운 플래그 정책은 아래다.

```javascript
const USE_HUB_SECRETS =
  process.env.USE_HUB_SECRETS === 'true';
```

1차에서는 기본값을 자동 활성화하지 않는다.

이유:

- 배포 직후 바로 새 경로를 강제하지 않기 위함
- self-hosted runner 배포와 service restart가 순차적이기 때문
- 장애 시 환경변수만 내려서 즉시 우회 가능

즉:

- 코드 배포: 먼저
- `USE_HUB_SECRETS=true` 활성화: 나중

이 흐름이 가장 운영 친화적이다.

---

## 7. 권장 롤아웃 순서

### Phase A. 호환 코드 배포

- `env.js`
- `hub-client.js`
- `llm-keys.js`
- `investment/shared/secrets.js`

배포 후 기본 동작:

- 플래그 OFF → 기존 로컬 파일 방식 유지
- 코드만 심어지고 아직 실제 전환은 일어나지 않음

### Phase B. OPS 검증

OPS에서 확인:

```bash
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" http://localhost:7788/hub/secrets/llm | jq '.data | keys'
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" http://localhost:7788/hub/secrets/config | jq '.data.trading_mode,.data.paper_mode'
```

확인 포인트:

- `llm` 응답 정상
- `config` 응답 정상
- `paper_mode` 강제 오버라이드 기대값 확인

### Phase C. DEV 검증

DEV에서 확인:

```bash
node -e "const { fetchHubSecrets } = require('./packages/core/lib/hub-client'); fetchHubSecrets('llm').then(d => console.log(!!d))"
```

확인 포인트:

- SSH/Tailscale 경유 Hub 접근 가능
- 토큰 인증 정상
- 타임아웃/폴백 경로 정상

### Phase D. 기능 활성화

이때만 환경변수 적용:

```bash
export USE_HUB_SECRETS=true
```

우선 적용 대상:

- Claude/worker 계열의 `llm-keys.js`
- investment 계열

### Phase E. reservation 2차 설계

이 단계에서만 reservation 논의:

- `reservation_shared`
- `reservation_ops`

또는

- 텔레그램/비민감 값만 Hub
- 로그인/암호화 키는 로컬 유지

---

## 8. smart-restart / 자동배포 관점 체크포인트

현재 deploy는 변경된 팀만 재시작한다.
이 구조에 맞추면 1차 구현은 자연스럽다.

### 안전한 이유

- `packages/core` 변경 시 전체 재시작이 이미 걸려 있음
- `bots/hub` 변경 시 Hub 서비스 재시작 가능
- 새 로더는 폴백을 가지므로 restart 순서가 어긋나도 버틸 수 있음

### 권장 보완

P5 적용 커밋에서는 배포 후 헬스체크에 아래를 추가하는 것이 좋다.

```bash
node -e "const { fetchHubSecrets } = require('./packages/core/lib/hub-client'); fetchHubSecrets('llm').then(d => { if (!d) process.exit(1); console.log('hub secrets ok'); })"
```

단, 초기에는 실패해도 배포 자체를 막기보다 경고로 두는 편이 안전하다.

---

## 9. 롤백 전략

가장 자연스러운 롤백 순서는 아래다.

### 즉시 완화

```bash
export USE_HUB_SECRETS=false
```

또는 해당 값을 제거.

효과:

- 새 코드가 남아 있어도 기존 로컬 파일 경로로 즉시 복귀

### 코드 롤백

- 필요 시 P5 커밋 revert
- 그러나 이상적인 설계는 **코드 revert 없이 플래그만 내려도 복구 가능**해야 한다

따라서 1차 구현은 반드시 이 조건을 만족해야 한다.

---

## 10. 교수님 보고용 요약

한 줄 요약:

> P5는 자동배포 기준으로 "코드 선배포 + 플래그 후활성화"가 가장 자연스럽고, 1차는 `llm`과 `investment`만 우선 적용하는 것이 안전합니다.

짧은 설명:

- 현재 CI/CD는 순차 재시작 구조라 중간 상태를 견디는 설계가 중요함
- 그래서 Hub 연동 코드는 먼저 넣고, 실제 전환은 플래그로 늦추는 방식이 적합
- `reservation`은 운영 자격증명 마스킹 이슈가 있어 별도 2차 설계가 필요

---

## 11. 실행 체크리스트

### 구현 전

- [ ] `bots/hub/lib/routes/secrets.js`의 `llm`, `config` 응답 스키마 재확인
- [ ] `HUB_AUTH_TOKEN`이 OPS/DEV 모두 설정되어 있는지 확인
- [ ] `Hub health` 확인

### 1차 구현

- [ ] `env.js` 수정
- [ ] `hub-client.js` 추가
- [ ] `llm-keys.js` 수정
- [ ] `investment/shared/secrets.js` 수정

### 배포 후

- [ ] 문법 검사 통과
- [ ] Hub 응답 테스트 통과
- [ ] 로컬 폴백 테스트 통과
- [ ] `USE_HUB_SECRETS=true` 전환 전 상태 확인

### 2차 과제

- [ ] reservation 카테고리 분리 설계
- [ ] OPS 기본 Hub 정책 결정
- [ ] 엔트리포인트 선초기화 위치 확정

