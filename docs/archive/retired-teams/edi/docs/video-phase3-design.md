# 비디오팀 Phase 3: AI 대화형 영상 편집기

> 설계일: 2026-03-22
> 작성: 메티 (claude.ai Opus) + 제이 (마스터)
> 상태: 설계 완료, 구현 대기

---

## 1. 비전

CapCut의 타임라인 UI + AI 스텝바이스텝 편집 + RED/BLUE 매 스텝 품질 검증 + 사용자 피드백 RAG 자기학습.
CapCut에 없는 "AI가 제안하고, 사람이 매 스텝 판단하고, 시스템이 학습하는" 새로운 카테고리.

핵심 차별점:
- CapCut: 사람이 전부 수동 → 품질은 좋지만 시간 소요
- 현재 Phase 2: AI가 일괄 처리 후 통째로 보여줌 → 빠르지만 품질 불안정
- Phase 3: AI가 스텝별 제안 → RED/BLUE 검증 → 사람이 핵심만 판단 → RAG 학습
  → "처음엔 좀 느리지만, 할수록 빨라지는" 시스템

## 2. 기술 스택

### 2-1. Twick React SDK (오픈소스)
- GitHub: ncounterspecialist/twick
- 패키지: @twick/video-editor, @twick/timeline, @twick/canvas, @twick/studio
- React + TypeScript (워커 웹 Next.js와 동일 스택)
- 멀티트랙 타임라인, 드래그앤드롭 트림/분할, AI 함수 훅 내장
- 라이선스: SUL (자체 앱 사용 무료, SaaS 재판매만 유료)

### 2-2. 기존 비디오팀 코드 (재사용)
- scene-indexer.js (581줄) — OCR 장면 인덱싱
- narration-analyzer.js (511줄) — 나레이션 구간 분석
- sync-matcher.js (463줄) — AI 싱크 매칭
- critic-agent.js (663줄) — RED팀 (매 스텝 품질 평가)
- refiner-agent.js (771줄) — BLUE팀 (매 스텝 대안 제시)
- evaluator-agent.js (298줄) — 최종 판정
- edl-builder.js (971줄) — EDL 생성 + FFmpeg 렌더링
- video-rag.js (486줄) — RAG 피드백 루프

### 2-3. 워커팀 피드백 시스템 (재사용, 893줄)
- packages/core/lib/ai-feedback-core.js (146줄) — 필드 diff, 이벤트 타입
- packages/core/lib/ai-feedback-store.js (291줄) — sessions + events DB
- packages/core/lib/feedback-rag.js (179줄) — RAG 게시 + 유사 사례 검색
- bots/worker/lib/ai-feedback-service.js (249줄) — 워커 비즈니스 로직
→ 동일 패턴으로 video-feedback-service.js 생성 (schema='video')

### 2-4. 추가 라이브러리
- wavesurfer.js — 오디오 파형 표시 (타임라인 보조)
- WebSocket — 실시간 스텝 제안 ↔ 사용자 응답

## 3. 아키텍처

### 3-1. 한 스텝의 생명주기

```
AI 제안 → RED 평가 → BLUE 대안 → 사용자 판단 → RAG 축적
```

1. step-proposal-engine이 편집 스텝 생성
   예: { type: "cut", from: 30, to: 90, reason: "무음 구간", confidence: 0.72 }

2. critic-agent (RED)가 평가
   예: "30초 시작은 FlutterFlow 인트로라 남기는 게 나음" (score: 45)

3. refiner-agent (BLUE)가 대안 제시
   예: { type: "cut", from: 45, to: 90 } (score: 78)

4. 사용자가 판단
   - 컨펌 (AI 제안 그대로)
   - 수정 (직접 타임라인에서 조정)
   - 건너뛰기 (이 스텝 무시)
   - BLUE 대안 채택

5. ai-feedback-store에 기록
   - original_snapshot: AI 제안
   - submitted_snapshot: 최종 결정
   - buildFieldDiffEvents(): 필드별 diff 자동 계산
   - accepted_without_edit: 수정 없이 승인했는지 자동 판별

6. feedback-rag에 축적
   - "무음 구간 삭제 시, FlutterFlow 인트로(0~45초)는 보통 유지"
   - 다음 영상에서 AI가 45초부터 자르도록 학습

### 3-2. 자동/수동 모드

confidence 기반 자동 분류:
- confidence ≥ 0.8: 자동 컨펌 (사람에게 안 물어봄)
- 0.5 ≤ confidence < 0.8: 사람에게 제안 (기본)
- confidence < 0.5: RED 경고 + BLUE 대안 필수 표시

자동화율 변화 (accepted_without_edit 비율로 측정):
- 1~5번째 영상: 자동 20%, 수동 80%
- 6~15번째: 자동 60%, 수동 40%
- 16~30번째: 자동 85%, 수동 15%
- 30번째 이후: 자동 95%, 핵심만 컨펌

### 3-3. UI 구조

```
┌─────────────────────────────────────────────────────┐
│ 워커 웹 /video (Next.js)                             │
├─────────────┬───────────────────────────────────────┤
│             │  @twick/video-editor                   │
│  AI 채팅    │  ┌─────────────────────────────────┐   │
│  패널       │  │     프리뷰 캔버스               │   │
│             │  │     (@twick/canvas)              │   │
│  스텝 제안  │  └─────────────────────────────────┘   │
│  RED 평가   │  ┌─────────────────────────────────┐   │
│  BLUE 대안  │  │     멀티트랙 타임라인            │   │
│             │  │     (@twick/timeline)            │   │
│  컨펌/수정  │  │     비디오 | 오디오 | 자막       │   │
│  버튼       │  └─────────────────────────────────┘   │
├─────────────┴───────────────────────────────────────┤
│  스텝 진행 바: ● ● ● ○ ○ ○ ○ ○ (3/8 완료)          │
└─────────────────────────────────────────────────────┘
```

좌측: AI 채팅 패널 (스텝 제안 + RED/BLUE + 사용자 입력)
우측: Twick 편집기 (프리뷰 + 타임라인)
하단: 스텝 진행 바 (전체 진행 상황)

### 3-4. 파이프라인 흐름 (Phase 3)

```
입력: 원본 영상(무음) + 나레이션 + (인트로/아웃트로)

Phase 2 자동 처리 (변경 없음):
  1. normalizeAudio
  2. STT + 자막 교정
  3. indexVideo (OCR 장면 인덱싱)
  4. analyzeNarration (나레이션 구간 분석)
  5. buildSyncMap (AI 싱크 매칭)
  6. processIntroOutro

Phase 3 대화형 편집 (신규):
  7. generateSteps (sync_map → 편집 스텝 목록 생성)
  8. for each step:
     a. AI 제안 표시 (타임라인에 마커)
     b. RED 평가 (critic-agent)
     c. BLUE 대안 (refiner-agent)
     d. 사용자 판단 (컨펌/수정/건너뛰기)
     e. feedback 기록 + RAG 축적
  9. confirmedSteps → EDL 조립
  10. 프리뷰 렌더링 (720p)
  11. 최종 컨펌 → final 렌더링 (1440p/24Mbps)
```

## 4. 신규 파일 목록

### 4-1. 비디오팀 (bots/video/lib/)
| 파일 | 줄 수(예상) | 설명 |
|------|------------|------|
| step-proposal-engine.js | ~300 | sync_map → 편집 스텝 분리, confidence 계산, RED/BLUE 연결 |
| video-feedback-service.js | ~200 | ai-feedback-service.js 패턴, schema='video' |

### 4-2. 워커 웹 (bots/worker/web/)
| 파일 | 줄 수(예상) | 설명 |
|------|------------|------|
| app/video/editor/page.js | ~800 | Twick 타임라인 + AI 채팅 패널 + 스텝 진행 UI |
| routes/video-step-api.js | ~300 | 스텝 제안/컨펌/수정/건너뛰기 API |
| components/StepPanel.jsx | ~200 | AI 제안 + RED/BLUE 카드 컴포넌트 |
| components/TimelineEditor.jsx | ~300 | Twick 래퍼 + EDL 동기화 |

### 4-3. 설정/마이그레이션
| 파일 | 설명 |
|------|------|
| video-config.yaml | step_proposal 섹션 추가 |
| migrations/006-feedback-sessions.sql | video 스키마 ai_feedback_sessions 테이블 |

## 5. DB 스키마

video 스키마에 ai_feedback_sessions + ai_feedback_events 테이블 생성.
기존 packages/core/lib/ai-feedback-store.js의 ensureAiFeedbackTables()를
schema='video'로 호출하면 자동 생성.

추가 컬럼 (video_edit_steps):
```sql
CREATE TABLE IF NOT EXISTS video_edit_steps (
  id            BIGSERIAL PRIMARY KEY,
  session_id    INTEGER REFERENCES video_sessions(id),
  edit_id       INTEGER REFERENCES video_edits(id),
  step_index    INTEGER NOT NULL,
  step_type     TEXT NOT NULL,  -- 'cut', 'transition', 'speed', 'text_overlay', 'sync_match'
  proposal_json JSONB NOT NULL, -- AI 원본 제안
  red_score     INTEGER,        -- RED팀 점수 (0-100)
  red_comment   TEXT,           -- RED팀 코멘트
  blue_json     JSONB,          -- BLUE팀 대안
  user_action   TEXT,           -- 'confirm', 'modify', 'skip', 'adopt_blue'
  final_json    JSONB,          -- 최종 결정
  feedback_session_id BIGINT REFERENCES video.ai_feedback_sessions(id),
  confidence    REAL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

## 6. Phase 3 과제 목록

| 과제 | 내용 | 의존 | 예상 줄 수 |
|------|------|------|-----------|
| F | step-proposal-engine.js | Phase 2 sync_map | ~300 |
| G | video-feedback-service.js | ai-feedback-store | ~200 |
| H | Twick 통합 + 타임라인 UI | @twick/video-editor | ~800 |
| I | AI 채팅 패널 + 스텝 API | WebSocket | ~500 |
| J | RED/BLUE 스텝별 연결 | critic/refiner | ~200 |
| K | EDL 조립 + 렌더링 연결 | edl-builder | ~200 |
| L | 5세트 검증 + 자동화율 측정 | 과제 F~K | ~300 |

총 신규 코드: ~2,500줄
재사용 코드: ~5,000줄 (기존 비디오 + 피드백 시스템)

## 7. 핵심 KPI

- accepted_without_edit 비율: AI 제안이 수정 없이 승인된 비율
  → 이 숫자가 올라갈수록 AI가 사람 취향을 학습한 것
  → 목표: 30번째 영상에서 95% 이상

- 편집 소요 시간: 제이의 현재 수동 편집 시간(60~70%) 대비 절감률
  → 목표: Phase 3 안정화 후 80% 절감

- 세트당 비용: LLM API 호출 비용
  → Phase 2: $0.05~0.06/세트
  → Phase 3: 스텝당 RED+BLUE $0.0002 × 20스텝 = +$0.004
  → 총 $0.06/세트 (거의 변화 없음)

## 8. Phase 2 → Phase 3 전환 전략

Phase 2 파이프라인은 유지하면서 Phase 3를 추가하는 방식.
사용자가 /video에서 "자동 모드" 또는 "대화형 모드"를 선택.

- 자동 모드: Phase 2 그대로 (일괄 처리 → 프리뷰)
- 대화형 모드: Phase 2 + Phase 3 (일괄 처리 → 스텝별 검증 → 프리뷰)

Phase 3 안정화 후 대화형 모드를 기본값으로 전환.

## 9. 전수 코드 리뷰 발견사항 반영

Phase 2에서 발견된 P0 이슈 5건을 Phase 3에서 함께 해결:

1. ★ 품질 루프 재통합 → Phase 3에서 매 스텝마다 RED/BLUE 작동으로 해결
2. 오프라인 fixture 의존도 → Phase 3에서 STT 실패 시 "재시도" 상태로 처리
3. 인트로 오디오 누락 → Mode A(파일)에서 -an 제거
4. EDL "synced.mp4" → Phase 2 문서 보완에서 수정 (Part 1)
5. 워커 웹 빌드 → Phase 3 Twick 통합 시 전체 재빌드

## 10. Twick 설치 및 통합 가이드

```bash
cd /Users/alexlee/projects/ai-agent-system/bots/worker/web
npm install @twick/video-editor @twick/timeline @twick/canvas @twick/live-player
```

기본 통합 코드:
```jsx
import { VideoEditor } from '@twick/video-editor';
import { LivePlayerProvider } from '@twick/live-player';
import { TimelineProvider } from '@twick/timeline';

function VideoEditorPage() {
  return (
    <LivePlayerProvider>
      <TimelineProvider initialData={{ timeline: [], version: 0 }}>
        <div style={{ display: 'flex' }}>
          {/* 좌측: AI 채팅 패널 */}
          <StepPanel steps={steps} onConfirm={handleConfirm} />
          {/* 우측: Twick 에디터 */}
          <VideoEditor
            editorConfig={{
              videoProps: { width: 1920, height: 1080 },
            }}
          />
        </div>
      </TimelineProvider>
    </LivePlayerProvider>
  );
}
```
