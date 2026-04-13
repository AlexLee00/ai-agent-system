# Ska Legacy Runtime Policy (2026-04-13)

## 목적

이 문서는 `bots/reservation`의 `.legacy.js`를 왜 유지하는지, 언제 줄일 수 있는지, 어떤 원칙으로 다뤄야 하는지 명확히 남기기 위한 정책 문서다.

현재 스카팀은 다음 상태다.

- `.ts` = source of truth
- `dist/ts-runtime/**/*.js` = 실제 운영 런타임 엔트리
- `.legacy.js` = source fallback + CommonJS 호환 레일

즉 `.legacy.js`는 더 이상 “실구현 본체”가 아니라, 운영 안정성과 호환성을 위한 마지막 레일이다.

## 현재 원칙

1. source 수정은 `.ts`만 한다.
2. 운영 실행 경로는 우선 `dist/ts-runtime/.../*.js`를 본다.
3. `.legacy.js`는 삭제 대상이 아니라 “호환 레일”로 본다.
4. `ts-fallback-loader.legacy.js`는 레일 자체이므로 마지막까지 유지 후보로 본다.

## `.legacy.js`를 유지하는 이유

### 1. source fallback

dist 산출물이 없거나 어긋난 상황에서, source 모드 실행이 완전히 끊기지 않게 해준다.

### 2. CommonJS 호환

일부 호출부나 오래된 실행 레일은 여전히 CommonJS 모듈 경로를 전제로 한다.
`.legacy.js`는 이 경로를 안전하게 흡수하는 완충층 역할을 한다.

### 3. 운영 회복성

빌드 산출물 문제, launchd 재기동, 수동 진단 같은 상황에서
“최소한의 fallback”이 남아 있으면 문제 격리가 훨씬 쉽다.

## 삭제를 검토할 수 있는 조건

아래 조건이 모두 충족될 때만 특정 `.legacy.js` 삭제를 검토한다.

1. 해당 파일을 직접 또는 간접 참조하는 current runtime 경로가 없다.
2. dist 런타임이 운영/수동/배치 경로에서 충분히 검증됐다.
3. cross-team import가 없다.
4. launchd, shell wrapper, package script, registry가 모두 dist 기준으로 고정됐다.
5. rollback 없이도 장애 대응이 가능하다는 운영 합의가 있다.

## 삭제 우선순위

1. low-risk utility/helper
2. read-only report helper
3. manual/admin helper
4. monitor/service helper
5. 마지막: `ts-fallback-loader.legacy.js`

## 수정 원칙

- `.legacy.js`는 가능하면 직접 수정하지 않는다.
- 예외는 fallback loader나 호환 레일 자체 결함을 고칠 때뿐이다.
- 기능 변경은 `.ts`에서 하고, `.legacy.js`는 경로/호환만 담당하게 유지한다.

## 운영자용 한 줄 요약

- 지금 실행은 `dist/ts-runtime/.../*.js`
- 지금 개발은 `.ts`
- 지금 남은 `.legacy.js`는 “삭제 안 한 찌꺼기”가 아니라 “의도적으로 남긴 호환 레일”
