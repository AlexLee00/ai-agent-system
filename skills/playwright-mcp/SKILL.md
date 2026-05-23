---
name: playwright-mcp
description: 브라우저 기반 확인, 게시물 레이아웃 검증, 대시보드 실시간 상태 확인을 Playwright/MCP 패턴으로 진행할 때 사용.
---

# Playwright MCP Verification

## 목적

API 결과만으로 판단하기 어려운 화면 상태를 브라우저에서 직접 확인한다. 게시물 레이아웃, 대시보드 최신화, 로그인 세션 기반 UI 확인에 사용한다.

## 절차

1. 목표 화면 정의: URL, 로그인 필요 여부, 확인할 DOM/텍스트/상태를 명시한다.
2. 안전 모드 선택: read-only 탐색과 write action을 분리한다.
3. 브라우저 확인: 화면 로드, 주요 영역, 네트워크 오류, 콘솔 오류를 확인한다.
4. 증거 저장: 스크린샷, DOM 텍스트, 실패 로그를 기록한다.
5. 수정 루프: UI/formatter/backend 문제를 분리해 고친다.

## 팀 제이 규칙

- Edu-X 테스트 게시 외 live 게시/삭제는 명시 승인 범위에서만 수행한다.
- Luna dashboard 확인은 read-only를 기본값으로 한다.
- secret 입력, 결제, 실거래 버튼 클릭은 금지한다.
- 화면 확인 결과와 API 상태가 다르면 둘 다 증거로 남긴다.

## 확인 포인트

- 레이아웃: 줄바꿈, 블록 간격, 제목, 모바일 가독성
- 데이터: stale timestamp, missing field, N/A 과다
- 운영: dashboard card별 health, websocket/API 연결 상태
- 게시: 등록 상태, 테스트 플래그, 삭제 가능 여부
