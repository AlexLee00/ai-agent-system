# GitHub Secret Exposure Runbook

이 문서는 GitHub에 키, 토큰, OAuth client secret 형태의 값이 올라가지 않도록 막고, 이미 이력에 들어간 흔적이 발견됐을 때의 안전한 처리 순서를 정의한다.

## 원칙

1. 현재 tree와 신규 커밋은 `bots/hub/scripts/secret-leak-smoke.ts`로 차단한다.
2. git history는 `scripts/security/secret-history-scan.ts`로 값 노출 없이 커밋/파일 단위만 확인한다.
3. 이력에 남은 credential 후보는 history rewrite보다 먼저 회전 또는 폐기한다.
4. `main` history rewrite와 force push는 배포/협업자 clone에 영향을 주므로 별도 승인 후 진행한다.
5. 스캔 로그, 이슈, 문서에는 원문 secret 값을 절대 붙이지 않는다.

## 현재 tree 검사

```bash
./node_modules/.bin/tsx bots/hub/scripts/secret-leak-smoke.ts
```

이 검사는 CI와 pre-commit에 연결되어 있다. 실패하면 출력은 redacted preview만 표시하고, 실제 값은 보여주지 않는다.

## Git history 검사

```bash
./node_modules/.bin/tsx scripts/security/secret-history-scan.ts
```

이 검사는 기본적으로 `main`과 `origin/main`을 대상으로 고신뢰 토큰 패턴이 들어가거나 제거된 커밋과 파일만 보여준다. 값 자체는 출력하지 않는다.

로컬 stale branch/tag까지 포함한 전체 ref 감사가 필요하면 다음처럼 실행한다.

```bash
SECRET_HISTORY_SCAN_ALL_REFS=1 ./node_modules/.bin/tsx scripts/security/secret-history-scan.ts
```

History rewrite 직후 로컬 clone이 어떤 stale ref를 붙잡고 있는지 확인하려면 다음 doctor를 실행한다. 이 명령은 읽기 전용이며 branch/tag를 삭제하지 않는다.

```bash
npm run -s security:post-rewrite-doctor
```

정리 명령을 직접 실행하기 전에, 다음 명령으로 삭제 계획만 생성한다. 이 명령도 읽기 전용이며 명령을 실행하지 않는다.

```bash
npm run -s security:stale-ref-plan
```

전체 ref 감사는 느릴 수 있으므로, 운영 검토가 길어질 때는 계획을 파일로 저장해 재사용한다.

```bash
npm run -s security:stale-ref-plan -- --output /tmp/stale-ref-plan.json
```

정리 실행은 별도 apply 스크립트를 사용한다. 기본값은 dry-run이며, 실제 삭제에는 `--apply`와 확인 env가 모두 필요하다. scope는 반드시 명시한다.

```bash
npm run -s security:stale-ref-cleanup -- --tags
SECURITY_STALE_REF_CLEANUP_CONFIRM=delete-stale-secret-refs npm run -s security:stale-ref-cleanup -- --apply --tags
```

저장된 계획을 사용하면 삭제 대상을 다시 스캔하지 않고 빠르게 dry-run 또는 apply를 반복 검토할 수 있다.

```bash
npm run -s security:stale-ref-cleanup -- --plan-file /tmp/stale-ref-plan.json --tags
SECURITY_STALE_REF_CLEANUP_CONFIRM=delete-stale-secret-refs npm run -s security:stale-ref-cleanup -- --plan-file /tmp/stale-ref-plan.json --apply --tags
```

저장된 계획에는 repo root, 현재 branch, `HEAD`, `origin/main` 메타데이터가 포함된다. cleanup은 기본적으로 이 값이 현재 checkout과 다르면 중단한다. 오래된 계획을 의도적으로 재사용해야 한다면 먼저 내용을 다시 검토한 뒤 `--allow-stale-plan`을 명시한다.

```bash
npm run -s security:stale-ref-cleanup -- --plan-file /tmp/stale-ref-plan.json --allow-stale-plan --tags
```

실제 `--apply`는 현재 checkout이 `main`이고 `HEAD == origin/main`일 때만 진행된다. plan이 맞더라도 로컬이 push 전 커밋이거나 다른 브랜치라면 dry-run만 허용하고 apply는 중단한다.

`--worktrees`는 기본적으로 locked worktree를 스킵한다. locked worktree까지 정리하려면 소유 에이전트를 먼저 정지하고 `--locked-worktrees`를 추가한다.

## 노출 후보 발견 시 처리 순서

1. 해당 provider 콘솔에서 credential을 즉시 revoke/rotate 한다.
2. 로컬 런타임 설정은 git 미추적 위치로 이동한다.
3. 현재 tree scanner가 통과하는지 확인한다.
4. history scanner 결과를 기준으로 rewrite 대상 파일/패턴을 확정한다.
5. `main` force push 영향 범위를 공지하고 배포/작업자를 일시 정지한다.
6. `git filter-repo` 또는 BFG로 history에서 값/파일을 제거한다.
7. `git push --force-with-lease origin main` 후 모든 clone은 fresh clone 또는 hard reset 절차를 따른다.
8. `security:post-rewrite-doctor`로 로컬 stale refs를 확인한다.
9. `security:stale-ref-plan -- --output <file>`으로 정리 명령 후보를 저장한다.
10. 필요한 scope만 `security:stale-ref-cleanup -- --plan-file <file>`로 dry-run 확인 후 apply한다.
11. locked worktree는 소유 에이전트를 먼저 정지한 뒤 별도 scope로 정리한다.
12. GitHub Actions/branch protection/배포 런타임을 다시 검증한다.

## History rewrite 주의

History rewrite는 일반 커밋과 다르게 원격 커밋 SHA를 바꾼다. 따라서 다음 조건을 만족할 때만 진행한다.

- 노출 후보 credential이 이미 revoke/rotate 됐다.
- 운영 배포가 일시 정지됐거나 rewrite 후 즉시 재동기화할 수 있다.
- 협업자 또는 자동화 runner가 기존 SHA 기반 작업을 중단했다.
- rewrite 전후 `secret-history-scan` 결과를 비교할 준비가 되어 있다.

## 미추적 런타임 저장소

다음 파일명은 `.gitignore`에 포함되어야 하며, 실제 credential은 여기에만 둔다.

- `secrets.json`
- `auth-profiles.json`
- `speed-test-keys.json`
- `token-store.json`
- `*.pem`
- `*.key`
- `*.p12`
- `*.pfx`
