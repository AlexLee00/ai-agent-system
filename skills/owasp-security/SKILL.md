---
name: owasp-security
description: API, MCP, 웹훅, secret, 인증/권한 변경을 OWASP 관점으로 검토할 때 사용.
---

# OWASP Security Review

## 목적

기능 구현 후 보안 검토를 별도 단계로 분리한다. 특히 MCP, Hub API, webhook, secret-store, 자동화 권한 변경에 적용한다.

## 절차

1. 자산 식별: secret, token, account, order/trade, webhook, admin route를 찾는다.
2. 신뢰 경계 확인: 외부 입력, MCP server, browser automation, API proxy를 분리한다.
3. OWASP 매핑: A01 권한, A02 암호화, A03 injection, A05 misconfig, A09 logging을 우선 본다.
4. 공격 경로 검증: source -> transform -> sink 흐름을 확인한다.
5. 수정/차단: fail-closed, redaction, allowlist, rate limit, audit log를 적용한다.

## 팀 제이 규칙

- secret 값을 출력하거나 커밋하지 않는다.
- Hub secret-store는 redacted 검증만 허용한다.
- MCP는 read-only와 write tool을 분리하고, 외부 MCP는 격리 실행을 우선한다.
- live trade, rollback, launchd 조작 권한은 보안 검토 없이 열지 않는다.

## 출력 형식

```text
Assets:
Trust boundaries:
Findings:
Attack path:
Fix:
Residual risk:
```
