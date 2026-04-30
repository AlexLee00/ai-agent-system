# 비디오팀 CLAUDE.md — Claude Code 프로젝트 규칙

> 이 파일은 Claude Code가 비디오팀 과제 실행 시 반드시 먼저 읽는 파일입니다.
> 최종 업데이트: 2026-03-21 (Phase 2 AI 싱크 매칭 전환)

## 프로젝트 개요

FlutterFlow 유튜브 채널(AI·노코드 THE100) 영상 편집 자동화.
원본 영상(무음 FlutterFlow 화면녹화) + 나레이션 → AI 싱크 매칭 → 1440p/60fps 최종본 렌더링.
더백클래스 LMS (the100class.flutterflow.app) 강의 영상이 대상.

★ Phase 2 핵심: 원본 영상 전체를 OCR로 장면 인덱싱 후,
나레이션 구간별로 적합한 장면을 AI가 자동 매칭하는 구조.
Phase 1의 syncVideoAudio(원본 앞부분만 자름)는 폐기됨.

## 기술 스택

- Node.js (ai-agent-system 통합, packages/core/lib/ 15개 모듈 재사용)
- FFmpeg (전처리 + 최종 렌더링)
- OpenAI Whisper API (STT)
- CapCutAPI (선택적 보조 프리뷰, Apache 2.0) — 메인 파이프라인은 EDL JSON + FFmpeg
- PostgreSQL (jay DB, 기존 pg-pool.js 사용)
- 워커 웹 (Express.js + React, 대화형 영상 편집 페이지)

## ★ YouTube 공식 권장 기반 확정값 (2026-03-20)

이 값은 유튜브 공식 문서 + ffprobe 실측 분석 기반으로 확정됨.
모든 FFmpeg 명령어에 반드시 이 값을 사용할 것.

```yaml
output:
  width: 2560
  height: 1440
  fps: 60
  codec: libx264
  profile: high
  video_bitrate: 24M
  pixel_format: yuv420p
  movflags: +faststart
  color_space: bt709

audio:
  codec: aac
  bitrate: 384k
  sample_rate: 48000
  channels: 2

audio_normalize:
  target_lufs: -14.0
  true_peak: -1.0
  lra: 20.0
```

## 입력 파일 사양 (실측)

```
원본 영상: 1920x1080, 60fps, H.264, ~270kbps, AAC 48kHz stereo
나레이션: AAC, 44100Hz, mono, 68kbps
```

## 절대 규칙

1. 비트레이트 24M 사용 (3000k 아님) — YouTube VP9 코덱 품질 극대화
2. 오디오 48kHz/384kbps 사용 — YouTube 공식 권장
3. movflags +faststart 필수 — YouTube Fast Start 권장
4. H.264 High Profile 사용 — YouTube 권장
5. 해상도 정확히 2560x1440 (2542 아님) — CapCut 비표준 방지
6. True Peak -1.0 dBTP 이하 유지 — 클리핑 방지
7. 과제별 단위 테스트 통과 후 다음 과제 진행
8. 각 과제 완료 = 1 커밋 (테스트 포함)
9. 기존 packages/core/lib/ 모듈은 수정하지 않고 재사용
10. config에서 값을 읽어 사용 (하드코딩 금지)
11. 영상 편집 결정은 EDL JSON으로 표현 (CapCut draft_info.json 의존 금지)
12. RED/BLUE 품질 루프는 자막+오디오+영상 편집 모두 관여
13. 프리뷰는 FFmpeg 720p 프리뷰 또는 워커 웹 HTML5 Video+VTT
14. RAG 피드백 루프: 편집 완료 시 결과를 반드시 RAG에 축적 (video-rag.js `storeEditResult`)
15. Critic/EDL은 RAG 인사이트를 참조 후 분석/생성 (`enhanceCriticWithRAG`, `enhanceEDLWithRAG`)
16. RAG 실패 시 파이프라인 중단 금지 — graceful degradation (`rag-safe.js` 패턴)
17. 원본 영상은 전체를 OCR 장면 인덱싱 — syncVideoAudio()로 앞부분만 자르지 않음
18. 나레이션↔장면 매칭은 키워드 매칭 우선, 임베딩 유사도 fallback
19. 인트로/아웃트로는 파일 업로드 또는 프롬프트 설명 중 택1 (하이브리드)
20. OCR은 tesseract.js 사용 (FlutterFlow UI가 영어 텍스트 위주라 eng 모델로 충분)
21. 비디오 도메인 로직은 bots/video/lib/ 안에만 작성 (워커에 직접 넣지 말 것 — 추후 packages/video 승격 대비)
22. Phase 3 대화형 편집: 매 스텝마다 RED/BLUE 검증 + 사용자 피드백 → RAG 축적

## 문서 참조 순서

1. 이 파일 (CLAUDE.md) — 규칙 + 확정값
2. VIDEO_HANDOFF.md — 전체 맥락 + 현재 상태
3. video-team-design.md — 설계 상세 (DB, API, UX)
4. video-team-tasks.md — 과제별 프롬프트
5. samples/ANALYSIS.md — 영상 분석 데이터

## 샘플 데이터 위치

```
bots/video/samples/raw/       — 원본 영상 5세트
bots/video/samples/narration/ — 나레이션 5세트
bots/video/samples/edited/    — 편집 완료본 5세트 + 타임스탬프 18개
```

## VP9 코덱 트리거 — 왜 1440p인가

유튜브는 1440p 이상 영상에 VP9 코덱을 적용하고, 1080p에는 AVC1(H.264)을 씀.
VP9는 같은 비트레이트에서 AVC1보다 훨씬 선명.
유튜브 스트리밍 비트레이트: 1440p@60fps VP9 = 12Mbps vs 1080p@60fps AVC1 = 5.7Mbps.
따라서 원본이 1080p여도 반드시 1440p로 업스케일 렌더링해야 함.
24Mbps로 업로드하면 유튜브 재인코딩 후에도 디테일이 최대한 보존됨.

## EDL JSON (편집 결정 목록) — CapCut 대체

CapCut 7.2.0 draft_info.json 암호화 + CapCutAPI 저장 실패로 CapCut 의존 파이프라인 폐기.
대신 EDL JSON으로 편집 결정을 표현하고, FFmpeg가 직접 실행.

EDL JSON 구조:
```json
{
  "version": 1,
  "source": "원본_파라미터.mp4",
  "subtitle": "subtitle_corrected.srt",
  "edits": [
    { "type": "cut", "from": 225.0, "to": 250.0, "reason": "무음 구간" },
    { "type": "transition", "at": 510.0, "effect": "fade", "duration": 0.5 },
    { "type": "speed", "from": 720.0, "to": 750.0, "factor": 1.5 },
    { "type": "text_overlay", "at": 0, "duration": 3, "text": "FlutterFlow 파라미터" }
  ]
}
```

EDL 생성 주체:
- Critic(RED): 영상 분석 → 컷/효과 권고 → critic_report.json
- Refiner(BLUE): 권고 반영 → edit_decision_list.json 생성/수정
- 영상제작팀: 워커 웹에서 프레임 단위 편집 의견 → EDL 수정
- FFmpeg: EDL JSON 해석 → 프리뷰(720p) 또는 최종 렌더링(1440p/24Mbps)

## AI 싱크 매칭 파이프라인 — Phase 2 핵심

원본 영상(23~74분, 무음 FlutterFlow 화면 녹화)과 나레이션(4~14분)을
자동으로 매칭하는 파이프라인.

입력 특성:
- 원본 영상: 완전 무음(-91dB), 1920x1080, 마우스/클릭 포함 화면 녹화
- 나레이션: 한국어, 4~14분
- 원본 대비 나레이션 비율: 10~30% (원본의 대부분은 사용 안 됨)
- 최종본은 나레이션 길이 + 인트로/아웃트로 (7~34분)

파이프라인 흐름:
1. normalizeAudio (나레이션 정규화)
2. STT + 자막 교정 (기존 Whisper + gpt-4o-mini)
3. indexVideo — 원본 프레임 캡처 → OCR → LLM 장면 분류 (scene-indexer.js)
4. analyzeNarration — 나레이션 구간별 의도/키워드 추출 (narration-analyzer.js)
5. buildSyncMap — 키워드 매칭 → 임베딩 fallback → 시간순서 보정 (sync-matcher.js)
6. processIntroOutro — 파일 또는 프롬프트 기반 인트로/아웃트로 (intro-outro-handler.js)
7. syncMapToEDL → 렌더링 (edl-builder.js 확장)
8. 품질 루프 + RAG (기존)

핵심 모듈:
- `bots/video/lib/scene-indexer.js` — OCR 장면 인덱싱
- `bots/video/lib/narration-analyzer.js` — 나레이션 구간 분석
- `bots/video/lib/sync-matcher.js` — AI 싱크 매칭 엔진
- `bots/video/lib/intro-outro-handler.js` — 인트로/아웃트로 하이브리드
- `bots/video/lib/reference-quality.js` — 실제 편집본과 자동 품질 비교

## Phase 3: AI 대화형 편집 + 자기학습

Phase 2의 일괄 처리 결과를 스텝별로 분해해, 매 스텝마다
RED팀(Critic) 평가 + BLUE팀(Refiner) 대안 + 사용자 판단을 거치는 구조.

UI: Twick React SDK 기반 타임라인 + AI 채팅 패널
피드백: packages/core/lib/ai-feedback-core + store + rag 재사용 (schema='video')
KPI: accepted_without_edit 비율 (목표: 30번째 영상에서 95%)

상세: bots/video/docs/video-phase3-design.md 참조

## 인트로/아웃트로 하이브리드

인트로/아웃트로는 2가지 모드 중 택1:

Mode A (file): 사용자가 인트로.mp4/아웃트로.mp4 직접 업로드
→ 해상도/fps 본편 맞춤 후 EDL 앞/뒤에 concat

Mode B (prompt): "채널 로고 3초 + 강의 제목 페이드인" 텍스트 설명
→ LLM이 FFmpeg drawtext 명령 생성 → 타이틀 카드 자동 생성
→ LLM 실패 시 기본 템플릿 fallback (검정 배경 + 흰색 텍스트)

Mode `none`: 인트로/아웃트로 없음 (기본값)

워커 웹 UI 흐름 (5단계):
1. 파일 업로드 (원본 + 나레이션)
2. 인트로 선택 (파일/프롬프트/없음)
3. 아웃트로 선택 (파일/프롬프트/없음)
4. 편집 의도 입력
5. 편집 시작

## 팀 구조 로드맵 (2026-03-22 확정)

현재: bots/video/ (비디오팀 별도) → Phase 2 완료 후 packages/video/로 승격 예정.
워커팀은 통합 웹 포털로, 영상 편집 UI + 블로그 관리 UI + 기존 SaaS를 제공.
비디오 도메인 로직(FFmpeg/OCR/EDL/매칭)은 반드시 bots/video/lib/ 안에 작성.
워커에는 API 라우트(video-api.js)와 UI(page.js)만 배치 — 처리 로직을 넣지 말 것.

목표 구조:
  packages/core/   — 공용 인프라 (기존 44 모듈)
  packages/video/  — 영상 처리 엔진 (bots/video에서 승격)
  packages/blog/   — 텍스트 처리 엔진 (bots/blog에서 승격)
  bots/worker/     — 통합 웹 포털 (UI 채널)

## RAG 피드백 루프 — 학습하는 편집 시스템

비디오팀은 편집 결과를 RAG(pgvector)에 축적하고, 다음 편집 시 참조하여 점점 정교해지는 자기학습형 파이프라인.

컬렉션: `rag_video` (`reservation` 스키마)

저장 시점:
- 파이프라인 완료 시 (`preview_ready` / `completed`) → `storeEditResult()`
- 마스터 `confirm` / `reject` 시 → `storeEditFeedback()`

참조 시점:
- Critic 분석 시 → `enhanceCriticWithRAG()` (과거 반복 이슈 주의)
- EDL 생성 시 → `enhanceEDLWithRAG()` (과거 성공 패턴 반영)
- 예상 시간 추정 시 → `estimateWithRAG()` (벡터 유사도 기반)

핵심 모듈: `bots/video/lib/video-rag.js`
- `storeEditResult`, `storeEditFeedback`
- `searchSimilarEdits`, `searchEditPatterns`
- `enhanceCriticWithRAG`, `enhanceEDLWithRAG`
- `estimateWithRAG`

RAG 실패 시: `rag-safe.js` 서킷 브레이커 → 2시간 우회 → 파이프라인 정상 진행
