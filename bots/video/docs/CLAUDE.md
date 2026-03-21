# 비디오팀 CLAUDE.md — Claude Code 프로젝트 규칙

> 이 파일은 Claude Code가 비디오팀 과제 실행 시 반드시 먼저 읽는 파일입니다.
> 최종 업데이트: 2026-03-20

## 프로젝트 개요

FlutterFlow 유튜브 채널(AI·노코드 THE100) 영상 편집 자동화.
원본 영상 + 나레이션 → 자동 편집 → 1440p/60fps 최종본 렌더링.
더백클래스 LMS (the100class.flutterflow.app) 강의 영상이 대상.

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
  "source": "synced.mp4",
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
