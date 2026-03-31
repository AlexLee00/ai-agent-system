---
name: code-review
description: 코드 품질, 보안, 성능 자동 검토. 코덱스 구현 후 메티 검증 단계에서 사용.
---

# /code-review — 코드 리뷰 자동화

## 검토 항목 (5단계)

### 1. 문법 검사
- `node --check [파일]` 모든 변경 파일에 실행
- ESM/CJS 호환성 확인 (import vs require)
- 누락된 세미콜론, 괄호 불일치 등

### 2. 보안 검사
- secrets/API키가 코드에 하드코딩되지 않았는지
- `fs.writeFileSync`로 코드 파일 덮어쓰기 시도 없는지
- `exec`/`spawn`으로 `git commit/push` 실행 없는지
- SQL 인젝션 가능성 (raw query에 사용자 입력 직접 삽입)
- OPS 환경 직접 수정 코드가 없는지

### 3. 팀 규칙 준수
- kst.js 사용 여부 (new Date() 직접 사용 금지)
- pg-pool.js 사용 여부 (DB 직접 연결 금지)
- hub-client.js 시크릿 접근 패턴
- env.js DEV/OPS 환경 분기 확인
- 에러 처리: throw 대신 null 반환 + 로깅 패턴

### 4. 성능 검토
- 불필요한 DB 쿼리 반복 없는지
- 대용량 데이터 메모리 로드 없는지
- Promise.all vs 순차 실행 적절성
- setTimeout/setInterval 리소스 누수

### 5. 영향 분석
- 변경된 함수를 호출하는 다른 파일 목록
- DB 스키마 변경 시 마이그레이션 필요 여부
- runtime_config 변경 시 OPS 반영 필요 여부

## 심각도 분류

| 등급 | 설명 | 조치 |
|------|------|------|
| CRITICAL | 보안 취약점, 데이터 손실 위험 | 즉시 수정 필수 |
| HIGH | 기능 오류, OPS 영향 | 배포 전 수정 |
| MEDIUM | 규칙 위반, 성능 이슈 | 다음 커밋에서 수정 |
| LOW | 스타일, 네이밍 | 개선 권장 |
