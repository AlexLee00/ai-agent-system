# AI Feedback Confirmation Architecture

> 마지막 업데이트: 2026-03-16
> 범위: 워커 웹 우선, 이후 공용 플랫폼 확장

## 1. 목적

이 문서는 기존 AI-assisted 흐름에 `확인 창 기반 피드백 수집`을 공용 레이어로 적용하는 방향을 정의한다.

핵심 목표는 3가지다.

1. 사용자는 별도 피드백 화면 없이 평소처럼 자연어로 업무를 입력한다.
2. 시스템은 AI가 해석한 결과를 짧은 `확인 결과 창`으로 다시 보여준다.
3. 사용자의 `승인 / 수정 / 반려` 행동을 구조화된 feedback session/event로 저장한다.

즉, 이 레이어는 “피드백 설문”이 아니라 “일반 업무 확인 단계”를 데이터로 바꾸는 구조다.

---

## 2. 적용 배경

현재 저장소에는 이미 다음 기반이 있다.

- 워커 웹 입력/승인 흐름
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/ai/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/ai/page.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/approvals/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/approvals/page.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js)
- 워커 AI task proposal/approval 흐름
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/lib/chat-agent.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/chat-agent.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/lib/approval.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/approval.js)
- 공용 feedback layer
  - [/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-core.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-core.js)
  - [/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/ai-feedback-store.js)
  - [/Users/alexlee/projects/ai-agent-system/packages/core/scripts/feedback-report.js](/Users/alexlee/projects/ai-agent-system/packages/core/scripts/feedback-report.js)
- 운영 조회
  - [/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/feedback-health.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/feedback-health.js)

따라서 이 단계는 “새 피드백 시스템”을 만드는 것이 아니라, 이미 있는 AI 입력 흐름을 `확인 가능한 결과 창` 중심으로 재구성하는 작업이다.

---

## 3. 제품 개념

### 기본 흐름

`자연어 입력 → AI 해석 → 확인 결과 창 → 승인/수정/반려 → 최종 저장`

예시:

- 사용자 입력: `출근했어요`
- 시스템 해석: `2026-03-15 08:43 출근`
- 사용자 행동:
  - 그대로 승인
  - 시간/유형 수정 후 승인
  - 반려 후 재입력

이 흐름은 출근처럼 정형 업무일수록 강하게 동작한다.

### 설계 원칙

1. 피드백은 별도 UI가 아니라 결과 확인 창 안에서 수집한다.
2. 사용자 권한에 따라 보이는 메뉴와 LLM 자유도를 다르게 한다.
3. backend가 feedback session/event의 source of truth가 된다.
4. RAG는 feedback DB의 파생 인덱스로 붙인다.

---

## 4. 권한별 UX 모델

### 일반사용자

- 표시 UI
  - 메뉴 정책이 허용한 프롬프트 입력창
  - 본인 기록 조회
- 숨김 UI
  - 운영 알림
  - 전체 현황
  - 자유형 LLM 콘솔
- 기본 동작
  - 자연어 입력
  - AI가 결과 해석
  - 메뉴 내부 프롬프트 1개에서 제안 생성
  - 아래 `확인 및 승인 대기` 리스트에서 승인/수정/반려
  - 승인 또는 수정

예:
- `출근했어요`
- 결과 창: `3월 15일 08:43 출근`
- 사용자는 승인/수정만 수행

### 관리자 / 대표이사 / 담당자

- 표시 UI
  - 대시보드에서는 `프롬프트 입력창 + 운영 캔버스`
  - 정형 메뉴에서는 메뉴 내부 프롬프트 1개
  - 현황 위젯
  - 특정 주의/알림
- 선택 옵션
  - LLM 보조 ON/OFF
- 기본 동작
  - 일반사용자 흐름 유지
  - 추가로 집계/예외/현황 질의 가능

예:
- 출근 시간까지 남은 시간
- 아직 출근하지 않은 직원 목록
- 특정 요청 승인 대기 현황

### 마스터

- 표시 UI
  - 전체 메뉴
  - LLM 풀 기능
  - 운영/분석/예외 처리 콘솔
  - 대시보드 운영 프롬프트에서 팀장 봇 선택
- 기본 동작
  - 현재 제이/Jay 스타일의 자유형 LLM 오케스트레이션 유지
  - 대시보드에서는 운영 캔버스 사용
  - 정형 메뉴에서는 확인 결과 창/승인 리스트 유지
  - 일부 운영 질의는 바로 실행 가능

---

## 5. 권한 + LLM 모드

권한만으로 충분하지 않고, `LLM 사용 레벨`도 분리해야 한다.

### 제안 필드

- `ui_mode`
  - `prompt_only`
  - `prompt_plus_dashboard`
  - `full_master_console`
- `llm_mode`
  - `off`
  - `assist`
  - `full`
- `confirmation_mode`
  - `required`
  - `optional`

### 권장 기본값

- 일반사용자
  - `ui_mode=prompt_only`
  - `llm_mode=assist`
  - `confirmation_mode=required`
- 관리자/대표
  - `ui_mode=prompt_plus_dashboard`
  - `llm_mode=off|assist` 토글 가능
  - `confirmation_mode=required`
- 마스터
  - `ui_mode=full_master_console`
  - `llm_mode=full`
  - `confirmation_mode=optional`

### 대표이사 옵션형 LLM

대표이사/담당자 계정에는 `LLM 보조 ON/OFF`를 두는 것이 좋다.

- ON
  - 자연어 해석 강화
  - 요약/추천/예외 문장 처리 허용
- OFF
  - 정형 규칙 기반 확인창 중심

이렇게 하면 실제 운영에서 “어떤 업무는 LLM이 도움이 되는가”를 비교할 수 있다.

---

## 6. 확인 결과 창 설계

### 공통 구조

현재 워커 웹은 두 가지 패턴을 함께 쓴다.

- 대시보드
  - 프롬프트 입력 + 운영 캔버스
  - 최근 업무 큐
  - 운영 캔버스/최근 업무 큐 카드에서 바로 `프롬프트에 채우기`
- 정형 업무 메뉴
  - 메뉴 내부 프롬프트 1개
  - 데이터 리스트
  - 하단 `확인 및 승인 대기` 리스트
  - 승인 대기 카드에서 `프롬프트에 채우기`, `입력 위치로 이동`
  - 유사 확정 사례 카드에서 `이 사례로 다시 작성`

정형 업무 메뉴 기준 표시 요소:

- 해석된 업무 타입
- 핵심 필드
- 신뢰도 또는 해석 근거
- 승인 버튼
- 수정 버튼
- 취소/반려 버튼
- `프롬프트에 채우기`
- `입력 위치로 이동`
- `이 사례로 다시 작성`

### 정형 업무 예시

입력: `출근했어요`

결과 창:

- 업무: 출근 등록
- 일시: `2026-03-15 08:43`
- 사용자: `홍길동`
- 상태: `승인 대기`

처리 위치:

- 상단 입력창에서 제안 생성
- 하단 승인 리스트에서
  - `승인`
  - `시간 수정`
  - `취소`

### 수정 방식

1차 구현은 `inline edit`가 가장 적절하다.

- 시간
- 유형
- 사유
- 대상자

같은 top-level 필드만 수정 가능하게 한다.

이 수정이 그대로 `field_edited`로 저장된다.

### 현재 워커 UI 패턴 요약

- 대시보드
  - 운영 프롬프트
  - 운영 캔버스
  - 최근 업무 큐
  - 카드에서 바로 재질의 가능
  - 마스터/관리자는 카드 클릭 시 권장 봇까지 함께 선택 가능
- 승인 관리
  - 전체 inbox
  - 대기/승인/반려/전체 탭
  - 승인 항목에서 프롬프트 재질의 또는 관련 메뉴 이동 가능
- 정형 메뉴
  - 메뉴 내부 프롬프트 1개
  - 하단 `확인 및 승인 대기` 리스트
  - 유사 확정 사례
  - 승인 대기 카드와 유사 사례 카드 모두 프롬프트 흐름과 연결
- 마스터 관리 메뉴
  - 인텐트 학습, 업체 관리, 사용자 관리
  - 각 화면에서 `프롬프트에 채우기`와 관련 화면 이동이 가능한 빠른 액션 카드 제공

---

## 7. 현재 feedback layer와의 매핑

현재 공용 feedback 모델을 그대로 재사용할 수 있다.

### ai_feedback_sessions

권장 매핑:

- `source_type`
  - `worker_prompt`
  - `attendance_prompt`
  - `approval_prompt`
- `source_ref_type`
  - `attendance_record`
  - `agent_task`
  - `approval_request`
- `source_ref_id`
  - 최종 업무 row id
- `flow_code`
  - `attendance_checkin`
  - `attendance_checkout`
  - `leave_request`
  - `expense_request`
- `action_code`
  - 실제 업무 액션명
- `original_snapshot_json`
  - AI가 처음 해석한 결과
- `submitted_snapshot_json`
  - 사용자가 최종 승인한 결과

### ai_feedback_events

필수 이벤트:

- `proposal_generated`
- `field_edited`
- `field_added`
- `field_removed`
- `confirmed`
- `rejected`
- `submitted`
- `committed`

해석:

- 그대로 승인
  - `accepted_without_edit = true`
- 수정 후 승인
  - `field_edited` 존재
  - `accepted_without_edit = false`
- 반려
  - `rejected`

---

## 8. RAG 연동 방향

피드백 데이터는 RAG와 잘 맞지만, DB를 곧바로 검색원본으로 쓰면 안 된다.

### 권장 구조

`feedback DB → 정제 adapter → feedback_cases RAG`

### RAG에 넣을 조건

- `committed` 또는 `submitted` 완료 세션
- 민감값 sanitize 완료
- source context가 명확한 세션

### RAG 문서 예시

- `team=worker`
- `flow_code=attendance_checkin`
- `action_code=clock_in`
- `user_input=출근했어요`
- `original_result=2026-03-15 08:43 출근`
- `final_result=2026-03-15 08:45 출근`
- `edited_fields=["time"]`
- `accepted_without_edit=false`
- `status=committed`

### 기대 효과

- “이 문장을 과거에는 어떻게 확정했는가” retrieval 가능
- 자주 수정되는 패턴을 사례 기반으로 교정 가능
- 정형 업무에서 few-shot 품질 향상

---

## 9. 강화학습/정책 모델 관점

아이디어는 맞지만, 바로 RL 모델부터 붙이는 것보다 단계적으로 가는 편이 좋다.

### 권장 순서

1. 확인창 기반 피드백 수집 안정화
2. `accepted_without_edit`, `rejected`, `field_edited` 축적
3. RAG 기반 사례 검색 연결
4. 룰 + 랭커 + confidence scoring
5. 이후 필요 시 경량 정책 모델 또는 RLHF/RLAIF 검토

### 이유

- 출근/퇴근/휴가 같은 정형 업무는 우선 `RAG + 규칙 + 피드백 통계`만으로도 체감 성능이 크게 오른다.
- RL은 데이터가 충분히 쌓인 후 붙여야 의미가 있다.

---

## 10. 워커 기준 1차 도입 대상

가장 먼저 붙일 흐름은 워커 웹이다.

### 1차 대상 화면

- [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js)
- [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/schedules/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/schedules/page.js)
- [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/employees/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/employees/page.js)
- [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/payroll/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/payroll/page.js)
- [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/sales/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/sales/page.js)
- [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/projects/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/projects/page.js)
- [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/journals/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/journals/page.js)
- [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/approvals/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/approvals/page.js)

### 1차 업무

- 출근 / 퇴근
- 휴가 신청
- 일정 등록
- 직원 등록
- 급여 계산 요청
- 매출 등록
- 프로젝트 생성
- 업무일지 작성
- 간단한 승인 요청

### 1차 이유

- 정형 필드가 많다
- 결과 확인창과 잘 맞는다
- 수정 이벤트를 수집하기 쉽다
- 이미 approval/feedback layer가 연결되어 있다

---

## 11. 단계별 구현안

### Phase A

- attendance, leave, schedules, employees, payroll, sales, projects, journals에 `확인 결과 창` 연결
- 사용자가 승인 전 top-level field를 수정 가능하게 함
- 각 메뉴는 `메뉴 내부 프롬프트 1개 + 하단 승인 리스트` 구조로 정리
- 현재 `ai_feedback_sessions/events`와 `feedback_cases` RAG에 저장

### Phase B

- 역할별 메뉴 노출 분기
- 대표/담당자용 `LLM 보조 ON/OFF`
- `ui_mode`, `llm_mode`, `confirmation_mode` 설정 저장
- `menu_policy` 기반 페이지 접근/액션/공용 채팅 노출 제어

### Phase C

- feedback session → RAG artifact adapter 추가
- committed/submitted 세션만 feedback_cases로 저장

### Phase D

- flow별 승인율/수정률/반려율 자동 리포트
- accepted_without_edit 비율 기반 prompt 개선 loop

---

## 12. 운영 지표

이 구조가 붙으면 바로 추적할 수 있는 지표:

- `accepted_without_edit_rate`
- `rejected_rate`
- `field_edit_rate`
- `field_key_edit_frequency`
- `flow_code/action_code`별 승인율
- `llm_mode=off` vs `llm_mode=assist` 비교

대표 비교 예:

- 출근 업무에서
  - LLM OFF: 승인율 88%
  - LLM ASSIST: 승인율 96%

이런 식의 판단이 가능해진다.

---

## 13. 주의사항

### 제품 측면

- “몰래 감시”처럼 보이면 안 된다.
- UI 문구는 `품질 개선`, `업무 확인`, `처리 이력` 중심으로 표현한다.

### 데이터 측면

- 비밀번호, 토큰, 민감 개인정보는 feedback payload에 저장하지 않는다.
- backend가 source of truth를 유지한다.
- RAG는 파생 인덱스다.

### 기술 측면

- 일반사용자에게는 과한 자유형 LLM을 먼저 열지 않는다.
- 정형 업무부터 성공시키고 점진적으로 넓힌다.

---

## 14. 최종 판단

이 구조는 우리 시스템에 적합하다.

이유:

- 워커 웹에 바로 적용 가능하다.
- 현재 feedback layer를 그대로 재사용할 수 있다.
- 역할별 UI/권한/LLM 모드를 자연스럽게 묶을 수 있다.
- 정형 업무에는 RAG와 잘 맞는다.
- 나중에 정책 모델/강화학습으로 확장할 수 있다.

즉, 이건 단순 입력창 개편이 아니라

`권한 시스템 + 확인 UX + 피드백 수집 + RAG 학습 기반`

을 한 구조로 묶는 다음 단계의 플랫폼 설계다.

---

## 15. 다음 구현 추천

1. 대시보드용 운영 캔버스 고도화
2. 관리자 현황 위젯 강화
3. 마스터용 봇 대화 경험 심화
4. feedback analytics와 품질 리포트 자동화

이 순서가 지금 단계에서 가장 효과적이다.
