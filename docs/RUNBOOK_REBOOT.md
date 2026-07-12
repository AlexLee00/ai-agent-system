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
- 특정 잡 미복구: `launchctl print gui/$(id -u)/<job>` 상태 확인 → `launchctl kickstart -k gui/$(id -u)/<job>`(bootout/bootstrap 분리 금지 — I/O error 5). ★PROTECTED 라벨(ai.{ska,luna,investment,claude,elixir,hub}.* 계열·archer)은 **마스터 승인 후에만** 재시작 — crypto LIVE·실매출 무중단 원칙이 런북보다 상위.
- Hub 무응답: kickstart -k 후 10초 대기·재확인. EADDRINUSE면 lsof로 orphan 정리 후 재기동(npm 체인 자식 잔존 함정).
- 대량 실패(5+): 개별 대응 금지 → 메티 세션 열어 Core Signals·launchctl list 전수 실측.
