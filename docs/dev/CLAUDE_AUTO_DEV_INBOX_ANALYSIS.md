# 클로드팀 auto_dev 인박스 분석

> 작성일: 2026-04-24
> 목적: 클로드팀의 개발문서 자동 구현 흐름을 `docs/auto_dev/` 기준으로 정리하고, 외부 에이전트형 개발 도구와 비교한다.

## 1. 외부 기준

- Claude Code는 코드베이스를 읽고, 파일을 수정하고, 명령을 실행하며 개발 도구와 통합되는 에이전트형 코딩 도구다. 따라서 문서 기반 작업은 "프롬프트 파일 발견 → 코드 수정 → 검증 → 결과 알림" 흐름으로 맞추는 것이 자연스럽다.
- Claude Code hooks는 `SessionStart`, `FileChanged`, `Stop`, `SubagentStart/Stop` 같은 이벤트를 제공한다. 장기적으로는 `docs/auto_dev/*.md` 변경을 hook으로 감지하는 방식이 가장 직접적이다.
- MCP는 외부 도구·DB·API를 연결하는 표준 경로지만, 외부 콘텐츠는 prompt injection 위험이 있으므로 auto_dev 인박스는 로컬 전용·gitignore 보호가 필요하다.
- OpenHands 계열은 Reasoning-Action loop, tool orchestration, context management, security validation을 명확히 분리한다. 클로드팀도 덱스터/아처/리뷰어/가디언/빌더/노티파이어로 책임이 분리되어 있어 방향은 맞다.
- SWE-agent 계열은 저장소 탐색, 코드 편집, 테스트 실행을 Agent-Computer Interface로 표준화한다. 클로드팀은 이 중 테스트와 알림은 갖췄지만, 문서 투입 후 실제 구현을 시작하는 트리거가 아직 약했다.

## 2. 현재 클로드팀 비교

강점:
- 아처가 기술 변화와 보안 이슈를 수집해 패치 요청 문서로 변환한다.
- 코덱스 알림기가 실행 중인 Claude/Codex 프로세스를 감지하고 Phase 진행 상황을 Telegram으로 알린다.
- 리뷰어, 가디언, 빌더, 닥터가 검증·보안·복구 레일을 분리해 운영한다.
- pre-commit과 gitignore가 `docs/codex` 계열의 민감 문서 유출을 막는 구조를 이미 갖췄다.

보완점:
- 기존 아처 출력은 프로젝트 루트 `PATCH_REQUEST.md`라서 문서 체계와 분리되어 있었다.
- 코덱스 알림기는 `docs/codex`만 읽어 `docs/auto_dev` 인박스를 감지하지 못했다.
- 실제 구현 시작은 여전히 Claude Code 세션 또는 RC 규칙에 의존한다. 이번 변경은 안전한 인박스 표준화 단계이며, 다음 단계는 hook/FileChanged 또는 kickstarter로 시작 트리거를 자동화하는 것이다.

## 3. 이번 구현 결정

- `docs/auto_dev/`를 클로드팀 자동 구현 인박스로 승격한다.
- 아처는 `docs/auto_dev/PATCH_REQUEST.md`를 생성한다.
- 코덱스 알림기는 `docs/auto_dev`를 우선 감지하고, 기존 `docs/codex`는 하위 호환으로 유지한다.
- `docs/auto_dev/*`는 `.gitignore`와 pre-commit으로 보호한다.
- `CLAUDE.md` 세션 시작 루틴에 `docs/auto_dev` 확인을 추가한다.

## 4. 다음 단계 후보

1. Claude Code hook 기반 `FileChanged` 감지: `docs/auto_dev/*.md` 생성 시 자동으로 구현 세션을 시작한다.
2. auto_dev kickstarter: 인박스 문서를 스캔해 우선순위, 중복 실행 방지, 완료 후 archive 이동까지 수행한다.
3. 실행 감사 로그: `docs/auto_dev` 문서별 시작/완료/실패/테스트 결과를 `team-bus` 또는 `claude_doctor_recovery_log`에 남긴다.
4. 신뢰 경계 강화: 외부 수집 문서는 요약·검증 후 auto_dev로 이동하고, 외부 원문을 그대로 실행 지시로 쓰지 않는다.
