# CODEX_OPS_ERROR_FIX 테스트 체크리스트

작성일: 2026-03-30  
범위: 작업 A(crypto 최소수량 SELL skip + DB 정리), 작업 C(DEV CLI 래퍼)

## 1. 코드 점검

- [x] 변경 파일 diff 검토
- [x] `bots/investment/team/hephaestos.js` 최소수량 SELL 분기 확인
- [x] `scripts/ops-query.sh` / `scripts/ops-errors.sh` 스크립트 내용 확인
- [ ] BUY 재진입 경로와 dust 정리 방식 충돌 여부 해결

## 2. 소프트 테스트

- [x] `node --check bots/investment/team/hephaestos.js`
- [x] `bash -n scripts/ops-query.sh`
- [x] `bash -n scripts/ops-errors.sh`
- [x] `chmod +x scripts/ops-query.sh scripts/ops-errors.sh`

## 3. 하드 테스트

- [x] `./scripts/ops-query.sh investment "SELECT count(*) AS cnt FROM positions WHERE amount > 0"`
- [x] `./scripts/ops-errors.sh 60 investment-crypto`
- [ ] OPS 배포 후 `investment-crypto` 최소수량 반복 에러 감소 확인

## 4. 점검 결과

### 통과

- 새 DEV CLI 2개는 문법/실행권한/실제 Hub 호출까지 정상
- `ops-query.sh`는 `investment.positions` 조회 응답 확인
- `ops-errors.sh`는 `investment-crypto` 최근 에러 집계 응답 확인
- `hephaestos.js` 수정 자체는 문법적으로 정상
- dust 정리는 `amount=0` 유지 대신 실제 포지션 삭제로 보정 완료

### 남은 확인

- OPS 배포 후 `investment-crypto` 최소수량 반복 에러 감소 확인 필요

관련 위치:

- `cleanupDustLivePosition()`  
  `bots/investment/team/hephaestos.js:120`
- SELL dust 정리 호출  
  `bots/investment/team/hephaestos.js:1188`

## 5. 결론

- 작업 C(DEV CLI)는 커밋 가능 수준
- 작업 A도 dust 정리 회귀 가능성 보정 후 커밋 가능한 상태
- 최종 운영 효과는 배포 후 `ops-errors.sh 60 investment-crypto`로 재확인
