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

## K. CODEX-INFRA-GUARD 메티 독립 검증 (2026-06-13) — 합격

| 항목 | 결과 |
|---|---|
| 가드 lib 의미론 | realpath(심링크 해소) 경로 비교 + 비main 판정 / 별도 worktree 비발동(경로 불일치) / detached HEAD 안전 처리 / 발동 시 명시 로그+exit 0 |
| 적용 위치 | 3 스크립트 모두 진입 직후(9~13행) — auto-commit(주범)/nightly-sync/deploy |
| TS-G3 재현 | auto-commit·deploy 실행 -> skip 로그 정확 + exit 0 + **HEAD 불변** (메티 독립) |
| 우회 env | BRANCH_GUARD_DISABLED=true -> 가드 통과 |
| 노트 | ① realpath 실패 시 fail-open — ops_root 고정 경로라 실질 위험 0 (기록만) ② 가드 커밋 77628698b 기존재(자기보고의 "커밋은 마스터 액션"과 상이 — 푸시 여부만 확인 필요) |

### 남은 마스터 전환 시퀀스 (딥 검토 §D 확정)
① crontab 주석화(deploy 5분) ② dirty 정리(luna 미커밋) ③ main ff 정렬(origin/main..HEAD=39, 역방향 0 — 손실 0)
④ 루트 main 고정(이후 가드가 자동 보호) ⑤ auto-dev WorkingDirectory worktree 분리(클로드팀 설정 — 별도 작업)
⑥ 이후 배포는 수동 bash scripts/deploy.sh

배경 히스토리(마스터 질문 확인): deploy cron = 2026-04-08 TS Phase 1b 빌드 파이프라인으로 도입(스테일
데몬 오류 해소 목적, DEV+OPS 2머신 전제) -> 2026-06 OPS 단일 전환으로 pull 수요 소멸 -> 비활성 결정.
이력: 2026-06-13 INFRA-GUARD 검증 합격 (메티)

### K-1. worktree 분리 — 별도 검토 보류 (2026-06-13, 마스터)
auto-dev WorkingDirectory worktree 분리(클로드팀 설정 변경)는 즉시 진행하지 않고 **별도 검토 항목**으로
보류. 가드 3종이 1차 방어를 담당하므로 긴급도 하락 — 루트 main 고정 후 운영하며 클로드팀 B7 사이클과
함께 재검토. 전환 시퀀스는 ①cron 주석화 ②dirty 정리 ③main ff ④루트 main 고정 ⑥수동 deploy로 진행.

## L. 루트 main 정렬 완료 — 인프라 사고 트랙 종결 (2026-06-13, 마스터/메티)

마스터 시퀀스: dirty 커밋(d5d39b326) -> main 전환 -> ff 42커밋(역방향 0, 손실 0) -> push -> 후속 1건
(aad0253d4) push -> crontab 제거.
메티 정렬 후 검증(전부 합격): 루트 main + clean + origin/main 차이 0 / B2·가드 핵심 파일 main 존재 /
가드 main 통과(TS-G2 라이브) / crontab 부재.

체계 요약: 루트 = main 전용(가드 3종 자동 보호) / 배포 = 수동 bash scripts/deploy.sh / worktree 분리 =
별도 검토(§K-1) / 사고 원인~재발 방지 전 과정 §J~L.

블로 트랙 복귀: ① vault-context 임계 0.55 보정(1줄 — 익일 06:00 연계 블록 활성 조건, 당일 중 권고)
② CODEX-B2b(발행본 vs 최종본 diff, 익일 08:30 재파싱) ③ 익일 02:00 vault-feed 첫 자동 증분 관찰.
이력: 2026-06-13 main 정렬 검증 (메티)

## M. 임계 보정 + TS-B5-L 사전 재현 합격 — B2 완전 가동 준비 (2026-06-13)

- 마스터 보정: DEFAULT_MIN_SIMILARITY 0.65 -> 0.55 (커밋 28dc020fc — main에서 auto-commit 정상 작동의
  첫 실증이기도 함).
- **메티 정정(자기수정)**: 직전 "vault-context 경유 0건"의 주원인은 임계가 아니라 **메티 테스트 호출의
  인자 오류** — 빌더 시그니처는 lectureTitle/curriculumKeywords/seriesName인데 title/keywords로 호출해
  질의가 "6강" 두 글자로 빌드됐던 것. vault-context는 처음부터 정상, 마스터 스모크(promptHasVaultBlock:
  true)가 정확했음. 임계 하향도 유효한 보정(0.653~0.658 항목이 0.65에선 탈락 — 연계 풍부화).
- 올바른 인자 재현: 질의 "에이전트 입문 6강 Codex 설치 따라하기 ..." -> **results 4** (2강 sim 0.671 등)
  + '[지난 강의 연계]' 블록 생성 ✓.
- 다음 자연 검증: 익일 02:00 vault-feed 첫 자동 증분 + **06:00 6강 발행 본문에 연계 블록 등장**(TS-B5-L 최종).
이력: 2026-06-13 임계 보정 검증+정정 (메티)

## N. 상태 스냅샷 + CODEX-B2b 작성 (2026-06-13 07시, 메티)

- 자연 검증 일정 정리: 5강(06:08)은 연계 블록 없이 발행 — **예상대로**(발행 시점 루트가 codex 브랜치,
  B2 주입 코드 부재). vault 8,147(04:03 backfill). **첫 자동 증분 = 6/14 02:00, TS-B5-L = 6/14 06:00 6강.**
- CODEX-B2b 작성: docs/codex/CODEX_BLO_B2B_FINAL_CONTENT_DIFF_2026-06-13.md — §1 master_feedback 생성
  (feedback-learner 휴면 원인 = 테이블 마이그레이션 누락, 코드 465줄은 완성 상태) / §2 collect-final-content
  (익일 08:30, naver_url 재파싱, diff 시 master_feedback+vault(type=master_edit) 적재, 무변경 마킹) /
  §3 소비는 기존 weekly-evolution 경로 확인만 / §4 TS-B9 / §5 안전(읽기 전용, 발행 흐름 독립).
- 병행 일정: 6/14(일) GATE-H 48h + GATE-R 판정 / 6/15(월) 16:00 Edu-X kis-1600 TS-EXL1.
이력: 2026-06-13 B2b 프롬프트 (메티)

## O. CODEX-B2b 메티 독립 검증 (2026-06-13) — 합격

| 항목 | 결과 |
|---|---|
| 변경 범위 | 신규 4(migration 024/collect-final-content/smoke/plist 0830) + package.json — 정합 |
| 스키마 정합 | **master_feedback 컬럼이 feedback-learner INSERT 7컬럼과 1:1 일치**(코드 역추출 정확) + 멱등 + final_content_checks ledger 신설 |
| feedback-learner | 비수정 ✓ (테이블 생성만으로 부활하는 설계 준수) |
| 스모크 | smoke:final-content-diff ok:true 8건 (독립 재실행) |
| dry-run | migration 미적용 감지(final_content_checks_missing) + 무해 동작 — 게이트 정상 |
| write 게이트 | 기본 dryRun, --write만 해제 ✓ |

### 마스터 적용 절차
1. DDL: psql -d jay -f bots/blog/migrations/024-final-content-diff.sql
2. plist 등록: ai.blog.collect-final-content-daily-0830 (bootstrap)
3. 커밋
4. 이후 첫 라이브: 6/14 08:30 잡이 6/13 발행분(5강+일반) 재파싱 -> 마스터가 블로그에서 수정한 부분이
   있으면 master_feedback 첫 데이터 생성 (TS-B9-L 메티 확인)
이력: 2026-06-13 B2b 검증 합격 (메티)

## P. B2b 적용 검증 + 중대 발견 2건 (2026-06-13, 메티)

적용 검증: master_feedback/final_content_checks 생성 ✓ / plist 로드 ✓ / dry-run warnings 해소 ✓ / 후보 0.

### 발견 1 — naver_url 공급 중단 (6/10~)
- 채움 주체 = publ.ts 855행(SET status='published', naver_url=$2) + mark-published-url.ts(markPublished).
- 169/250 채움, **마지막 6/9** — 6/10부터 전부 status='ready'+URL 없음. B2b 후보 선정의 전제가 비어 있음.
- 원인 미규명(다음 세션): 6/9~10 사이 무엇이 바뀌었나(운영 절차? launchd? publ 트리거?).

### 발견 2 — master-edit-analyzer.ts (386줄) 기존재, 메티 선결 조사 누락
- 헤더: "마스터 발행 diff 분석 + 스타일 학습 / Phase 1: 발행 검출(naver-url-backfill + RSS 매칭) /
  Phase 2: Diff 분석(초안 vs 발행본)" — **B2-4와 동일 요구의 기존 구현**. RSS 매칭 URL 자동 발견까지 포함 가능성.
- 메티 자기수정: B2b 선결 조사에서 feedback-learner만 확인하고 이 자산을 놓침 — B2b(collect-final-content)와
  중복/보완 관계 정밀 분석 필요. naver-ui/scheduled-review-store(예약 리뷰 스토어)도 관련 자산.

### 다음 세션 진입점
1. master-edit-analyzer 정밀 분석: 동작 여부(launchd?), RSS URL 발견 실효성, B2b와 통합/대체 결정
2. naver_url 6/10 중단 원인 규명 -> 공급 재개(이게 B2b/B2-4 가동의 선결 조건)
3. 6/14 자연 검증: 02:00 vault-feed 증분 / 06:00 6강 연계 블록(TS-B5-L) / 08:30 첫 diff 수집(후보는 URL 재개 후)
4. 6/14 GATE-H 48h + GATE-R 판정 / 6/15 16:00 Edu-X TS-EXL1
이력: 2026-06-13 B2b 적용+발견 2건 (메티)

## Q. 블로 2건 규명 — URL 공급 단절 + 내장 B2-4의 실체 (2026-06-13, 메티)

### naver_url 6/10 중단 원인 확정
- 공급 시스템 완비: naver-url-backfill(lib+스크립트+telemetry+**plist까지 repo에 존재**, 제목 매칭
  confidence 0.9 자동 백필) — 그러나 **launchd 미등록**(로드 0, ~/LaunchAgents 부재).
- 해석: 6/9까지의 URL 169건은 일괄/수동 실행의 산물, 자동화는 만들어졌으나 등록 누락 상태.
  "6/10에 뭔가 멈춘 것"이 아니라 "마지막 일괄 실행 이후 아무도 안 돈 것".

### master-edit-analyzer 실체 (386줄)
- **B2-4 풀 사이클이 daily에 이미 내장**: blo.ts 2450~2484 — runDailyMasterEditAnalysis(days:2) +
  buildMasterStyleProfile(limit:30) -> masterStyleHint **프롬프트 주입**까지.
- 그러나 detectPublishedDrafts가 naver_url 있는 published만 소비 -> URL 단절로 **분석 실적 0**
  (master_edit_analysis 테이블 미생성 = ensure조차 미도달).

### 통합 그림 + 액션
- 사슬: [공급] url-backfill(미등록) -> [전환] publ published -> [수집] B2b collect-final-content(어제 구축)
  + [분석·학습] analyzer & feedback-learner — **공급 1개가 막혀 전 사슬 휴면.**
- 즉시 액션(마스터): **ai.blog.naver-url-backfill plist 등록** -> URL 공급 재개 -> 내일 08:30 B2b 후보
  발생 + analyzer 자연 가동.
- 다음 세션: analyzer 전체 정독 -> B2b(수집)와 analyzer(분석)의 중복/분업 통합 설계
  (안: 수집=B2b 일원화, 분석·스타일=analyzer, 기록=master_feedback+master_edit_analysis 정리).
이력: 2026-06-13 블로 2건 규명 (메티)

### Q-1. naver-url-backfill plist 등록 완료 (2026-06-13 08:16, 마스터/메티 확인)
- 등록·로드 1 확인, 스케줄 매일 11:05(--write --min-confidence=0.9), 즉시 실행 안 함.
- **오늘 11:05 첫 자동 실행** -> 6/10~12 발행분(네이버 기등록 글) 제목 매칭 -> published+URL 재개 기대.
- 메티 확인 예정: 11:05 이후 로그(bots/blog/naver-url-backfill.log)+posts URL 채움 -> 사슬 가동 검증.
- 전체 타임라인: 오늘 11:05 URL 재개 -> 내일 02:00 증분 / 06:00 6강 연계(TS-B5-L) / 06:00+ analyzer
  첫 분석 / 08:30 B2b 첫 후보(master_feedback 첫 데이터) — 보편 성장 루프 전 구간 첫 완주 예정.

### Q-2. backfill 과거 실행 흔적 (2026-06-13 08:18, 메티)
- 로그 실측: bots/blog/naver-url-backfill.log 마지막 수정 **6/10 11:05**(176KB, 정상 완료 JSON)
  — 과거에 11:05 잡이 가동 중이었고 6/10 실행을 끝으로 plist 언로드/소실(원인 미궁, 재등록 완료로 실익
  낮아 종결). "마지막 URL 공급 6/9 발행분"과 정확히 정합.
- GATE-R 08:18 기준: 195건 / false 10(어제 진단분 그대로, 신규 0 — 청정 유지).
- 다음 세션: B2b<->analyzer 통합 설계(analyzer 386줄 정독) + 11:05 backfill 결과 확인.

## R. analyzer 정독 + 통합 설계 확정 -> CODEX-B2c (2026-06-13, 메티)

- **결정적 발견**: runDailyMasterEditAnalysis가 post.content vs post.content **자기 비교 스텁**
  (주석 자백: "실제 네이버 발행본과 비교하려면 naver-url-backfill 활용 필요") — 분석 체인은 완성,
  diff 원료만 미구현. **B2b가 정확히 그 빠진 조각 = 중복 아닌 운명적 보완.**
- 분업 확정: 수집=B2b(유일 네이버 접점) / 분석·스타일=analyzer / 이벤트=master_feedback / 통계=master_edit_analysis.
- CODEX_BLO_B2C_ANALYZER_INTEGRATION_2026-06-13.md: §1 B2b 실본 보존(migration 025) §2 스텁 해소(최소 diff,
  skip 경로 회귀 0) §3 시간 사슬(11:05->08:30->익일 06:00 days:2 커버) §4 TS-B10c §5 안전.
- 다음: 코덱스 전달 -> 검증 -> 적용. 병행 확인: 오늘 11:05 backfill 결과.
이력: 2026-06-13 통합 설계 (메티)

## S. B2c 구현 — final_content_checks 저장본 기반 analyzer 통합 (2026-06-13, 코덱스)

- migration 025 추가: `blog.final_content_checks.final_title/final_content_text` 컬럼을 `ADD COLUMN IF NOT EXISTS`로 확장하고,
  변경 실본 분석 후보 인덱스를 추가.
- `collect-final-content` 보강: 변경 감지 포스트만 정규화된 최종 제목/본문을 ledger upsert payload에 포함하고,
  dry-run JSON에는 본문 전체 대신 길이/hash 중심 정보만 노출.
- `master-edit-analyzer` 보강: `final_content_checks.changed=true`, `status='changed'`, `final_content_text IS NOT NULL`,
  미분석 row만 후보로 읽어 초안 vs 네이버 최종 저장본 diff를 수행. 무변경/실본 없음/fetch_failed row는 정상 skip.
- 신규 스모크 `smoke:master-edit-analyzer-integration` 추가: collector 저장 payload, analyzer diff 저장, skip 경로,
  `masterStyleHint` guide 생성 경로를 mock DB로 검증.

검증:
- `node --check`: `collect-final-content.ts`, `final-content-diff-smoke.ts`, `master-edit-analyzer.ts`,
  `master-edit-analyzer-integration-smoke.ts` 통과.
- `smoke:final-content-diff` 통과.
- `smoke:master-edit-analyzer-integration` 통과.
- `test:daily-dry` 통과.
- `smoke:blog-v3-unified` 통과.

남은 마스터 적용:
1. DDL: `psql -d jay -f bots/blog/migrations/025-final-content-text-for-analyzer.sql`
2. 다음 `collect:final-content --write` 이후 `master-edit-analyzer`가 저장 실본을 소비하는지 운영 로그 확인.
3. launchd/live 실행/commit/push는 별도 승인 시 수행.

이력: 2026-06-13 B2c 구현·검증 (코덱스)

## T. CODEX-B2c 메티 독립 검증 (2026-06-13) — 합격

| 항목 | 결과 |
|---|---|
| 스텁 제거 | post.content 자기 비교 0건 — JOIN(final_content_text 비공백 조건) + computeWordDiff(original, modified) 실본 주입 정확 |
| 범위 준수 | blo.ts 비수정 / 네이버 추가 fetch 없음(B2b 저장본만 소비) / 분석 함수군 비수정 |
| migration 025 | ADD COLUMN IF NOT EXISTS x2 + INDEX IF NOT EXISTS — 멱등 |
| 스모크 | TS-B10c ok 6 + TS-B9 회귀 ok 8 (독립 재실행) |

### 마스터 적용 절차
1. DDL: psql -d jay -f bots/blog/migrations/025-final-content-text-for-analyzer.sql
2. 커밋 (코덱스 §S + 메티 §R·T 포함)
3. 자연 검증 사슬(TS-B10c-L): 오늘 11:05 backfill(URL) -> 내일 08:30 B2b --write(실본 보존) ->
   모레 06:00 daily에서 analyzer 첫 실분석(master_edit_analysis 첫 데이터+masterStyleHint) — 메티 확인.
이력: 2026-06-13 B2c 검증 합격 (메티)

### T-1. DDL 025 적용 + B2c 종결 (2026-06-13, 마스터/메티)
- 적용 확인: final_title/final_content_text 컬럼 + changed_text 인덱스 실존(메티 DB 직접 쿼리).
- write 게이트 해제: dry-run ok + warnings [] (025 컬럼 검사 통과).
- 커밋 c192ec4fb 포함 확인. **B2 트랙(B2 적재·주입 / B2b 수집 / B2c 통합) 코드·DB·launchd 전부 완성** —
  남은 것은 자연 검증 사슬: 오늘 11:05 backfill -> 내일 08:30 B2b 첫 write -> 모레 06:00 analyzer 첫 실분석.

## U. B5-0 작성 액션 로직 재검토 1차 보고 (2026-06-13, 메티)

- 보고서: docs/design/BLO_B5_0_ACTION_LOGIC_REVIEW_2026-06.md — 플로우 맵(골격 건전) + 발견 4건:
  **F1 인스타 크로스포스트 잔존(가드 부재)** / **F2 RAG 이중화(agenticSearch + vault-context)** /
  F3 reel 죽은 경로 / F4(긍정) B2·B2c 주입 정위치.
- 권고: CODEX-B5a 정리 묶음(B3 이후). 2차 정독 대상: runLecturePost 내부·maestro 경계·gems 경로.
- 병행: 11:05 backfill 결과 확인 대기(현 08:58). GATE-R 209건 신규 false 0 청정.
이력: 2026-06-13 B5-0 1차 (메티)

### U-1. B5-0 마스터 결정 (2026-06-13)
F1(크로스포스트)·F3(reel 경로) **제거 확정** / F2 RAG **통합 확정**(vault 일원화 방향, 관리 단순화) /
F4 유지. 다음 세션: CODEX-B5a 프롬프트(제거+통합) 작성 -> 이후 B3(형식 리디자인, 외부 서칭).

## V. CODEX-B5a 프롬프트 작성 (2026-06-13, 메티)

- 선결 실측: agenticSearch = agentic-rag.ts(richer.searchRealExperiences+searchRelatedPosts 래퍼).
  searchRelatedPosts가 vault '지난 강의 연계'와 목적 중복 확정 -> vault 일원화.
- CODEX_BLO_B5A_CLEANUP_RAG_UNIFY_2026-06-13.md: §1 F1·F3 제거(social-media 보존) §2 RAG 일원화
  (relatedPosts->vault 교체, realExperiences는 직접 호출 유지+vault 적재 백로그) §3 TS-B5a §4 안전.
- 다음: 코덱스 전달 -> 검증 -> 적용. 이후 B3(형식 리디자인).
이력: 2026-06-13 B5a 프롬프트 (메티)

### V-1. CODEX-B5a 구현 결과 (2026-06-13, 코덱스)

- F1/F3 제거: `bots/blog/lib/blo.ts` 작성 완료 후 인스타 콘텐츠 생성·크로스포스트 실행·결과 필드 제거.
  `bots/social-media` 코드와 MCP 자산은 보존.
- F2 통합: `agentic-rag.ts` 래퍼 삭제. 작성 경로는 `richer.searchRealExperiences` 직접 호출 +
  `vault-context.getVaultRelatedPosts` 기반 relatedPosts로 일원화. `richer.searchRealExperiences`의 blog RAG 중복 조회 제거.
- 노드 API 정렬: `/api/blog/node/related-posts`도 vault-context 기반 응답으로 전환.
- 검증: `blo.ts` 내 `crosspost|instaContent|reel` grep 0, agenticSearch 코드 소비자 0.
  `node --check`(blo/richer/vault-context), vault relatedPosts 실조회 3건, `test:daily-dry`,
  `smoke:blo-b1-curriculum`, `smoke:final-content-diff`, `smoke:master-edit-analyzer-integration` 통과.
  강의 dry-run RAG 로그에서 `source=vault+real-experience`, episodes 4, posts 3 확인.
- 참고: 전체 강의 dry-run 작성 호출은 LLM 응답 대기 150초 초과로 검증 목적 달성 후 중단. 발행/DB write 없음.
이력: 2026-06-13 B5a 구현 (코덱스)

## W. CODEX-B5a 메티 독립 검증 (2026-06-13) — 합격

| 항목 | 결과 |
|---|---|
| 제거 완전성 | blo.ts crosspost/instaContent/reel 0 + agenticSearch/agentic-rag 참조 0 + agentic-rag.ts 삭제 + social-media 보존 |
| RAG 일원화 | blo.ts 2336~: searchRealExperiences 직접 + getVaultRelatedPosts 병행(폴백 무해) — 명세 §2 정확. node-server /related-posts도 vault 전환(코덱스 추가 발견·처리) |
| relatedPosts 0건 규명 | minSim 0.45 + **filterPublishedVaultBlogResults(published만 추천 — 합리적)** — 현재 매칭 상위가 ready 상태라 탈락. **11:05 backfill published 전환 시 자연 해소**(코드 정상, 데이터 상태) |
| 콜드스타트 노트 | 임베딩 on_demand 첫 호출 시 ok:false 폴백 가능(발행 비차단 설계 그대로 — 무해) |
| 회귀 | B1 ok4 + B10c ok6 (메티) + daily-dry/final-content-diff (코덱스) |

마스터 액션: 커밋. 라이브 자연 검증: 내일 06:00 daily(vault 기반 ragContext + 연계 블록 TS-B5-L).
이력: 2026-06-13 B5a 검증 합격 (메티)

## X. B3 패턴 연구 + 형식 규칙 초안 (2026-06-13, 메티)

- 근거: crank 745행 대조 — **실경험·구체 사례(74) vs 일반 정보 요약(44), 30점 격차**가 핵심 신호.
  views 상위 제목(체크리스트/구체 결과형) + 검증된 기술 블로그 패턴(레딧 API 차단 — 자체+지식 기반).
- 산출: docs/design/BLO_B3_FORMAT_RESEARCH_2026-06.md — R1~R6 규칙 초안 + 제목 예문 후보 +
  구현 방향(규칙 상수+후처리 이중 보장, Edu-X 방식).
- 대기: 마스터 확정 3건(규칙/예문/길이) -> CODEX-B3.
이력: 2026-06-13 B3 연구 (메티)

## Y. CODEX-B3 구현 — 형식 규칙 프롬프트+품질 게이트 연결 (2026-06-13, 코덱스)

- 공통 규칙 모듈 추가: `BLOG_FORMAT_RULES`와 `checkBlogFormatRules()`로 R1~R6를 기계 검사화.
  제목 추상어, 도입 3줄, 소제목 3~5개, 단락 3문장, 실경험, 마무리 요약/행동, 강의 다음 강 예고를 warning으로 판정.
- writer 연결: `pos-writer` 강의 경로는 기존 8,000자+ 계약을 유지하면서 B3 지시를 주입.
  `gems-writer` 일반 경로는 B3 전환 대상이라 3,000자 최소 / 3,600자대 목표로 direct·chunked·repair·sectionRatio를 정렬.
- quality 연결: `checkQualityEnhanced()`가 B3 warning을 `formatRules`에 포함하고,
  형식 위반은 발행 차단이 아니라 `autoRewriteRecommended=true`로 보정 루프에 넘김.
- 운영 설정: `runtime-config` 기본값과 `bots/blog/config.json`의 `generation.gemsMinChars`, `sectionRatio.general`을 3,000자대 기준으로 조정.
- 신규 스모크: `smoke:blo-b3-format-rules` 추가. 추상어 제목, 구체 제목, 도입 3줄, 실경험 누락,
  긴 단락, 일반 3,000자 통과, 강의 8,000자 유지, warning 기반 autoRewrite를 검증.

검증:
- `node --check`: `blog-format-rules`, `quality-checker`, `gems-writer`, `pos-writer`, `runtime-config`,
  `blo-b3-format-rules-smoke` 통과.
- `section-ratio.ts`는 기존 TS type 선언 때문에 `node --check` 직접 실행 불가. `node --import tsx` import 검증 통과.
- `bots/blog/config.json` JSON parse 통과.
- `smoke:blo-b3-format-rules`, `smoke:blo-b1-curriculum`, `test:daily-dry`, `smoke:blog-v3-unified`,
  `smoke:final-content-diff`, `smoke:master-edit-analyzer-integration` 통과.

남은 후속:
- 인기 패턴 외부 수집 -> vault `popular_pattern` 적재는 후속 B3b/B2 확장으로 분리.
- 실제 다음 일반 포스트에서 3,000자대 본문, B3 warning/autoRewrite 빈도, 크랭크 점수 변화를 자연 검증.

이력: 2026-06-13 B3 구현·검증 (코덱스)
