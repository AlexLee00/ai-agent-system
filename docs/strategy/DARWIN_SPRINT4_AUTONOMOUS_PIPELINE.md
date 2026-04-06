# 다윈팀 Sprint 4 — 자율 연구→구현→검증 파이프라인

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-06
> 전제: Sprint 1~3 완료 (자율 발견→학습→적용 제안)
> 목표: 마스터 승인 → 자동 구현 → 자동 검증 → 완전 자율 전환!

---

## 1. 현재 vs 목표

```
Sprint 3 (현재):
  Scanner → Evaluator → Applicator(graft+edison+proof-r)
  → 텔레그램 알림 → ★멈춤★ → 제이가 수동 구현

Sprint 4 (목표):
  Phase A: 텔레그램 승인 버튼
  Phase B: 승인 → edison 자동 구현 → 브랜치 커밋
  Phase C: proof-r 자동 검증 + 코덱스/메티 최종 검증
  Phase D: 검증 데이터 학습 → 완전 자율 전환
```

---

## 2. Phase A: 텔레그램 승인 버튼

### 현재 알림 형태
```
🔬 다윈팀 적용 제안 ✅
[논문 제목]
[적용 방안 600자]
[검증 결과]
```

### 변경: 인라인 키보드 추가
```javascript
// applicator.js 수정
const alarmResult = await postAlarm({
  message: message.slice(0, 4000),
  team: 'darwin',
  alertLevel: 2,
  fromBot: 'applicator',
  // 신규: 인라인 키보드!
  inlineKeyboard: [
    [
      { text: '✅ 승인 — 구현 시작', callback_data: `darwin_approve:${proposalId}` },
      { text: '❌ 거절', callback_data: `darwin_reject:${proposalId}` },
    ],
    [
      { text: '📝 수정 후 승인', callback_data: `darwin_modify:${proposalId}` },
    ]
  ]
});
```

### Hub 콜백 처리
```javascript
// Hub에 텔레그램 콜백 엔드포인트 추가
// POST /hub/darwin/callback
async function handleDarwinCallback(callbackData) {
  const [action, proposalId] = callbackData.split(':');
  
  if (action === 'darwin_approve') {
    // proposal status 변경
    await updateProposalStatus(proposalId, 'approved');
    // 텔레그램 메시지 업데이트 (버튼 → "✅ 승인됨")
    await answerCallback('승인 완료! edison이 구현을 시작합니다...');
    // Phase B 트리거!
    await triggerImplementation(proposalId);
  }
  
  if (action === 'darwin_reject') {
    await updateProposalStatus(proposalId, 'rejected');
    await answerCallback('거절됨');
  }
}
```

---

## 3. Phase B: edison 자동 구현 → 브랜치 커밋

### 핵심: edison = claude-code/sonnet (OAuth!) = 충분한 코딩 능력!

```javascript
// bots/orchestrator/lib/research/implementor.js (신규!)

async function triggerImplementation(proposalId) {
  const proposal = loadProposal(proposalId);
  
  // 1. 구현 브랜치 생성
  const branchName = `darwin/${proposalId}`;
  execSync(`git checkout -b ${branchName}`, { cwd: REPO_ROOT });
  
  // 2. edison에게 구현 지시
  //    LLM: claude-code/sonnet (OAuth) = 코딩 능력 충분!
  const implementationResult = await callWithFallback({
    systemPrompt: `당신은 팀 제이의 프로토타입 개발자(edison)입니다.
다음 연구 제안을 실제 코드로 구현하세요.

팀 제이 코딩 규칙:
- Node.js 모노레포, CommonJS require
- packages/core/lib/ 에 공용 모듈
- 기존 패턴 따르기 (pg-pool, llm-fallback 등)
- JSDoc 주석
- 에러 핸들링 필수`,
    userPrompt: `
## 논문: ${proposal.paper.title}
## 적용 방안:
${proposal.proposal}
## 프로토타입 코드:
${proposal.prototype}
## 검증 결과:
${JSON.stringify(proposal.verification)}

위 프로토타입을 실제 코드베이스에 통합하세요.
1. 필요한 파일 생성/수정
2. 기존 코드와의 통합 포인트 명시
3. node --check 통과하는 코드 작성
`,
    chain: [
      { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4000 },
      { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 4000 },
    ],
    logMeta: { team: 'darwin', bot: 'edison', requestType: 'auto_implementation' },
  });
  
  // 3. edison 출력에서 코드 블록 추출 → 파일 생성
  const files = extractCodeBlocks(implementationResult);
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content, 'utf8');
  }
  
  // 4. 문법 검증 (node --check)
  const syntaxOk = files.every(f => {
    try {
      execSync(`node --check ${f.path}`, { encoding: 'utf8' });
      return true;
    } catch { return false; }
  });
  
  // 5. 브랜치에 커밋
  execSync(`git add -A && git commit -m "feat(darwin): auto-implement ${proposalId}

논문: ${proposal.paper.title}
구현: edison (claude-code/sonnet)
문법검증: ${syntaxOk ? '통과' : '실패'}
상태: pending_review"`, { cwd: REPO_ROOT });
  
  // 6. 텔레그램 알림
  await postAlarm({
    message: `🔧 edison 자동 구현 완료!\n` +
      `📋 ${proposal.paper.title}\n` +
      `🌿 브랜치: ${branchName}\n` +
      `📂 파일 ${files.length}개 생성\n` +
      `✅ 문법 검증: ${syntaxOk ? '통과' : '❌ 실패'}\n` +
      `→ proof-r 검증 시작...`,
    team: 'darwin',
    fromBot: 'edison',
  });
  
  // 7. 메인 브랜치로 복귀
  execSync('git checkout main', { cwd: REPO_ROOT });
  
  // 8. Phase C 트리거 — 자동 검증!
  await triggerVerification(proposalId, branchName);
}
```

---

## 4. Phase C: proof-r 자동 검증 + 코덱스/메티 최종 검증

```javascript
// bots/orchestrator/lib/research/verifier.js (신규!)

async function triggerVerification(proposalId, branchName) {
  // 1. proof-r 자동 검증 (LLM: openai-oauth/gpt-5.4)
  execSync(`git checkout ${branchName}`, { cwd: REPO_ROOT });
  
  const changedFiles = execSync('git diff --name-only main', { encoding: 'utf8' }).trim().split('\n');
  const fileContents = changedFiles.map(f => ({
    path: f,
    content: fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'),
  }));
  
  const verificationResult = await callWithFallback({
    systemPrompt: `당신은 팀 제이의 연구 검증자(proof-r)입니다.
다윈팀 edison이 자동 구현한 코드를 검증합니다.

검증 항목:
1. 문법 정확성 (node --check 통과?)
2. 기존 코드와 충돌 여부
3. 보안 문제 (하드코딩 시크릿, 위험한 패턴)
4. 성능 우려 (무한 루프, 메모리 누수)
5. 코딩 스타일 준수 (팀 제이 패턴)
6. 테스트 가능성

결과: PASS / FAIL / NEEDS_REVIEW
FAIL 사유와 수정 제안을 포함하세요.`,
    userPrompt: `검증 대상 파일:\n${fileContents.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n')}`,
    chain: [
      { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2000 },
      { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 2000 },
    ],
    logMeta: { team: 'darwin', bot: 'proof-r', requestType: 'auto_verification' },
  });
  
  // 2. 검증 결과 파싱
  const passed = /PASS/i.test(verificationResult);
  
  // 3. 검증 결과 → proposal에 기록
  updateProposalStatus(proposalId, passed ? 'verified' : 'verification_failed', {
    verification: verificationResult,
    branch: branchName,
    files: changedFiles,
  });
  
  // 4. 텔레그램 최종 알림 (마스터에게!)
  await postAlarm({
    message: passed
      ? `✅ proof-r 검증 통과!\n🌿 ${branchName}\n` +
        `→ 코덱스/메티 최종 검증 후 머지하세요!\n` +
        `→ git checkout ${branchName} && git diff main`
      : `❌ proof-r 검증 실패!\n🌿 ${branchName}\n` +
        `사유: ${verificationResult.slice(0, 500)}\n` +
        `→ 수동 검토 필요`,
    team: 'darwin',
    fromBot: 'proof-r',
    inlineKeyboard: passed ? [
      [
        { text: '✅ 머지 승인', callback_data: `darwin_merge:${proposalId}` },
        { text: '📝 수동 검토', callback_data: `darwin_manual:${proposalId}` },
      ]
    ] : null,
  });
  
  execSync('git checkout main', { cwd: REPO_ROOT });
  
  // 5. 검증 데이터 → experience_record에 저장 (학습용!)
  await storeExperience({
    intent: `다윈 자동 구현: ${proposalId}`,
    response: verificationResult,
    result: passed ? 'success' : 'failure',
    reason: passed ? 'proof-r 검증 통과' : 'proof-r 검증 실패',
    howToApply: passed
      ? 'edison 구현 패턴 재사용 가능'
      : `실패 원인 학습: ${verificationResult.slice(0, 200)}`,
  });
}
```

### 머지 처리
```javascript
// 마스터가 "머지 승인" 버튼 클릭 시
async function handleMerge(proposalId) {
  const proposal = loadProposal(proposalId);
  const branchName = `darwin/${proposalId}`;
  
  execSync(`git checkout main && git merge ${branchName} --no-ff -m "feat(darwin): merge auto-implementation ${proposalId}"`, { cwd: REPO_ROOT });
  execSync(`git branch -d ${branchName}`, { cwd: REPO_ROOT });
  
  updateProposalStatus(proposalId, 'merged');
  
  await postAlarm({
    message: `🎉 다윈 자동 구현 머지 완료!\n📋 ${proposal.paper.title}`,
    team: 'darwin', fromBot: 'darwin',
  });
}
```

---

## 5. Phase D: 검증 데이터 학습 → 완전 자율 전환

```
Phase D 핵심 아이디어:

  Phase A~C 반복 → 검증 데이터 축적!
  
  시그마팀이 분석:
    "edison이 구현한 N건 중 proof-r 통과율?"
    "실패 패턴은? 성공 패턴은?"
    "어떤 유형의 논문이 구현 성공률 높은가?"
    
  데이터 충분 시 (예: 통과율 >80%, 20건+):
    → 자율 레벨 업그레이드!

  Level 3 (현재): 마스터 승인 필요
    Scanner → Evaluator → Applicator → [마스터 승인] → edison → proof-r → [마스터 머지]
    
  Level 4 (자동 구현): 승인만 필요
    Scanner → Evaluator → Applicator → [마스터 승인] → edison → proof-r → 자동 머지!
    (proof-r 통과 시 자동 머지, 실패 시만 마스터 알림)
    
  Level 5 (완전 자율): 승인 불필요!
    Scanner → Evaluator → Applicator → edison → proof-r → 자동 머지!
    마스터는 주간 리포트만 확인!
    단, 위험도 높은 변경(core 모듈, DB 스키마)은 여전히 승인 필요

  자율 레벨 조건:
    Level 3→4: proof-r 통과율 80%+ (20건+ 데이터)
    Level 4→5: proof-r 통과율 95%+ (50건+ 데이터) + 머지 후 무장애 30일+
    Level 5→4 (강등): 머지 후 에러 발생 시 즉시 강등!
```

```
안전장치:

① DEV에서만 구현! OPS 직접 변경 절대 금지!
② edison 구현은 반드시 별도 브랜치! main 직접 커밋 금지!
③ proof-r 검증 필수! 검증 없는 머지 금지!
④ core 모듈(packages/core) 변경은 Level 5에서도 마스터 승인!
⑤ DB 스키마(ALTER TABLE 등) 변경은 항상 마스터 승인!
⑥ 3역할 유지: graft(설계) + edison(구현) + proof-r(검증)
   = 메티(설계) + 코덱스(구현) + 마스터(승인) 패턴과 동일!
```

---

## 6. 전체 파이프라인 다이어그램

```
┌──────────────────────────────────────────────────────┐
│  Sprint 1~3 (자동)                                   │
│                                                      │
│  06:00 Scanner (9명 searcher)                        │
│    → arXiv/HuggingFace 스캔                          │
│    → Evaluator 평가/필터                              │
│    → graft 적용 제안 생성                             │
│    → edison 프로토타입 생성                           │
│    → proof-r 초기 검증                               │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────┐
│  Sprint 4 Phase A — 텔레그램 승인                    │
│                                                      │
│  📱 텔레그램 알림 + [✅ 승인] [❌ 거절]              │
│  마스터가 ✅ 클릭!                                   │
│  (단 한 번의 터치!)                                  │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────┐
│  Sprint 4 Phase B — edison 자동 구현                 │
│                                                      │
│  edison (claude-code/sonnet OAuth)                   │
│    → 프로토타입 → 실제 코드 변환                     │
│    → git checkout -b darwin/{id}                     │
│    → 파일 생성 + node --check                        │
│    → git commit + push                               │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────┐
│  Sprint 4 Phase C — proof-r 자동 검증                │
│                                                      │
│  proof-r (openai-oauth/gpt-5.4)                      │
│    → 문법/충돌/보안/성능/스타일 검증                  │
│    → PASS: 텔레그램 [✅ 머지] 버튼                   │
│    → FAIL: 수동 검토 알림                            │
│    → 검증 데이터 → experience_record 저장!           │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────┐
│  Sprint 4 Phase D — 학습 → 완전 자율!                │
│                                                      │
│  시그마팀 분석:                                      │
│    통과율 / 실패 패턴 / 성공 패턴                    │
│                                                      │
│  Level 3: [마스터 승인] → 구현 → 검증 → [마스터 머지]│
│  Level 4: [마스터 승인] → 구현 → 검증 → 자동 머지!   │
│  Level 5: 구현 → 검증 → 자동 머지! (완전 자율!)     │
└──────────────────────────────────────────────────────┘
```

---

## 7. 구현 우선순위

```
Phase A (이번 달): 텔레그램 인라인 키보드 + Hub 콜백
  난이도: ★★☆
  의존성: postAlarm 인라인 키보드 지원 추가
  파일: openclaw-client.js + Hub 콜백 엔드포인트

Phase B (이번 달~다음 달): edison 자동 구현
  난이도: ★★★
  의존성: Phase A
  파일: implementor.js (신규) + proposal-store 확장

Phase C (다음 달): proof-r 자동 검증
  난이도: ★★☆
  의존성: Phase B
  파일: verifier.js (신규)

Phase D (분기): 자율 레벨 시스템
  난이도: ★★★
  의존성: Phase C + 20건+ 데이터
  파일: 시그마팀 분석 연동
```


---

## 8. Phase D 심화 — 자율 전환 프레임워크 (핵심!)

> "다윈팀의 자율 전환이 구조화되면, 모든 팀에 적용 가능한
>  완전 자율 에이전트 시스템의 원형이 된다!"

### 8-1. 왜 Phase D가 가장 중요한가

```
Phase A~C = 파이프라인 자동화 (도구)
Phase D = 자율 판단 학습 (지능!)

Phase A~C 없이도 수동으로 할 수 있다.
Phase D가 있어야 비로소 "자율 에이전트"!

Phase D 핵심 질문:
  "edison이 구현한 코드를, 언제 믿을 수 있는가?"
  "proof-r의 검증을, 언제 마스터 없이 신뢰할 수 있는가?"
  → 데이터로 증명해야 한다!
```

### 8-2. 검증 데이터 수집 구조

```javascript
// 모든 자동 구현+검증마다 기록되는 데이터:
{
  // 제안 정보
  proposal_id: 'arxiv_2406_12345',
  paper_title: 'Adaptive ε-Greedy for Multi-Agent Selection',
  domain: 'AI/멀티에이전트',       // 어떤 도메인?
  target_team: 'luna',              // 어떤 팀에 적용?
  complexity: 'medium',             // 복잡도 (graft 판단)

  // 구현 정보
  implementor: 'edison',
  llm_model: 'claude-code/sonnet',
  files_created: 3,
  lines_added: 142,
  implementation_time_ms: 45000,
  syntax_check_passed: true,

  // 검증 정보
  verifier: 'proof-r',
  verification_result: 'PASS',      // PASS / FAIL / NEEDS_REVIEW
  verification_items: {
    syntax: true,
    conflict: true,
    security: true,
    performance: true,
    style: true,
  },
  failure_reason: null,              // FAIL 시 원인

  // 최종 결과
  master_decision: 'merge',         // merge / reject / modify
  post_merge_errors: 0,             // 머지 후 에러 수!
  post_merge_days_stable: 14,       // 머지 후 안정 일수

  // 메타
  created_at: '2026-04-10T06:00:00Z',
  level_at_time: 3,                 // 당시 자율 레벨
}
```

### 8-3. 자율 전환 판단 알고리즘

```javascript
// bots/orchestrator/lib/research/autonomy-level.js (신규!)

function evaluateAutonomyLevel(stats) {
  const current = stats.currentLevel;

  // === Level 3 → 4 승격 조건 ===
  // "마스터 머지 불필요" = proof-r을 신뢰할 수 있는가?
  if (current === 3) {
    const conditions = {
      // 최소 데이터: 20건 이상 검증 완료
      enoughData: stats.totalVerified >= 20,
      // proof-r 통과율 80% 이상
      highPassRate: stats.passRate >= 0.80,
      // 마스터가 proof-r PASS를 reject한 적 없음 (최근 10건)
      masterAgreement: stats.recentMasterOverrides === 0,
      // 머지 후 에러 0건 (최근 10건)
      noPostMergeErrors: stats.recentPostMergeErrors === 0,
    };
    
    if (Object.values(conditions).every(Boolean)) {
      return { recommend: 4, reason: 'Level 4 승격 조건 충족', conditions };
    }
  }

  // === Level 4 → 5 승격 조건 ===
  // "마스터 승인 불필요" = 다윈팀이 스스로 판단할 수 있는가?
  if (current === 4) {
    const conditions = {
      // 50건 이상 자동 머지 완료
      enoughAutoMerge: stats.totalAutoMerged >= 50,
      // proof-r 통과율 95% 이상
      veryHighPassRate: stats.passRate >= 0.95,
      // 자동 머지 후 30일+ 무장애
      stableDays: stats.daysSinceLastError >= 30,
      // 제안 품질: graft 제안 중 실제 적용 비율 70%+
      goodProposalRate: stats.proposalApplyRate >= 0.70,
    };
    
    if (Object.values(conditions).every(Boolean)) {
      return { recommend: 5, reason: 'Level 5 승격 조건 충족!', conditions };
    }
  }

  // === 강등 조건 (어떤 레벨이든!) ===
  const demotion = {
    // 머지 후 에러 발생 → 즉시 Level 3으로 강등!
    postMergeError: stats.recentPostMergeErrors > 0,
    // proof-r 통과율 급락 (직전 5건 중 3건 FAIL)
    passRateDrop: stats.recentFailRate > 0.60,
    // 마스터가 수동 개입 (reject 또는 revert)
    masterIntervention: stats.recentMasterRejects > 0,
  };

  if (Object.values(demotion).some(Boolean)) {
    return { recommend: 3, reason: '안전장치: Level 3으로 강등!', demotion };
  }

  return { recommend: current, reason: '현재 레벨 유지' };
}
```

### 8-4. 자율 레벨별 동작

```
Level 3 (현재): 마스터 관리
━━━━━━━━━━━━━━━━━━━━━━━━━

  Scanner → Evaluator → graft 제안
  → 텔레그램 [✅ 승인] [❌ 거절]     ← 마스터!
  → edison 자동 구현 → darwin/* 브랜치
  → proof-r 검증
  → 텔레그램 [✅ 머지] [📝 검토]     ← 마스터!

  마스터 관여: 2회 (승인 + 머지)


Level 4 (자동 머지): 마스터 승인만
━━━━━━━━━━━━━━━━━━━━━━━━━

  Scanner → Evaluator → graft 제안
  → 텔레그램 [✅ 승인] [❌ 거절]     ← 마스터! (이것만!)
  → edison 자동 구현 → darwin/* 브랜치
  → proof-r 검증
  → PASS → 자동 머지!! (마스터 개입 없음!)
  → FAIL → 텔레그램 알림 (수동 검토)

  마스터 관여: 1회 (승인만)


Level 5 (완전 자율): 마스터는 리포트만
━━━━━━━━━━━━━━━━━━━━━━━━━

  Scanner → Evaluator → graft 제안
  → 자동 승인!! (마스터 개입 없음!)
  → edison 자동 구현 → darwin/* 브랜치
  → proof-r 검증
  → PASS → 자동 머지!!
  → FAIL → 자동 재시도 (최대 2회) → 실패 시 텔레그램 알림

  마스터 관여: 0회! (주간 리포트만 확인)
  
  단, 안전장치:
  ① core 모듈(packages/core) 변경 → Level 3으로 취급!
  ② DB 스키마(ALTER TABLE) 변경 → Level 3으로 취급!
  ③ 에러 발생 → 즉시 Level 3으로 강등!


텔레그램 주간 자율 리포트:
━━━━━━━━━━━━━━━━━━━━━━

  📊 다윈팀 자율 리포트 (주간)
  현재 자율 레벨: Level 4
  이번 주: 구현 5건, 검증 통과 4건 (80%)
  자동 머지: 4건
  머지 후 에러: 0건 ✅
  Level 5 까지: 통과율 95% 필요 (현재 80%)
  → 조건 미충족, Level 4 유지
```

### 8-5. 다윈팀을 넘어 — 전체 팀 자율 전환 프레임워크

```
다윈팀에서 검증된 자율 전환 패턴 → 모든 팀에 적용!

루나팀:
  Level 3: 매매 시그널 → 마스터 확인 → 실행
  Level 4: 매매 시그널 → 자동 실행 (리스크 한도 내)
  Level 5: 전략 변경까지 자율! (주간 리포트만)
  강등 조건: 큰 손실 발생 시 즉시 Level 3!

블로팀:
  Level 3: 게시물 초안 → 마스터 확인 → 발행
  Level 4: 게시물 자동 발행 (성과 기반 작가 선택)
  Level 5: 주제 선정까지 자율! (품질 검증만 자동)
  강등 조건: 저품질 게시물 연속 시 Level 3!

시그마팀:
  Level 3: 분석 결과 → 마스터 확인 → 피드백 적용
  Level 4: 분석 결과 자동 피드백 (Standing Orders 범위)
  Level 5: 에이전트 편성 변경까지 자율!
  강등 조건: 피드백 효과 없는 분석 연속 시 Level 3!

= 팀별 자율 레벨을 독립적으로 관리!
= 데이터로 증명된 신뢰 → 자율성 확대!
= 실패 시 즉시 강등 → 안전!
```

### 8-6. 자율 전환의 핵심 원칙

```
① 데이터로 증명! — 감이 아니라 통계로 자율 레벨 결정
② 점진적 확대! — Level 3→4→5 단계적 (한 번에 5 불가!)
③ 즉시 강등! — 에러 1건이면 즉시 Level 3 (안전 최우선)
④ 도메인별 독립! — 팀마다 다른 레벨 가능
⑤ 위험한 작업은 예외! — core/DB는 항상 마스터 승인
⑥ 투명한 리포트! — 마스터가 항상 자율 상태를 파악
⑦ 3역할 유지! — 설계+구현+검증 분리는 불변!

= "신뢰는 데이터로 쌓이고, 한순간에 무너진다"
= 이것이 팀 제이의 Bounded Autonomy 원칙!
```
