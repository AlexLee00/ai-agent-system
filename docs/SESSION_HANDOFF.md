# 세션 핸드오프

> 다음 Claude Code 세션에서 이 파일을 먼저 읽어주세요.
> 단, 공통 규칙/팀별 진입점은 먼저 [docs/SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)를 확인한 뒤 이 문서를 읽는 것을 권장합니다.

## 이번 세션 완료 내역 (2026-03-11 ~ 2026-03-15)

### 1. KST 시간 유틸리티 중앙화
- `packages/core/lib/kst.js` 신규 — 전 팀 시간/날짜 관련 코드 통일
- 기존 `new Date().toISOString()` 직접 사용 코드 전수 교체
- launchd plist UTC 오기재 수정 (블로그팀 Hour=21 → KST 기준 Hour=6)
- CLAUDE.md에 kst.js 사용 규칙 + launchd 시간 규칙 공식 등재

### 2. KNOWN ISSUES 5개 수정
- `callOpenAIMini()` 최종 폴백 누락 → ✅ 수정 완료
- screening-monitor 파일 기반 → DB 기반으로 전환 → ✅ 수정 완료
- `star.js` XSS escapeHtml 미적용 → ✅ 수정 완료
- gemini maxTokens 4096 하드코딩 → 12000으로 수정 → ✅ 수정 완료
- loadPreScreenedFallback 파일→RAG 전환 → 보류 (루나 노드화 Phase에서 처리)

### 3. CLAUDE.md 공통 원칙 8개 추가
- 팀 제이 6대 원칙, 노드화 아키텍처, LLM 모델 라우팅, 소스코드 보안 규칙
- kst.js 사용 강제 규칙, launchd 시간 규칙
- 세션 시작/마무리 루틴, 개발 문서 목적표

### 4. 소스코드 접근 권한 제한
- `packages/core/lib/file-guard.js` 신규 — 봇의 소스코드 수정 물리적 차단
- 덱스터 `DEXTER_ALLOWED_PATTERNS` 화이트리스트 정의 (checksums, lock, state, log)
- autofix 범위 화이트리스트 외 수정 시도 → `reportInsteadOfFix()` 경고 발송

### 5. 루나팀 노드화 파이프라인 스캐폴딩 (L10~L34)
- debate 노드, decision 노드, risk 노드, execution 노드 골격 구현
- 루나 스크리닝 강화: 해외주식 + 암호화폐 휴리스틱 추가
- 매매일지 자동 리뷰 + 엑스커전(Excursion) 메트릭 + 리스크 연동
- 장외시간 리서치 모드 + 워치리스트 관리

### 6. 스카팀 예측 고도화
- 예측 캘리브레이션 (Platt Scaling)
- 피처스토어 (Feature Store) 구축
- 모멘텀 지표 연동

### 7. 워커팀 WebSocket 채팅 + 태스크 큐 + 승인 플로우
- WebSocket 기반 실시간 채팅 구현 (SSE 대체)
- 태스크 러너 (Task Runner) + 태스크 큐
- 승인 플로우 (Approval Flow) — 위험 작업 마스터 확인 체계
- 클로드코드 채팅 메시지 버블 병합 수정 완료 (tool 메시지 사이여도 마지막 streaming assistant 찾아서 병합)

### 8. 제이 인텐트 자동 프로모션 시스템
- 미인식 명령 → DB 누적 → 자동 승격 + 롤백 + 감사 추적
- 인텐트 스토어 공유 (전 팀 커맨더 연결)

### 9. 통합 OPS 헬스 대시보드
- 루나 리스크 + 스카 예측 + 클로드 품질 + 워커 상태 통합 뷰
- 팀별 개별 헬스 리포트: 루나/스카/클로드/워커/블로

### 10. 공유 헬퍼 리팩터링
- 헬스리포트 + 프로바이더 + 포맷터 42개 공통 함수 통합

### 11. 블로그팀 안정화
- plist Hour 수정 (UTC 21 → KST 6)
- 수동 발행: 38강 + 홈페이지와App 카테고리

---

## 미완료 / 보류 항목

### 🟡 groq-sdk 업그레이드 보류
- Breaking change 존재 → 사용자 확인 후 별도 세션에서 처리 필요

### 🟡 loadPreScreenedFallback 파일→RAG 전환
- 루나 노드화 Phase에서 처리 예정

### 🟡 LLM 속도 테스트 결과 반영 고려 (이월)
- 스카팀: llama-4-scout (464ms) → gpt-oss-20b (152ms) 교체 검토

---

## 현재 시스템 상태

### 전체 팀 가동 현황

| 팀 | 상태 | 비고 |
|----|------|------|
| 루나팀 | ✅ 정상 | 암호화폐 실투자, 노드화 파이프라인 L10~L34 스캐폴딩 완료 |
| 스카팀 | ✅ 정상 | 예측 캘리브레이션 + 피처스토어 완료 |
| 클로드팀 | ✅ 정상 | KNOWN ISSUES 4건 수정, file-guard.js 적용 |
| 워커팀 | ✅ 정상 | WebSocket 채팅 + 태스크 큐 + 승인 플로우 운영 중 |
| 블로그팀 | ✅ 정상 | plist KST 수정 완료, 매일 06:00 KST 자동 발행 |

---

## 다음 세션 할 일

1. **오류 해결 집중** — 누적 WARNING 이슈 정리
2. **워커웹 동적 렌더링** — Claude Code 응답 → 15종 UI 컴포넌트 자동 매칭
3. **외부 IP 접속** — Cloudflare Tunnel 설정 (로컬 IP 대체)
4. **groq-sdk Breaking change** 내용 확인 후 업그레이드 여부 결정
5. **스카팀 LLM 속도 최적화** — llama-4-scout → gpt-oss-20b 교체 검토
