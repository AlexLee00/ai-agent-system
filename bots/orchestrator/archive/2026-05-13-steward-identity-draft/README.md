# 메티 스튜어드 정체성 초안 (2026-05-13 archive)

> ⚠️ 이 폴더는 메티(Claude.ai)가 작성한 스튜어드 정체성 초안의 archive입니다.
> 다음 세션에서 기존 `src/steward.ts` + `lib/steward/` 코드와 정합성 정리 후 활용 예정.

## 작성 배경

지난 세션에서 메티가 5번 검증 끝에 도달한 "노바 새 봇 X, 스튜어드 분리" 결론으로 작성한 정체성 4파일.

당시 메티는 `bots/orchestrator/`를 비어있는 봇으로 잘못 인식 (실제로는 제이의 코드 베이스 + 스튜어드 모듈).

## 4파일

- `IDENTITY.md` — 스튜어드 정체성 3층 (기술/역할/관계), 좌우명, 시그마와 보완표
- `SOUL.md` — 7원칙 (절대금지/속도제한/서킷브레이커/신뢰도/청자우선/시그마분업/기록)
- `USER.md` — 마스터 Alex 정보
- `MEMORY.md` — 탄생일 기록

## 정합성 평가 (마스터-메티 분석)

기존 `src/steward.ts` + `lib/steward/` 모듈과 약 75% 정합:

| 영역 | 기존 코드 | 메티 정체성 | 정합 |
|---|---|---|---|
| 일일 보고 | `daily-summary.ts` ("스튜어드 일일 요약") | "일일 청지기" | ✅ |
| tracker 관리 | `tracker-sync.ts` | tracker.json 시드 | ✅ |
| Telegram | `telegram-manager.ts` | Telegram MCP 채널 | ✅ |
| 코덱스 관리 | `codex-manager.ts` | "코덱스 위임" | ✅ |
| launchd | `launchd-manager.ts` + `ai.steward.*.plist` | "launchd 일일 1회" | ✅ |
| Git 위생 | `git-hygiene.ts` | (명시 X — 보완 가능) | 🟡 |
| 환경 동기화 | `env-sync-checker.ts` | (명시 X — 보완 가능) | 🟡 |
| LLM 헬스체크 | `localLLMClient` 호출 | (명시 X — 보완 가능) | 🟡 |
| 메모리 통합 | `agent-memory-consolidator` | (명시 X — 보완 가능) | 🟡 |
| **명령 라우팅** | router.ts (제이 영역) | "명령 통역사" 명시 | ❌ **충돌** |
| 승인 게이트 | (현재 X) | 명시 | ❓ 신규 |

## 활용 방향 (다음 세션)

1. "명령 라우팅" 책임 제거 (제이의 router.ts 영역)
2. "운영 자동화" 책임 추가 (git 위생, 환경 동기화, LLM 헬스체크, 메모리 통합)
3. 정리 후 `lib/steward/IDENTITY.md` 또는 유사 위치로 이동 (모듈 메타 문서)
4. 또는 `docs/strategy/STEWARD_MODULE_META.md`로 외부 문서화

— 메티, 2026-05-13
