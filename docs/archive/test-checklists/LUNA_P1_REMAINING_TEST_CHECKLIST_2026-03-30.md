# Luna P1 잔여 작업 테스트 체크리스트 — 2026-03-30

> 범위:
> - `bots/investment/scripts/update-unrealized-pnl.js`
> - `bots/investment/shared/kis-client.js`
> - `bots/investment/config.yaml` 로컬 설정 반영 확인

---

## 1. 코드 점검

### 변경 파일

- `bots/investment/scripts/update-unrealized-pnl.js`
- `bots/investment/shared/kis-client.js`

### 점검 결과

- [x] `update-unrealized-pnl.js` 시작 시점에 `await initHubSecrets()` 추가
- [x] Binance 경로는 기존 동작 유지
- [x] KIS 국내는 `getDomesticPrice(symbol, false)`로 현재가 조회 후 `unrealized_pnl` 업데이트
- [x] KIS 해외는 `getOverseasPrice(symbol)`로 현재가 조회 후 `unrealized_pnl` 업데이트
- [x] `getOverseasPrice`는 외부 스크립트에서 직접 import 가능하도록 export 정리

### 검토 메모

- 명확한 차단 버그는 발견하지 못했다
- 이번 수정의 핵심 로직은 “KIS 가격 조회를 새로 붙이는 것”이며, 가격 조회 함수 자체는 기존 `kis-client.js`에 이미 존재하던 경로를 재사용한다
- `bots/investment/config.yaml`은 `.gitignore` 대상이라 저장소 커밋 범위에는 포함되지 않는다

---

## 2. 소프트 테스트

### 2-1. 문법 검사

- [x] `bots/investment/scripts/update-unrealized-pnl.js`
- [x] `bots/investment/shared/kis-client.js`

### 2-2. 설정값 확인

로컬 `config.yaml` 기준 확인:

```text
max_daily_trades:
- 기본: 12
- binance: 20
- binance.validation: 12
- kis: 16
- kis.validation: 20
- kis_overseas: 16
- kis_overseas.validation: 20
```

판정:

- 문서에서 요청한 상향 수치가 로컬 설정 파일에는 반영됨
- 다만 이 파일은 Git 추적 대상이 아니므로 별도 설정 동기화 정책이 필요함

### 2-3. DEV 스크립트 실행

실행:

- `node bots/investment/scripts/update-unrealized-pnl.js`

결과:

- `PostgreSQL 5432 ECONNREFUSED`

판정:

- 코드 문제라기보다 DEV 로컬 PostgreSQL 미기동으로 인한 환경 이슈
- 스크립트 진입 자체는 정상이나, DB 연결 전 단계에서 종료됨

---

## 3. 하드 테스트

### 3-1. KIS 직접 가격 조회

환경:

- `. ~/.zprofile`
- `USE_HUB_SECRETS=true`
- 실 KIS API 호출

실행:

- `getDomesticPrice('005930', false)`
- `getOverseasPrice('AAPL')`

결과:

```json
{"domestic":175000,"overseas":248.8,"excd":"NASD"}
```

판정:

- 이번 수정의 핵심인 국내/해외 KIS 가격 조회 경로는 실제 응답까지 확인됨
- 따라서 `update-unrealized-pnl.js`에 추가한 KIS 분기 자체는 실동작 가능성이 높다

### 3-2. OPS 현행 스크립트 실행

실행:

- `ssh mac-studio 'node bots/investment/scripts/update-unrealized-pnl.js'`

결과:

- Binance 6건 갱신
- KIS 국내/해외 12건은 여전히 `시세 미조회`
- 총 `18건 중 6건 갱신 완료`

판정:

- OPS 현행 배포본은 아직 이번 수정 전 상태로 보임
- 즉 “현재 운영 결과”는 문제 재현 증거로는 유효하지만, 새 코드 검증 결과는 아님

---

## 4. API/구조 메모

- 현재 `investment.positions` / `unrealized_pnl`을 직접 갱신하는 전용 OPS API는 확인되지 않았다
- Hub는 현재 시크릿 제공(`/hub/secrets/:category`) 중심이며, 투자 포지션/평가손익을 조회·갱신하는 리소스 API는 없다
- 현 구조에서는 이 스크립트가 PostgreSQL에 직접 연결해 `investment.positions`를 읽고 갱신한다
- 즉 이번 작업은 “DB를 OPS API로 본다”가 아니라 “스크립트가 직접 DB + KIS API를 본다” 쪽이다

---

## 5. 최종 판정

- [x] 코드 구현 완료
- [x] 문법 검사 통과
- [x] KIS 국내/해외 가격 조회 하드 테스트 통과
- [ ] 배포 후 OPS에서 전체 18건 갱신 여부 최종 확인 필요

### 핵심 결론

**이번 수정은 구현과 핵심 하드 테스트까지는 통과했다. 다만 실제 `unrealized_pnl` 18건 전체 갱신 여부는 배포 후 OPS에서 한 번 더 확인해야 한다.**
