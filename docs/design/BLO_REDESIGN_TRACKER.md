# 블로팀 재설계 추적 (BLO_REDESIGN_TRACKER)

설계 원천: docs/design/BLO_AGENT_WRITER_REDESIGN_2026-06.md
형식: 섹션 A, B, C... 누적 (Hub 트래커 패턴)

---

## A. 딥 분석 + 비전 통합 + 설계 확정 (2026-06-13, 메티)

- 딥 분석(실측): 60,544줄/launchd 19/매일 2편 live 건강 가동. V3 "구현 완료-운영 미연결"(shadow 6건 정지)
  발견 -> 부품 공급원으로 선별 회수 결정. 부채: commenter 6,215줄, blog.db 0B, 소셜 plist 잔존.
- 마스터 비전 접수: 스스로 성장하는 포스팅 작가 에이전트 / 활동 3축(포스팅+댓글·공감+Edu-X) /
  에이전트 입문 커리큘럼(codex/claude code 공식문서, 일반인 초보+꿀팁) / 시그마 대도서관 피드백 루프 /
  댓글 유형 동적 대응 / 형식 리디자인(IT 인기 게시물 연구) / 소셜 삭제(MCP 보존)·마케팅 off.
- 사실 확인: 신규 시리즈 "Codex와 Claude Code 실전 AI 구현 입문" 4강 진행 중(비전과 동일 방향) /
  대도서관 미존재(신규) / 댓글 유형 분류 부재(신규) / 4월 Phase1~7 자율 마케팅은 보류 확정.
- 설계서 작성: B1(정체성·커리큘럼) B2(대도서관+피드백 루프) B3(형식 리디자인) B4(댓글 동적 대응)
  B5(루나 패턴+gate) + 로드맵 W1~W4 + TS-B1~B8/TS-BL1.
- 대기 결정 2건: 4강 승계 리브랜딩 여부 / nodejs_120 아카이브.
- 다음: B1 착수 — 커리큘럼 재설계(공식문서 외부 서칭) -> CODEX-B1 프롬프트.

이력: 2026-06-13 설계서+트래커 작성 (메티)

## B. 마스터 확정 + 신규 요구 2건 반영 (2026-06-13, 메티)

- 확정: 48강·6섹션 / 기존 4강 승계 리브랜딩 / 일 2편 중 1편 강의(~7주) — 설계서 §8 부록에 전체 목차 확정.
- 외부 검증: claude-code star 132,027 / codex star 90,674 / anthropics/courses star 21,820 (공식문서 기반 타당).
- 신규 요구 반영: **B2-4** 발행본 vs 최종본 diff 피드백 — 기존 feedback-learner.ts(465줄) 재활용·부활
  (master_feedback 입력 경로 부재로 반쪽 동작 확인). 신규=최종본 재파싱 수집기+diff 분석+적재+작성 반영, TS-B9.
  **B5-0** 작성 액션 로직 정밀 재검토(blo/maestro 플로우 전수 추적 보고서) — W2 메티 작업.
- 다음: CODEX-B1 프롬프트(커리큘럼 48강 DB 반영 + 시리즈 승계 + 서칭 토픽 교체 + 소셜 삭제 + CLAUDE.md 갱신).
이력: 2026-06-13 확정+신규 반영 (메티)

## C. 보편 성장 루프 정식화 (2026-06-13, 마스터)

- 핵심 패턴 확정: 생성 -> 예약발행(익일 07~08시 실제 등록) -> 초안+실제본 DB -> diff+외부 패턴 학습
  -> 다음 적용. 포스팅·댓글·공감·Edu-X 전 활동 동일 적용 = "성장하는 에이전트 시스템".
- B2-4 타이밍 확정: 재파싱은 익일 08:30 이후 (발행 직후 아님 — 마스터 수정분 포착 필수 조건).
- 설계서 §1-1(보편 성장 루프) + B2-4 타이밍·확장 반영.
이력: 2026-06-13 루프 정식화 (메티)

## D. 보편 성장 루프 — 전 활동 구조화 완성 (2026-06-13, 메티)

- B4-2 신설: 댓글/공감 성장 루프(초안 vs 실제본+반응 회수 -> 전략 보정). 공감은 경량 루프.
- B6 신설: Edu-X 성장 루프(게시본 vs X 노출 성과 -> 슬롯별 패턴 학습) — 전제: B2 대도서관+Edu-X live.
- 로드맵: W3 B4에 TS-B10 / W4 B6 추가(CODEX-B6). TS-B10/B11 시나리오 추가 (총 TS 12종).
- 이로써 §1-1 보편 루프가 활동 3축(포스팅 B2-4 / 댓글·공감 B4-2 / Edu-X B6) 전부에 구조 반영 완료.
이력: 2026-06-13 전 활동 루프 구조화 (메티)

## E. CODEX-B1 프롬프트 작성 (2026-06-13, 메티)

- 사전 실측: 기존 시리즈가 curriculum에 **120행 기존재**(발행 4강) -> B1은 신규 삽입이 아니라
  "120강 계획 -> 48강 재편"으로 명세 (5~120 계획 행은 archived 마킹, 삭제 금지).
- 프롬프트: docs/codex/CODEX_BLO_B1_CURRICULUM_2026-06-13.md — §0 핵심 사실 / §1 재편(멱등 SQL) /
  §2 생성 경로 정합(소비 코드 비파괴) / §3 서칭 커리큘럼 연동(노드 하드코딩 제거) / §4 소셜 삭제+마케팅
  off 가드(MCP·코드 보존) / §5 CLAUDE.md 재작성+잔재 / §6 TS-B1~B3 / §7 안전(B3/B4 선행 구현 금지).
- 다음: 코덱스 전달 -> 구현 -> 메티 독립 검증 -> 마스터 DDL+plist+커밋.
이력: 2026-06-13 CODEX-B1 작성 (메티)

## F. CODEX-B1 메티 독립 검증 (2026-06-13) — 합격 (경미 누락 1건)

| 항목 | 결과 |
|---|---|
| 변경 범위 | blog 일대 정합 (plist 3 삭제, 가드 주입 모듈들, CLAUDE.md) |
| 마이그레이션 023 | 멱등 / status CHECK에 archived 확장 / 시리즈 리네임 / **blog.posts 참조 0**(발행본 보존) / DELETE 없음 |
| 스모크 | smoke:blo-b1-curriculum ok:true 4건 + daily-dry 2편 구조 (독립 재실행) |
| 마케팅 off | marketing:digest -> skipped:true, reason=blog_marketing_disabled |
| 잔재 정리 | blog.db 제거 / bots/social-media 코드 보존 |
| CLAUDE.md | 비전·활동 3축·보류 명문화 확인 |
| **경미 누락** | repo에 ai.blog.instagram-token-refresh.plist 잔존 (token-health만 삭제) — 마스터 git rm 1개 추가 |

### 마스터 적용 절차
1. DDL: /opt/homebrew/opt/postgresql@17/bin/psql -d jay -f bots/blog/migrations/023-agent-intro-curriculum.sql
2. LaunchAgents bootout+삭제: ai.blog.instagram-publish / facebook-publish / instagram-token-health
   (+ instagram-token-refresh 로드돼 있으면 함께)
3. repo 잔존 1개: git rm bots/blog/launchd/ai.blog.instagram-token-refresh.plist
4. 커밋
주의: TS-B1의 "planner 5강 선택" 실검증은 DDL 적용 후 가능(현 스모크는 fixture) — 적용 후 메티가
커리큘럼 DB 직접 쿼리+dry-run으로 라이브 확인(TS-B1-L), 최종 자연 검증은 익일 06:00 daily(5강 발행).
이력: 2026-06-13 CODEX-B1 독립 검증 합격 (메티)

## G. B1 적용 + TS-B1-L 라이브 검증 (2026-06-13) — 합격 / B1 종결

| 검증 | 결과 |
|---|---|
| 재편 | '에이전트 입문' pending 48 + archived 72 = 120 (총량 보존, 삭제 0) / 시리즈 active 48 |
| 다음 강의 결정 | **메커니즘 확정**: blog.category_rotation(rotation_type=lecture_series)의 current_index+1이
  유일한 진실 (curriculum.status/posts와 무관). 현재 4/'에이전트 입문' -> **익일 06:00 = 5강 "Claude Code 설치 따라하기"** |
| 추적 노트 | 1~4강 pending+posts 미연결은 기존 시스템 동작(rotation이 포인터라 무해 — 메티 1강 중복 오경보,
  rotation 미인지 상태의 추적이었음. 코덱스가 마이그레이션에서 rotation 갱신까지 정확 처리) |
| 소셜 | launchd 로드 0 / repo plist 0 / 코드·MCP 보존 |
| 적용 | DDL 023 + LaunchAgents 4종 정리 + 커밋 297351171 (마스터) |

선택적 개선(백로그): curriculum 1~4강 published 마킹+posts 연결 — 동작 무관하나 데이터 정합 차원.
다음: **익일 06:00 daily 자연 검증**(5강 발행 + "이번 주 소식" 코너) -> B1 완전 종결.
이어서 W1~2: CODEX-B2(시그마 대도서관 + 적재 3종 + RAG 주입).
이력: 2026-06-13 TS-B1-L 합격, B1 종결 (메티)

## H. CODEX-B2 프롬프트 작성 (2026-06-13, 메티)

- 선결 실측(재활용 원칙의 승리): **대도서관 = sigma.vault_entries 기존재** (vault-manager 멱등 INSERT+
  임베딩+감사 / vault-search 코사인 검색 / luna·claude vault-feed 모범 패턴 188줄). **신규 테이블 0.**
- 적재 소스 실측: posts 124 / comments 165 / comment_actions 5,613.
- 프롬프트: docs/codex/CODEX_BLO_B2_VAULT_FEED_2026-06-13.md — §1 blog vault-feed(F1 본문 청크/
  F2 댓글 PII 마스킹/F3 인기패턴 인터페이스만, backfill+증분+dry-run) / §2 강의 RAG 주입(vault-context
  래퍼, 폴백 무해, 킬스위치) / §3 TS-B4~B5 / §4 안전(vault 코어 비수정, B2-4는 B2b 별도).
- 다음: 코덱스 전달 -> 검증 -> 마스터 backfill+plist -> 익일 강의 연계 블록 자연 검증(TS-B5-L).
이력: 2026-06-13 CODEX-B2 작성 (메티)

### H-1. CODEX-B2 구현 메모 (2026-06-13, 코덱스)

- 구현 시점 read-only 실측: blog.posts 248 / blog.comments 165 / blog.comment_actions 5,613 / sigma.vault_entries(source='blo') 0.
- 산출물: `runtime-sigma-blog-vault-feed.ts`(dry-run 기본, --write+--no-dry-run만 적재), `vault-context.ts`(source='blo' 검색 래퍼), TS-B4~B5 smoke, 02:00 launchd plist.
- 안전: 신규 테이블 0, vault-manager/vault-search 비수정, 일반 포스팅/라이브 발행 경로 비변경, launchctl 등록 없음.
- 마스터 액션 후보: smoke 통과 후 `npm --prefix bots/sigma run -s blog:vault-feed -- --backfill --limit-per-source=10000`로 dry-run 확인, 이후 승인 시 `--write --no-dry-run` backfill 및 plist 등록.

## I. CODEX-B2 메티 독립 검증 (2026-06-13) — 합격

| 항목 | 결과 |
|---|---|
| 변경 범위 | 신규 4(blog-vault-feed/vault-context/smoke/plist) + 수정 4(blo/pos-writer/sigma pkg/트래커) 정합 |
| 비수정 보증 | vault-manager / vault-search / luna·claude 피드 diff 0 (git diff --stat 무출력) |
| backfill dry-run | 독립 재실행 ok:true, 소스별 limit 정확(posts 20/comments 20/actions 20 -> 후보 136, 청크 분할 포함) |
| 스모크 | smoke:blog-vault-feed ok:true 3건 (독립 재실행) |
| RAG 주입 | 강의 경로만(pos-writer '[지난 강의 연계]') / 킬스위치 기본 true / withTimeout 폴백(250~10,000ms bounded) / 빈 결과 시 블록 생략 |
| PII | 시그마 공용 redactPii 재사용 + redactBlogPii 확장(blog_url 등) — luna 패턴 정합 |
| 멱등 | filePath 결정론적(library/blo/post/{id}/chunk-NNN-{hash} 등) — ON CONFLICT 기반 |
| 정정 | blog.posts 실측 248 (메티 사전 124는 시점/조건 차 — 코덱스 §H-1 실측이 정확) |

### 마스터 적용 절차
1. (선택) 전량 dry-run: npm --prefix bots/sigma run -s blog:vault-feed -- --backfill --limit-per-source=10000
2. 실적재 승인 시: 동일 명령 + --write --no-dry-run
3. plist 등록: ai.sigma.blog-vault-feed-daily-0200 (bootstrap gui/$UID)
4. 커밋
적재 후 메티 검증(TS-B4-L/B5-L): vault_entries source='blo' 분포 + vault-search 질의 정답 재현 +
익일 06:00 강의에서 '[지난 강의 연계]' 블록 자연 검증.
이력: 2026-06-13 CODEX-B2 독립 검증 합격 (메티)

## J. 브랜치 분기 사고 + B2 복원 + TS-B4-L 완결 (2026-06-13, 메티/마스터)

### 사고 전모
- 외부 자동 작업이 루트 워크트리를 codex/luna-meeting-room-ops-diagnostics로 전환+16커밋 -> B2 커밋
  (505093449)이 codex/design-trackers-mr-c에 고립, 워킹트리에서 B2 코드 소실(DB 적재 8,147은 무사).
- 복구: 마스터 cherry-pick -> a836460cb (파일 겹침 0, B2 코드+트래커 §H~I 복원 — 메티 확인).
- 운영 기준 진단(마스터): deploy.sh는 origin/main 기준이나 루트가 codex 브랜치+dirty라 **배포 sync 차단
  반복 중**. auto-commit.sh / nightly-sync.sh에 브랜치 guard 부재 = 재발 구조.
- 방침(마스터): 루트 = main 전용 OPS checkout 고정 / Codex·auto-dev는 별도 worktree / 스크립트 3종에
  main branch guard -> CODEX-INFRA-GUARD 프롬프트로 진행.

### TS-B4-L 완결 (적재+검색 검증)
| 항목 | 결과 |
|---|---|
| 적재 | source='blo' 8,147 / embedded 100% / distinct file_path=cnt(중복 0) / plist 로드 1 |
| 검색 정답 | vault-search 직접: "Claude Code 설치 따라하기" -> 상위 = 2강(Codex vs Claude Code) sim 0.655/0.648, source=blo — **적재·임베딩·검색 전부 정상** |
| 발견 | vault-context 경유 results 0 — DEFAULT_MIN_SIMILARITY=0.65가 현 데이터 최고 유사도(0.65 경계)보다 타이트 + 빌드 질의 조합으로 미달. 버그 아님, **임계 보정 필요** |
| 권고 | minSimilarity 기본 0.55~0.60 하향(1줄) — 미보정 시 TS-B5-L(연계 블록 자연 검증) 불발 예상 |

### B1 자연 검증 (동일 일자)
06:08 "[에이전트 입문 5강] Claude Code 설치 따라하기" 발행(2편, 실패 0) — rotation 예측 적중, B1 완전 종결.
이력: 2026-06-13 사고 복구+TS-B4-L 완결 (메티)
