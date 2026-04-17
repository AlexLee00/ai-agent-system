# DB Roles Guide

## 목적
- Hub의 `/hub/pg/query`를 애플리케이션 쓰기 권한과 분리
- 운영 봇의 직접 쓰기 트래픽은 기존 앱 계정을 유지
- Hub는 최종적으로 `hub_readonly` 역할만 사용하도록 수렴

## 권장 역할 분리
- `app` 계정:
  - 각 봇과 Elixir 런타임이 사용하는 기존 읽기/쓰기 계정
- `hub_readonly` 계정:
  - Hub 전용 읽기 전용 계정
  - 허용 스키마 `agent, claude, reservation, investment, ska, worker, blog, public`
  - `SELECT`만 허용

## 적용 순서
1. `scripts/db/create-hub-readonly-role.sql`로 읽기 전용 역할 생성
2. Hub가 실제로 `SELECT/WITH/EXPLAIN`만 사용하는지 운영 로그로 재확인
3. Hub 전용 PG 풀 또는 Hub 전용 환경 변수로 `hub_readonly` 연결 분기
4. `/hub/pg/query` smoke test
5. 기존 앱 계정과 Hub 계정이 분리됐는지 확인

## 주의
- Hub는 현재 shared `pg-pool`을 사용하므로, 코드 분기 없이 곧바로 readonly 계정으로 바꾸면 다른 런타임에도 영향이 갈 수 있음
- 따라서 role 생성과 실제 전환은 분리해서 진행하는 것이 안전함
