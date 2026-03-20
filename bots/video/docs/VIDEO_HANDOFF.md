# 비디오팀 인수인계 허브

> 최종 업데이트: 2026-03-20
> 상태: 과제 3 Whisper STT 완료 / 과제 4(LLM 자막 교정) 착수 가능

---

## 문서 링크

```
★ 현재 위치: bots/video/docs/ (개발 중 코드 옆 배치)
★ 안정화 후: docs/video/ 로 이동 (프로젝트 문서 체계 통합)

┌───────────────────────────────┬────────────────────────────────────────┐
│ 문서                           │ 용도                                    │
├───────────────────────────────┼────────────────────────────────────────┤
│ CLAUDE.md                     │ 구현 규칙 + YouTube 렌더링 확정값       │
│                               │ Claude Code 시작 전 우선 참조 문서      │
├───────────────────────────────┼────────────────────────────────────────┤
│ VIDEO_HANDOFF.md              │ 이 파일 (인수인계 허브)                 │
│                               │ 안정화 후 → docs/VIDEO_HANDOFF.md      │
├───────────────────────────────┼────────────────────────────────────────┤
│ video-automation-tech-plan.md │ 기술 구현 방안 전체 (933행)              │
│                               │ 아키텍처, 비용, RED/BLUE, 로드맵        │
├───────────────────────────────┼────────────────────────────────────────┤
│ video-team-design.md          │ 설계 문서 (모듈 매핑 + 기능목록)        │
│                               │ 기존 15개 모듈 재사용 매핑              │
│                               │ 신규 10개 모듈 목록 + 작업 위치         │
│                               │ DB 스키마, config, 워커 웹 연동 설계    │
├───────────────────────────────┼────────────────────────────────────────┤
│ video-team-tasks.md           │ 소과제 13개 분류 + Claude Code 프롬프트 │
│                               │ Week 1 (7과제) + Week 2 (6과제)        │
│                               │ + Week 3 최종 테스트 + 문서 이동        │
├───────────────────────────────┼────────────────────────────────────────┤
│ SESSION_HANDOFF_VIDEO.md      │ 세션 로그 / LMS 구조 학습 메모          │
│                               │ 현재 상태와 다음 작업 경계 기록         │
└───────────────────────────────┴────────────────────────────────────────┘
```

## 핵심 아키텍처 요약

```
워커 웹 = 대화형 영상 편집 UI (절차 안내 + 편집 의도 수집 + 다운로드)
CapCut (무료) = 편집 UI + 프리뷰 (Export 안 함, 편집 상태 유지)
FFmpeg = 최종 렌더링 (1440p/60fps, CapCut 제한 완전 우회)
CapCutAPI = 오픈소스 MCP, 드래프트 자동 생성
OpenClaw = 오케스트레이터 (전체 파이프라인 관리)
비용: 월 $0.86 (Whisper + LLM + 품질 루프), 나머지 전부 $0

UX 흐름 (9단계):
  1. 웹에서 영상+음성 다중 업로드 (순서대로)
  2. 편집 의도 수집 ("자막 크게 해주세요")
  3. 파일 수집 확인 (매칭 표시)
  4. AI 편집 진행 (RAG 예상시간 + 실시간 진행률)
  5. 1차 완료 (품질 점수)
  6. CapCut 편집 상태 확인 안내
  7. 웹에서 컨펌/재편집 입력
  8. FFmpeg 최종 렌더링
  9. 완료본 웹에서 다운로드
```

## 기존 모듈 재사용 (15개, 수정 0줄)

```
pg-pool / llm-router / llm-model-selector / llm-fallback / llm-logger
llm-keys / telegram-sender / n8n-runner / n8n-webhook-registry
heartbeat / kst / trace / tool-logger / rag / rag-safe
```

## 개발 원칙

```
1. 단계적 구현: 과제 단위로 구현, 한번에 전부 만들지 않음
2. 단위 테스트 필수: 각 과제 완료 시 단위 테스트 통과 후 다음 진행
3. 최종 테스트: Week 3에 통합 테스트(4 시나리오) + 품질 테스트 수행
4. 커밋 규칙: 과제 1개 완료 = 1 커밋 (테스트 포함)
5. 모든 개발 종료 시 문서 업데이트 + 커밋 + push까지 완료
```

## 에이전트 역할 경계

```
- Claude (대화형 기획/전략 문맥):
  - bots/video 폴더의 문서를 읽고 구조를 해석하는 역할
  - 구현 프롬프트 작성, 설계 검토, 작업 순서 정리에 집중
  - 코드 직접 수정 주체로 가정하지 않음

- 코덱(Codex) 또는 Claude Code:
  - 실제 파일 생성/수정, 테스트, 문서 업데이트, 커밋/푸시 수행
  - 구현이 끝난 뒤 반드시 문서 반영과 git 마감까지 함께 처리
```

## 현재 상태

```
현재 로컬 상태:
  - 핵심 문서 4개 + SESSION_HANDOFF_VIDEO.md + CLAUDE.md 배치 완료
  - scripts/ 폴더는 다른 bots와 동일한 공통 구조용 예약 상태
  - samples/ 폴더에 raw/narration/edited 테스트 fixture 존재
  - samples/ANALYSIS.md 에 ffprobe/YouTube 권장 분석 결과 정리 완료
  - video-team-design.md config 섹션은 YouTube 권장 렌더링 값(24M / 48kHz / 384k / faststart 등)으로 갱신 완료
  - video-team-tasks.md 과제 프롬프트는 하드코딩 값을 줄이고 config/CLAUDE.md 참조 기준으로 정리 완료
  - ANALYSIS.md 는 초기 분석값(섹션 6~7)과 최종 확정값(섹션 8)을 구분하도록 정리 완료
  - 과제 1 스캐폴딩 완료
    - config/video-config.yaml
    - migrations/001-video-schema.sql
    - context/IDENTITY.md
    - src/index.js
    - temp/, exports/ 디렉토리
  - `public.video_edits` 테이블 생성 및 `index.js` DB 연결 검증 완료
  - 과제 2 FFmpeg 전처리 완료
    - `lib/ffmpeg-preprocess.js`
    - `scripts/test-preprocess.js`
  - 샘플 `원본_파라미터.mp4` + `원본_나레이션_파라미터.m4a` 기준 실전 테스트 완료
    - removeAudio / normalizeAudio / syncVideoAudio / preprocess 통합 통과
    - 오디오 48kHz stereo AAC 리샘플링 확인
    - LUFS `-14.9` 확인 (목표 -14 ± 2)
  - 과제 3 Whisper STT 완료
    - `lib/whisper-client.js`
    - `scripts/test-whisper.js`
  - 샘플 `원본_나레이션_파라미터.m4a` 기준 실제 OpenAI Whisper 호출 검증 완료
    - `67 segments`
    - `temp/subtitle_raw.srt` 생성
    - 비용 `$0.026119`
    - `llm_usage_log` 기록 확인

Week 1: 핵심 파이프라인
  ✅ 과제 1: 프로젝트 스캐폴딩 + DB
  ✅ 과제 2: FFmpeg 전처리
  ✅ 과제 3: Whisper STT
  ☐ 과제 4: LLM 자막 교정
  ☐ 과제 5: CapCut 드래프트
  ☐ 과제 6: draft 파서 + FFmpeg 렌더링
  ☐ 과제 7: 엔드투엔드 통합

Week 2: 워커웹 + n8n + 품질 루프
  ☐ 과제 8: 워커 웹 대화형 영상 편집 페이지
  ☐ 과제 9: n8n 연동
  ☐ 과제 10~12: 품질 루프 (Critic/Refiner/Evaluator)
  ☐ 과제 13: 4세트 검증

Week 3: 최종 테스트 + 문서 체계 통합
  ☐ 통합 테스트 (4개 시나리오)
  ☐ 품질 테스트 (5세트 비교)
  ☐ 미달 항목 수정
  ☐ ★ 문서 이동: bots/video/docs/ → docs/video/
  ☐ ★ VIDEO_HANDOFF.md → docs/ 루트 승격
```

## 구현 세션 시작 순서 (코덱 / Claude Code 공통)

```
1. bots/video/docs/CLAUDE.md 읽기 (구현 규칙 + 렌더링 확정값)
2. bots/video/docs/VIDEO_HANDOFF.md 읽기 (전체 맥락 파악)
3. bots/video/docs/video-team-design.md 읽기 (모듈 매핑 + 기능목록)
4. bots/video/samples/ANALYSIS.md 읽기 (샘플 입출력 특성 확인)
5. bots/video/docs/video-team-tasks.md에서 현재 과제 프롬프트 실행
6. 과제 3 완료 → 단위 테스트 → 문서 업데이트 → 커밋/푸시 → 과제 4 순서대로 진행
7. 세션 마감 직전 VIDEO_HANDOFF.md / SESSION_HANDOFF_VIDEO.md / 전사 SESSION_HANDOFF.md 반영 여부를 다시 확인
```

## 더백클래스 LMS 연동 (Phase 2+)

```
더백클래스 (the100class.flutterflow.app)
  - "No.1 AI노코드 개발 강의" FlutterFlow LMS
  - 프로토타입에서는 연동하지 않음
  - Phase 2: LMS 영상 구조/메타데이터 학습
  - Phase 3: 편집 완료 → LMS 자동 발행 연동
  - 상세: video-team-design.md 섹션 8 참조
```
