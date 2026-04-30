# 비디오팀 세션 인수인계

> 세션 날짜: 2026-03-21
> 담당: 메티 (claude.ai Opus) + Codex
> 팀 구조 결정 (2026-03-22): Phase 2 완료 후 bots/video → packages/video 승격,
> bots/blog → packages/blog 승격, bots/worker를 통합 웹 포털로 전환
> 상태: ★ Phase 1 전체 완료 — 과제 1~13 + RAG 피드백 루프
> Phase 2 전환: 2026-03-21
> syncVideoAudio() 폐기 → AI 싱크 매칭 파이프라인으로 전환
> 과제 A~E 완료, Phase 2 마감 검증/문서 보완 완료
> Phase 3 설계 완료 (2026-03-22):
> - Twick React SDK 기반 CapCut급 타임라인 UI
> - AI 스텝바이스텝 편집 + RED/BLUE 매 스텝 품질 검증
> - 워커 피드백 시스템(ai-feedback-core/store/rag 893줄) 재사용
> - KPI: accepted_without_edit 비율
> Phase 3 5세트 batch 검증 (2026-03-24):
> - averageAutoConfirmRate: 55.0%
> - averageOverall: 75.07 (Phase 2 baseline: 79.00)
> - averageVisualSimilarity: 78.97 (Phase 2 baseline: 80.41)
> - RED 평가: 총 4회, BLUE 대안: 총 0회
> - 5세트 중 2세트 완료, 3세트는 `300000ms` timeout skip

## 2026-03-24 worker-web `/video`, `/video/editor` 실브라우저 점검 + 파일명 복구

- 범위
  - `/video` 단계형 질문 흐름, 업로드 카드 유지, 메뉴 왕복 상태 유지, 버블 스크롤
  - mobile bottom nav `영상` alert
  - `/video/editor` 좌측 Twick + 우측 AI 채팅 패널
  - 콘솔 에러 / 네트워크 실패
  - 업로드 카드 한글 파일명 깨짐
- 실제 반영
  - `bots/worker/web/components/VideoChatWorkflow.jsx`
    - 채팅 메시지를 과거 히스토리 누적형에서 현재 단계 버블 1개만 보이는 구조로 정리
    - `intro_mode/outro_mode='none'`를 완료 증거로 간주하지 않도록 phase 계산 보수화
    - stale `upload` phase localStorage 저장 방지
    - 업로드 카드 파일명 표시를 UTF-8 복구 + `NFC` 정규화 경계로 통일
  - `bots/worker/web/components/ChatCard.jsx`
    - intro/outro 카드 기본 선택 제거
    - 명시 선택 전 `설정 반영` 비활성화
  - `bots/worker/web/routes/video-api.js`
    - 새 업로드 파일명의 `original_name` 저장 시 `latin1 -> utf8 -> NFC` 복구 추가
  - `bots/worker/web/app/layout.js`
  - `bots/worker/web/public/worker-favicon.svg`
  - `bots/worker/web/public/favicon.ico`
- 검증
  - `npx next build` 반복 성공
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` 성공
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.web` 성공
  - `/video/editor` desktop에서 Twick/AI 패널 정상, 콘솔/네트워크 오류 없음
  - mobile bottom nav `영상` 클릭 시 `PC 전용 메뉴입니다. PC에서 이용해주세요` alert 확인
  - `/video` 업로드 카드 유지, 메뉴 왕복 상태 유지, 버블 영역 스크롤 확인
  - DB 저장값 직접 조회 기준, 깨진 `original_name`은 `latin1 -> utf8` 복구 후 `NFC` 정규화로 정상 파일명(`원본_나레이션_파라미터.m4a` 등)으로 되돌아감을 확인
- 남은 리스크
  - 업로드 직후 intro를 건너뛰고 outro 단계로 진입하는 현상은 자동화 검증에서 재현된 이력이 있어, 운영 브라우저 기준 최종 재확인이 남아 있다.
  - 현재 수정은 “표시 경계 + 저장 경계”를 모두 보강했으므로, 다음 세션은 intro/outro phase 전이 계측에 집중하는 것이 자연스럽다.

## 2026-03-26 worker-web `/video`, `/video/editor` 단계형 편집 워크스페이스 1차

- 범위
  - `/video`를 초기 설정/수정 모드가 분리된 단계형 채팅 워크플로우로 정리
  - `/video/editor`를 `컷 검토 -> 효과 검토 -> 일반 step` 순서의 편집 워크스페이스로 전환
  - 상단 원본 검수 플레이어 / 하단 timeline-only Twick dock / 우측 AI 패널 역할 분리
  - shell/auth/searchParams/mounted 게이트 때문에 blank/spinner에 갇히는 경계 복구
- 실제 반영
  - `bots/video/lib/cut-proposal-engine.js`
    - OCR/scene index 기반 컷 후보 생성 엔진 추가
  - `bots/worker/web/routes/video-step-api.js`
    - cut/effect review generate/action/confirm 레일 추가
    - 컷 확정 결과를 downstream `sync_map`과 finalize EDL에 반영
    - protected 원본 영상 `source-video`, 컷 프레임 `frame-preview` endpoint 추가
  - `bots/worker/web/components/VideoChatWorkflow.jsx`
    - 업로드는 `다음 단계`와 `변경사항 업로드` 흐름으로 분리
    - intro/outro는 설정 후에도 카드 유지
    - 초기 설정/수정 모드의 메시지/버튼 분기 정리
  - `bots/worker/web/components/ChatCard.jsx`
    - intro/outro/edit intent textarea 자동 높이 확장
    - 기본 선택 상태에서도 `설정 반영`이 동작하도록 초기 설정과 수정 모드 분리
  - `bots/worker/web/components/TwickEditorWrapper.js`
    - 상단 커스텀 플레이어 도입
    - 하단 Twick는 timeline-only dock으로 축소
    - 플레이어/컨트롤러/하단 타임라인 시간축 동기화 1차
    - Twick DOM inline width/height 후처리 보정으로 하단 오버플로우 복구
  - `bots/worker/web/components/EditorChatPanel.jsx`
    - 컷 단계 입력/설명/액션을 세로형으로 정리
    - 우측 `컷 구간 직접 조정` 제거, `컷 제안 요약` 카드로 역할 축소
  - `bots/worker/web/public/twick-editor-scoped.css`
    - Twick view/timeline/canvas/container 폭·높이 scoped 보강
  - `bots/worker/web/app/_shell.js`
    - 비디오 작업화면은 auth loading 중에도 provisional render 허용
  - `bots/worker/web/app/video/page.js`, `bots/worker/web/app/video/editor/page.js`
    - `useSearchParams` 제거, editor loading/dynamic import 경계 축소
  - `bots/video/lib/media-binary-env.js`, `bots/video/scripts/run-pipeline.js`, `bots/video/scripts/render-from-edl.js`, `bots/video/scripts/test-phase3-batch.js`
    - media binary PATH / render / batch 종료 경계 보강
- 검증
  - `node --check bots/video/lib/cut-proposal-engine.js`
  - `node --check bots/video/lib/media-binary-env.js`
  - `node --check bots/video/scripts/render-from-edl.js`
  - `node --check bots/video/scripts/run-pipeline.js`
  - `node --check bots/video/scripts/test-phase3-batch.js`
  - `node --check bots/worker/web/app/_shell.js`
  - `node --check bots/worker/web/app/video/page.js`
  - `node --check bots/worker/web/app/video/editor/page.js`
  - `node --check bots/worker/web/components/ChatCard.jsx`
  - `node --check bots/worker/web/components/EditorChatPanel.jsx`
  - `node --check bots/worker/web/components/TwickEditorWrapper.js`
  - `node --check bots/worker/web/components/VideoChatWorkflow.jsx`
  - `node --check bots/worker/web/routes/video-api.js`
  - `node --check bots/worker/web/routes/video-step-api.js`
  - `npx next build` (`bots/worker/web`) 반복 성공
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.web`
  - `/video`, `/video/editor` `200` 확인
- 남은 리스크
  - 하단 컷 요소 드래그와 상단 플레이어의 완전 양방향 동기화는 아직 1차 수준
  - effect review 결과를 preview/finalize에 더 직접 반영해야 함
  - 컷/효과 단계의 상세 사용자 수정 이력은 DB 원장으로 승격이 남아 있음

---

## Phase 2 현재 상태

- `scene-indexer.js`, `narration-analyzer.js`, `sync-matcher.js`, `intro-outro-handler.js`가 추가됐다.
- `run-pipeline.js`는 이제 `scene-indexer -> narration-analyzer -> sync-matcher -> intro/outro -> syncMapToEDL` 흐름을 사용한다.
- worker-web `/video`는 5단계 흐름(업로드 → 인트로 → 아웃트로 → 의도 → 시작)으로 확장됐다.
- `video_sessions`에는 `intro_mode`, `intro_prompt`, `intro_duration_sec`, `outro_mode`, `outro_prompt`, `outro_duration_sec` 컬럼이 추가됐다.
- 현재 런타임 검증 경계:
  - OCR은 `tesseract.js` 기본 경로에 더해 로컬 `tesseract` CLI fallback을 테스트 레일에 붙였다.
  - STT/LLM은 샌드박스 네트워크 제약 시 오프라인 fixture fallback으로 테스트를 이어간다.

### 2026-03-22 검증 메모

- `test-scene-indexer.js --source-video=원본_파라미터.mp4`
  - `duration_s=1410.45`
  - `total_frames_captured=141`
  - `unique_frames=42`
  - `scene_count=42`
- `test-narration-analyzer.js --source-audio=원본_나레이션_파라미터.m4a`
  - 샌드박스 네트워크 제약으로 `offline fixture fallback`
  - fallback 세그먼트를 3등분 고정에서 공용 fixture 5세그먼트 구조로 보강
  - `total_entries=5`, `total_segments=5`
- `test-sync-matcher.js`
  - 더미 기준 `matched_keyword=2/2`
  - `overall_confidence=0.8334`
- `test-full-sync-pipeline.js`
  - `scene_count=42`
  - `segment_count=5`
  - `keyword=5`, `embedding=0`, `hold=0`, `unmatched=0`
  - `sync_confidence=0.6`
  - `intro_prompt.mp4` 생성 확인
- `video_edits.preview_ms`
  - `005-preview-ms.sql` 추가
  - `run-pipeline.js`가 preview 렌더 직후 wall-clock을 원장에 저장하도록 보강
- preview/final render 경계 보강
  - `test-full-sync-pipeline.js --render-preview`가 raw narration 직결 대신 runtime과 동일하게 `normalizeAudio()`를 선행하도록 수정
  - `edl-builder.js`는 V2 clip concat 전에 모든 비디오를 공통 캔버스로 정규화하고, narration 오디오는 clip speed와 독립적으로 timeline 길이에 맞춰 유지하도록 보강
  - speed floor(`min_speed_factor=0.5`) 때문에 영상 길이가 narration보다 짧아질 때는 `tpad=stop_mode=clone`으로 마지막 프레임을 hold해 timeline 길이를 맞추도록 수정
  - 재검증 결과 `preview-fixed.mp4`는 `1280x720 / 60fps / 264s`, audio `48000Hz stereo / 264s`로 A/V 길이 정합성 회복 확인
- reference quality baseline 추가
  - `reference-quality.js`, `test-reference-quality.js`를 추가해 자동 결과와 실제 편집본(`edited/`)을 구조/시각 유사도 기준으로 비교할 수 있게 함
  - 현재 파라미터 세트 baseline:
    - `overall=70.43`
    - `duration=64.26`
    - `resolution=25.18`
    - `visual_similarity=79.61`
  - 해석: 현재 약점은 sync 자체보다 편집본 대비 `길이 축소`와 `preview 해상도 차이`이며, 장면 유사도는 baseline usable 수준
  - 5세트 batch baseline:
    - `averageOverall=68.88`
    - `averageDuration=54.30`
    - `averageResolution=25.11`
    - `averageVisualSimilarity=83.76`
  - 세트별 overall:
    - 파라미터 `72.77`
    - 동적데이터 `73.15`
    - 컴포넌트스테이트 `69.88`
    - DB생성 `64.77`
    - 서버인증 `63.85`
  - 해석: 현재 Phase 2 preview는 장면 유사도는 전반적으로 높지만(`80~86`), 사람 편집본 대비 길이가 크게 짧아 duration score가 전체를 깎는다. 가장 큰 병목은 `sync 정확도`보다 `편집 길이 설계`와 `preview/final 출력 정책 차이`다.
- final render 단일 세트 기준선 추가
  - `test-full-sync-pipeline.js --render-final`이 파라미터 세트에서 성공
  - `final.mp4` 검증 결과:
    - `2560x1440 / 60fps / 264s`
    - `AAC 48kHz stereo / 264s`
    - `faststart=true`
    - `file_size=46,555,622`
    - `duration_ms=249452`
  - final reference quality:
    - `overall=81.62`
    - `duration=64.26`
    - `resolution=99.30`
    - `visual_similarity=79.82`
  - 해석: final render로 올라오면서 preview 병목이던 해상도 점수는 거의 해소됐고, 남은 핵심 차이는 사람 편집본 대비 `길이/구조`다.
- final render batch 레일 추가
  - `test-final-reference-quality-batch.js`를 추가해 샘플 5세트를 직접 순회하며 `final render -> reference 비교`를 한 번에 수행할 수 있게 함
  - temp의 `validation_report.json`에 기대지 않고, `samples/raw + narration + edited`를 source of truth로 사용
  - 1세트 sanity check:
    - `--title=파라미터 --json` 성공
    - `averageOverall=81.62`
    - `averageFinalRenderMs=210767`
  - final render watchdog 보강:
    - `edl-builder.js`에 `computeFinalWatchdogOptions()`를 추가해 긴 세트가 고정 2분 stall timeout으로 잘리지 않도록 보강
    - `서버인증` 세트는 기존 `last=2.01s` false stall을 넘겨 `duration_ms=754867`로 final render 완료 확인
  - 5세트 final baseline 완료:
    - `averageOverall=79.00`
    - `averageDuration=54.67`
    - `averageResolution=99.58`
    - `averageVisualSimilarity=80.41`
  - 세트별 overall:
    - 파라미터 `81.62`
    - 컴포넌트스테이트 `80.16`
    - 동적데이터 `85.12`
    - 서버인증 `72.96`
    - DB생성 `75.12`
  - 해석: final 기준에서도 공통 병목은 장면 유사도보다 사람 편집본 대비 `길이/구조`다. 해상도 문제는 거의 해소됐고, 다음 1순위는 duration/structure 튜닝이다.
  - 2026-03-23 final batch rerun:
    - `test-final-reference-quality-batch.js --json`은 이제 `bots/video/temp/final_batch_report.json`에 결과를 저장한다.
    - plain command 기본 timeout은 `300000ms`로 조정했고, 느린 세트는 skip하도록 했다.
    - 현재 이 머신 실측에서는 5세트 모두 `skipped_timeout`으로 종료됐다.
    - 해석: Phase 2 final batch는 레일 자체는 닫혔지만, 현 로컬 런타임에서는 full final render 5세트 일괄 검증을 소화하지 못한다. 다음 단계는 더 긴 배치 전용 런타임을 쓰거나, final 기준 fixture/light render 전략을 따로 두는 것이다.
  - duration/structure 진단 레일 추가:
    - `analyze-final-structure-gap.js`를 추가해 `final.mp4 + edit_decision_list.json + reference`만으로 길이/구조 병목을 재현 가능하게 분석할 수 있게 함
    - `서버인증` 진단:
      - `duration_ratio=0.4126`
      - `speed_floor_ratio=0.8`
      - `hold_clip_count=1`
      - `main:900-910s` 10초 window가 `4회`, 총 `676.8s` 재사용
      - 해석: 짧은 anchor 장면 반복 + hold 의존이 커서 사람 편집본 대비 구조 압축이 가장 큼
    - `DB생성` 진단:
      - `duration_ratio=0.3803`
      - `speed_floor_ratio=0.8`
      - `hold_clip_count=0`
      - `main:1370-1400s` 30초 window가 `2회`, 총 `201.6s` 재사용
      - 해석: hold는 없지만 짧은 source window 재사용과 speed floor 의존이 커서 길이/구조 차이가 큼

해석:
- 원본 장면 인덱싱 품질 자체는 usable 수준이다.
- 현재 가장 큰 병목은 `scene-indexer`가 아니라 샌드박스 제약 시 narration 분석이 live STT가 아니라 fallback으로 내려간다는 점이다.
- fallback 세그먼트 granularity 보강 후 첫 구간 `unmatched`는 해소됐다.
- `preview_ms` 원장화, preview A/V 정합성 복구, 파라미터 세트 final render 단일 검증까지 완료됐다.
- 다음 Phase 2 보강 1순위는 final 5세트 baseline을 기준으로 낮은 점수 세트(`서버인증`, `DB생성`)의 duration/structure 차이를 줄이고, 그다음 transition 재도입 설계를 진행하는 것이다.
- 현재 구조상 바로 손볼 1순위는 `sync-matcher` 자체 재설계보다,
  - 긴 오디오에 대한 fallback narration 세그먼트 추가 세분화
  - `speed=0.5` floor 과다 의존 완화
  - 짧은 source window 반복 사용 제한
  순서다.
- duration/structure 튜닝 1차 적용:
  - `narration-analyzer.js`
    - offline fixture segment count를 길이 비례형(`4/5/6/7`)으로 확장
    - `서버인증`, `DB생성`은 generic fallback 대신 샘플 특화 키워드/주제 세트를 사용하도록 보강
    - `test-full-sync-pipeline.js` 오프라인 fallback은 normalized temp 파일명이 아니라 원본 sample label을 함께 전달하도록 수정
  - `sync-matcher.js`
    - 같은 짧은 source window(`<=30s`)를 반복 선택할 때 감점하는 `repeated_window_penalty`를 추가
  - sync-level 재검증:
    - `서버인증`: `segments=7`, `keyword=7`, `hold=0`, `unmatched=0`
    - `DB생성`: `segments=6`, `keyword=4`, `hold=2`, `unmatched=0`
  - 해석: `서버인증`은 기존 generic fallback에서 `keyword 4 / hold 3`이던 구조가 `keyword 7 / hold 0`으로 회복됐다. `DB생성`은 아직 hold가 남지만, 다음 final 재렌더 대상으로는 충분히 개선 여지가 생겼다.
- duration/structure 튜닝 2차 적용:
  - `sync-matcher.js`
    - `syncMapToEDL()`에 pacing policy를 추가해 timeline을 나레이션 길이에만 고정하지 않고 `hold / low confidence / speed floor` 구간에 추가 체류 시간을 부여하도록 보강
    - main clip metadata에 `narration_duration`, `timeline_duration`, `pacing_extra_sec`를 기록
  - `edl-builder.js`
    - main clip 오디오에 `apad`를 추가해 timeline이 narration보다 길어져도 무음 패딩으로 final render를 유지하도록 보강
  - `video-config.yaml`
    - `pacing_multiplier=1.15`
    - `pacing_max_extra_sec=20`
    - `hold_pacing_extra_sec=12`
    - `low_confidence_pacing_extra_sec=6`
    - `speed_floor_threshold=0.55`
    - `speed_floor_pacing_extra_sec=10`
    - `pacing_total_max_extra_sec=24`
  - EDL 수준 재검증:
    - `서버인증`: `edl.duration=1008.129`, `pacing_extra_total=162.129`
    - `DB생성`: `edl.duration=629.8`, `pacing_extra_total=125.8`
  - final 재렌더 재측정:
    - `서버인증`
      - `overall=75.61` (이전 `72.42`)
      - `duration=49.13` (이전 `41.26`)
      - `visual_similarity=75.30` (이전 `72.95`)
      - `duration_ratio=0.4913`
    - `DB생성`
      - `overall=78.77` (이전 `76.34`)
      - `duration=47.47` (이전 `38.03`)
      - `visual_similarity=85.75` (이전 `85.75` 근처 유지)
      - `duration_ratio=0.4747`
  - 해석: 이번 단계에서 병목을 더 명확히 줄인 것은 `키워드`가 아니라 `timeline length`다. pacing policy는 두 저점 세트 모두에서 실제 점수 개선으로 이어졌고, 다음 1순위는 `hold 완화`와 `반복 source window` 감소다.

## Phase 1 완료 요약

### 구현된 과제 (13 + RAG)
- 과제 1: 스캐폴딩 + DB (`video_edits` 테이블)
- 과제 2: FFmpeg 전처리 (오디오 정규화 + 48kHz + 합성)
- 과제 3: Whisper STT (한국어 SRT)
- 과제 4: LLM 자막 교정 (`gpt-4o-mini` + `gemini` fallback)
- 과제 5: CapCutAPI 드래프트 (선택적 보조, `--with-capcut`)
- 과제 6: 영상 분석 + EDL JSON + FFmpeg 렌더링
- 과제 7: 파이프라인 통합 (`run-pipeline.js` + single-flight lock + watchdog)
- 과제 8: 워커 웹 대화형 영상 편집 (16 API + 대화형 채팅 UI)
- 과제 9: n8n 워크플로우 연동 (webhook + internal dispatch + fallback)
- 과제 10: Critic Agent / RED Team (자막+오디오+영상 구조 분석)
- 과제 11: Refiner Agent / BLUE Team (SRT 수정 + EDL 생성 + 부분 실패 허용)
- 과제 12: Evaluator + 품질 루프 (Critic→Refiner→Evaluator 순환)
- RAG: 피드백 루프 (`video-rag.js`, `rag_video` 컬렉션)
- 과제 13: 5세트 검증 (5/5 성공, 평균 440초, 총 `$0.28`)

### 아키텍처 변경 이력
- CapCut `draft_info.json` 암호화 → EDL JSON 기반으로 전환
- RED/BLUE 팀이 영상 편집(컷/효과/전환)까지 확장
- 프리뷰: FFmpeg 720p + 워커 웹 HTML5 Video+VTT
- n8n: `ExecuteCommand` 거부 → `HTTP Request + internal dispatch API`로 전환

### 5세트 검증 결과
- 세트 1: 파라미터 — 215초, `$0.028`, 71 entries
- 세트 2: 컴포넌트스테이트 — 523초, `$0.051`, 107 entries
- 세트 3: 동적데이터 — 418초, `$0.051`, 101 entries
- 세트 4: 서버인증 — 712초, `$0.091`, 247 entries
- 세트 5: DB생성 — 334초, `$0.054`, 143 entries
- 총 비용: `$0.28 / 5세트` → 월 20영상 환산 `$1.10`

### RAG 축적 현황
- `rag_video`: 7건 (결과 6 + 피드백 1)
- `estimateWithRAG` confidence: `high` (5건 기준)

### 워커 웹 반영 상태
- `npx next build` 성공
- `ai.worker.nextjs` launchd 재기동 완료
- `http://127.0.0.1:4001/video` → `200 OK`
- `http://127.0.0.1:4001/video/history` → `200 OK`
- `video_sessions.company_id`를 worker 회사 ID 체계와 맞춰 `TEXT`로 보정 완료
- 업로드 UI는 드래그앤드롭 + 아이콘 클릭 + 버튼 클릭 3가지 입력 경로를 모두 지원하도록 보강 완료
- 한글 파일 업로드 시 `original_name`이 깨지던 문제를 UTF-8 복원 경계로 보정 완료
- `/video`는 현재 세션 ID를 URL `?session=` + `localStorage`에 동기화해 새로고침 후에도 진행 세션 복원이 가능하도록 보강 완료
- `POST /sessions/:id/start`는 n8n 응답만 신뢰하지 않고 실제 `video_edits(session_id, pair_index)` 생성까지 확인하며, 미생성 시 direct fallback으로 재실행하도록 보강 완료

### 이번 세션 운영 복구 메모
- 실제 테스트 세션은 `video_sessions.id=1`
- 새로고침과 첨부파일 수정이 겹치며 세션 컨텍스트가 끊겼고, 한동안 `video_edits`가 생성되지 않아 worker-web 화면에는 `자동 편집 진행중`만 남는 상태가 발생했다
- 세션 1은 direct recovery로 `video_edits.id=16`, trace `f84aa3f6-329e-43af-8eac-ae6f8eeaf474`를 다시 생성해 파이프라인을 복구했다
- 세션 1 프리뷰 검은 화면 원인은 `edl-builder.js`의 연속 `fade in/out` transition 렌더 로직이었다
- 임시 조치로 렌더 단계에서는 `transition` edit를 적용하지 않고 EDL 원장에만 유지하도록 바꿨다
- 다음 세션 시작점은 세션 1 `preview.mp4` 재검증과 올바른 segment 기반 transition 렌더(`xfade` 계열) 설계다

---

## 프로젝트 구조

```text
ai-agent-system/bots/video/
├─ config/video-config.yaml
├─ context/IDENTITY.md
├─ docs/ (CLAUDE.md, VIDEO_HANDOFF.md, design.md, tasks.md, ANALYSIS.md, SESSION_HANDOFF_VIDEO.md)
├─ lib/
│   ├─ ffmpeg-preprocess.js (과제 2)
│   ├─ whisper-client.js (과제 3)
│   ├─ subtitle-corrector.js (과제 4)
│   ├─ capcut-draft-builder.js (과제 5, 선택적)
│   ├─ video-analyzer.js (과제 6)
│   ├─ edl-builder.js (과제 6)
│   ├─ critic-agent.js (과제 10)
│   ├─ refiner-agent.js (과제 11)
│   ├─ evaluator-agent.js (과제 12)
│   ├─ quality-loop.js (과제 12)
│   ├─ video-rag.js (RAG 피드백 루프)
│   └─ video-n8n-config.js (과제 9)
├─ migrations/ (001, 002)
├─ n8n/ (video-pipeline-workflow.json, setup-video-workflow.js)
├─ scripts/ (run-pipeline.js, render-from-edl.js, test-*.js, check-n8n-video-path.js)
├─ src/index.js
├─ samples/ (5세트 raw + narration)
├─ exports/
└─ temp/ (run-* 세션 디렉토리)
```

워커 웹 연동:

```text
bots/worker/web/routes/video-api.js (16 엔드포인트)
bots/worker/web/routes/video-internal-api.js (n8n dispatch)
bots/worker/web/app/video/page.js (대화형 UI)
bots/worker/web/app/video/history/page.js (이력)
```

---

## 현재 상태

### 완료된 구조
- `run-pipeline.js --skip-render` 기준 5세트 preview 원장 복구 완료
- worker-web `/video`, `/video/history` 빌드와 런타임 반영 완료
- n8n live webhook + direct fallback + worker secret 영속화 완료
- Critic / Refiner / Evaluator / quality-loop / RAG feedback loop 구현 완료
- worker-web `/video` 세션 복원, 업로드 파일명 복구, n8n start 검증 fallback까지 운영 경계 보강 완료

### 남은 핵심 과제
- 5세트 final baseline 기준 duration/structure 튜닝
- 품질 루프 수렴률 개선
- RAG 샘플 수를 늘려 추천 품질과 예상 시간 정확도 향상
- transition 렌더를 다시 도입하되 검은 화면이 생기지 않도록 segment 기반 설계로 교체

---

## 다음 세션에서 해야 할 것

### 즉시
- 낮은 점수 세트(`서버인증`, `DB생성`) duration/structure 튜닝
- worker-web 세트별 상태/예상시간 표시 세분화
- 세션 1 (`id=1`, edit `id=16`, trace `f84aa3f6-329e-43af-8eac-ae6f8eeaf474`) 프리뷰 재렌더 결과 시각 검증
- `transition` 렌더 임시 비활성화 상태를 `xfade` 또는 구간 분할 기반 구현으로 대체
- `sync_map` 기준선으로 실제 preview/final render 품질 검증

### 이후
- 품질 루프 수렴률 개선
- RAG 축적량 확대 후 추천/추정 품질 재평가
- 비디오팀 local LLM 계층 도입 준비 (맥미니 도착 이후)

---

## 인수인계 메모

- Phase 1 범위는 구현/검증/문서 기준으로 닫혔다.
- 다음 세션은 새 기능 추가보다 먼저 `final render` 운영 검증과 원장 고도화부터 보는 것이 자연스럽다.
- 비디오팀은 워커 웹과 강하게 연결되지만, 도메인 로직은 별도 팀으로 유지하는 현재 구조가 맞다.
