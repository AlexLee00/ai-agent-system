
<!-- session-close:2026-03-02:재부팅-전-인수인계-클로드팀 -->
#### 2026-03-02 🔄 재부팅 전 인수인계 — 클로드팀 전체 현황

**✅ 이번 세션 완료 항목:**
- pre-reboot.sh / post-reboot.sh 신규 작성 (scripts/)
- ai.agent.post-reboot.plist launchd 등록 (RunAtLoad=true, 재부팅 후 자동 실행)
- README.md 전면 업데이트 (봇 현황 표, 루나팀 DEV 운영 반영, 구버전 섹션 삭제)
- improvement-ideas.md LU-030~038 완료 상태 반영, 우선순위 표 현행화
- 모든 팀 HANDOFF.md 재부팅 인수인계 항목 추가

**재부팅 후 복구 절차:**
- 덱스터 (ai.claude.dexter): StartInterval 1시간, 재부팅 후 다음 주기에 자동 실행
- 아처 (ai.claude.archer): 매주 월요일 09:00 KST, 재부팅 영향 없음
- post-reboot.sh: RunAtLoad=true → 재부팅 후 약 65초 내 텔레그램 상태 알림 자동 발송

**다음 세션 개발 우선순위 (재부팅 후):**
1. KIS 모의투자 실주문 테스트 (`dry_run: false` + 소액)
2. LU-039 ChromaDB 학습 루프 (장기 누적 학습, 맥미니 이전 후 본격화)
3. 맥미니 이전 체크리스트 확인: `memory/mac-mini-migration.md`
4. LU-025 OPS 전환 (바이낸스 API 키 등록 + 사용자 최종 승인) — 맨 마지막

**클로드팀 서비스 현황:**
- ai.claude.dexter: 1시간 주기 시스템 점검 (8개 모듈) → 재부팅 후 자동 재개
- ai.claude.dexter.daily: 08:00 KST 일일 보고 → 재부팅 후 자동 재개
- ai.claude.archer: 매주 월요일 09:00 KST → 재부팅 영향 없음

**핵심 파일 경로:**
- 재부팅 전: `bash scripts/pre-reboot.sh`
- 재부팅 후 확인: `tail -f /tmp/post-reboot.log`
- 덱스터 체크섬 갱신: `node bots/claude/src/dexter.js --update-checksums`
<!-- session-close:2026-03-02:재부팅-전-인수인계-클로드팀:end -->
