# RUNBOOK — 맥스튜디오 재부팅 절차 (2026-07-13)

> 실행 SSOT = scripts/{pre,post}-reboot.sh (이 문서는 절차 개요·판단 기준·비상 분기)

## 표준 절차
1. **사전**: 활성 세션 마감(브리지 inbox 비었는지·코덱스 작업 중 아닌지 확인). crypto 포지션 특이 상황이면 보류.
2. `bash scripts/pre-reboot.sh --drain-now` — 안전 정지+서비스 스냅샷 저장(/tmp). ※인자 없이 실행하면 준비만 하고 정지 안 함.
3. macOS 재부팅.
4. **자동**: launchd가 전 잡 복구 → post-reboot(RunAtLoad)이 검증·텔레그램 보고 발송.
5. 보고 확인: FAIL 항목 중 기지 소음(아래) 제외하고 실 FAIL만 대응. Hub health(:7788/hub/health/live)·SKA 예약·crypto 포지션 순으로 눈검증.

## 기지 소음
- 없음(TASK-0051에서 스테일 전부 정리 — dry-run OK 187/WARN 0/FAIL 0). 보고에 FAIL이 있으면 전부 실이슈로 취급.

## 비상 분기
- post-reboot 보고 미수신: `tail -50 /tmp/post-reboot.log` → 미실행이면 `bash scripts/post-reboot.sh` 수동.
- 특정 잡 미복구: `launchctl print gui/$(id -u)/<job>` 상태 확인 → `launchctl kickstart -k gui/$(id -u)/<job>`. ★PROTECTED 라벨(ai.{ska,luna,investment,claude,elixir,hub}.* 계열·archer)은 **마스터 승인 후에만** 재시작 — crypto LIVE·실매출 무중단 원칙이 런북보다 상위.
- Hub 무응답: kickstart -k 후 10초 대기·재확인. EADDRINUSE면 lsof로 orphan 정리 후 재기동(npm 체인 자식 잔존 함정).
- 대량 실패(5+): 개별 대응 금지 → 메티 세션 열어 Core Signals·launchctl list 전수 실측.

## ★env 게이트 영속 원칙 (2026-07-13 시그마 회귀 교훈)
- 기능 활성 env(*_ENABLED 등)는 **반드시 담당 잡 plist에 PlistBuddy로 영속**(셸 export/일회 설정으로 활성 금지 — 재부팅 소실).
- 활성 완료 판정 = "동작 확인" + "**plist 존재 확인**"(둘 다). 재부팅 전 pre-reboot 스냅샷과 별개로, 새 env 활성 시 즉시 plist 반영.
- 사례: SIGMA_TRANSITION_ENABLED 비영속→재부팅 dry-run 회귀(07-13 복구·vault-inbox-5min plist 영속화).

## ★launchctl 재시작 2종 구분 (2026-07-13 시그마 재확인)
- **코드/재실행만**: `kickstart -k` (로드된 plist 기준 프로세스 재시작).
- **★plist 변경 반영(env 추가·수정)**: `bootout` → `bootstrap` 재로드 필수 — kickstart로는 EnvironmentVariables 변경이 반영되지 않음(시그마 transition 실증). bootstrap I/O error 5는 재시도로 해소.
