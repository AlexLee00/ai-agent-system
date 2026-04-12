// @ts-nocheck
'use strict';

const { spawn } = require('child_process');
const {
  AUTO_PROMOTE_DEFAULTS,
  normalizeIntentText,
  buildAutoLearnPattern,
  evaluateAutoPromoteDecision,
} = require('../../../packages/core/lib/intent-core');
const {
  addLearnedPattern,
  insertUnrecognizedIntent,
  getRecentUnrecognizedIntents,
  upsertPromotionCandidate,
  logPromotionEvent,
  findPromotionCandidateIdByNormalized,
  markUnrecognizedPromoted,
} = require('../../../packages/core/lib/intent-store');

function createSkaIntentLearning({
  pgPool,
  learningPath,
  projectRoot,
  tgMaxChars = 3500,
  team = 'ska',
  actor = 'ska-commander',
}) {
  async function saveLearning(entry) {
    try {
      const normalizedText = normalizeIntentText(entry.original_text || entry.re || '');
      const learnedPattern = entry.re || buildAutoLearnPattern(normalizedText);
      const intent = entry.intent;
      const confidence = Number(entry.confidence || 0.95);
      if (!normalizedText || !intent || !learnedPattern) return;

      await insertUnrecognizedIntent(pgPool, {
        schema: team,
        text: entry.original_text || entry.re,
        parseSource: 'llm',
        llmIntent: intent,
      });

      const rows = await getRecentUnrecognizedIntents(pgPool, {
        schema: team,
        windowDays: AUTO_PROMOTE_DEFAULTS.windowDays,
        limit: 500,
      });

      const matching = rows.filter(row =>
        normalizeIntentText(row.text) === normalizedText &&
        String(row.llm_intent || '') === String(intent)
      );

      await upsertPromotionCandidate(pgPool, {
        schema: team,
        normalizedText,
        sampleText: entry.original_text || entry.re,
        suggestedIntent: intent,
        occurrenceCount: matching.length,
        confidence,
        autoApplied: false,
        learnedPattern,
      });

      const decision = evaluateAutoPromoteDecision({
        intent,
        occurrenceCount: matching.length,
        confidence,
        pattern: learnedPattern,
        team,
      });

      const candidate = await findPromotionCandidateIdByNormalized(pgPool, {
        schema: team,
        normalizedText,
      });

      if (!decision.allowed) {
        await logPromotionEvent(pgPool, {
          schema: team,
          candidateId: candidate?.id || null,
          normalizedText,
          sampleText: entry.original_text || entry.re,
          suggestedIntent: intent,
          eventType: decision.reason === 'unsafe_intent' ? 'auto_blocked' : 'candidate_seen',
          learnedPattern,
          actor,
          metadata: {
            reason: decision.reason,
            threshold: decision.threshold,
            occurrenceCount: matching.length,
            confidence,
            source: 'analyze_unknown',
          },
        });
        return;
      }

      const patternResult = addLearnedPattern({
        pattern: entry.re,
        intent,
        filePath: learningPath,
      });

      await markUnrecognizedPromoted(pgPool, {
        schema: team,
        intent,
        text: entry.original_text || entry.re,
      });

      await upsertPromotionCandidate(pgPool, {
        schema: team,
        normalizedText,
        sampleText: entry.original_text || entry.re,
        suggestedIntent: intent,
        occurrenceCount: matching.length,
        confidence,
        autoApplied: true,
        learnedPattern,
      });

      await logPromotionEvent(pgPool, {
        schema: team,
        candidateId: candidate?.id || null,
        normalizedText,
        sampleText: entry.original_text || entry.re,
        suggestedIntent: intent,
        eventType: patternResult.changed ? 'auto_apply' : 'candidate_seen',
        learnedPattern,
        actor,
        metadata: {
          reason: entry.reason || '',
          source: 'analyze_unknown',
          threshold: decision.threshold,
          occurrenceCount: matching.length,
          confidence,
        },
      });

      if (patternResult.changed) {
        console.log(`[스카] NLP 패턴 학습: /${entry.re}/ → ${intent}`);
      }
    } catch (e) {
      console.error(`[스카] NLP 학습 저장 실패:`, e.message);
    }
  }

  function runClaudeAnalyzePrompt(prompt, { cwd = projectRoot, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let finished = false;

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill('SIGTERM');
        reject(new Error(`timeout ${timeout}ms`));
      }, timeout);

      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', err => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', code => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async function handleAnalyzeUnknown(args) {
    const text = (args.text || '').trim();
    if (!text) return { ok: false, error: '분석할 텍스트 없음' };

    const prompt = `너는 AI 봇 시스템 제이(Jay)의 NLP 개선 담당이다.
제이가 처리하지 못한 사용자 메시지: "${text}"

사용 가능한 인텐트 목록:
- status              : 전체 시스템 현황 조회
- ska_query  command=query_reservations : 오늘 예약 현황·목록
- ska_action command=cancel_reservation : 예약 취소 (픽코 취소 + 네이버 해제)
- ska_query  command=query_today_stats  : 오늘 매출·입장 통계
- ska_query  command=query_alerts       : 미해결 알람 목록
- ska_action command=restart_andy       : 앤디(네이버 모니터) 재시작
- ska_action command=restart_jimmy      : 지미(키오스크 모니터) 재시작
- luna_action command=pause_trading     : 거래 일시정지
- luna_action command=resume_trading    : 거래 재개
- luna_query  command=force_report      : 투자 리포트 즉시 발송
- luna_query  command=get_status        : 루나팀 상태·잔고 조회
- claude_action command=run_check       : 덱스터 기본 점검
- claude_action command=run_full        : 덱스터 전체 점검
- claude_action command=run_fix         : 덱스터 자동 수정
- claude_action command=daily_report    : 덱스터 일일 보고
- claude_action command=run_archer      : 아처 기술 트렌드 분석
- claude_ask  query=<질문내용>           : 클로드 AI에게 직접 질문
- cost    : LLM 비용·토큰 사용량
- brief   : 야간 보류 알람 브리핑
- queue   : 알람 큐 최근 10건
- mute    : 무음 설정 (target, duration)
- unmute  : 무음 해제
- mutes   : 무음 목록
- help    : 도움말
- unknown : 어디에도 해당 없음

할 일:
1. 사용자 메시지의 의도를 파악한다.
2. 가장 적합한 인텐트를 선택한다. 없으면 null.
3. 사용자에게 전달할 자연스러운 한국어 응답을 작성한다.
4. 향후 유사한 메시지를 자동 처리할 수 있는 JavaScript 정규식 패턴을 제안한다.
   - 패턴은 new RegExp(pattern, 'i') 형태로 검증 가능해야 한다.
   - 너무 포괄적이면 오탐 발생하므로 구체적으로 작성한다.
   - 명확한 패턴이 없으면 null.

반드시 JSON 한 블록만 출력 (다른 텍스트 없이):
{
  "user_response": "사용자에게 보낼 메시지 (한국어)",
  "intent": "인텐트명 또는 null",
  "args": {},
  "pattern": "정규식 문자열 또는 null",
  "reason": "판단 근거 한 줄"
}`;

    const result = await runClaudeAnalyzePrompt(prompt, {
      cwd: projectRoot,
      timeout: 120000,
    });
    if (result.code !== 0) {
      return { ok: false, error: String(result.stderr || '').slice(0, 300) || `exit code ${result.code}` };
    }

    const output = String(result.stdout || '').trim();
    let parsed;
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { ok: true, message: output.slice(0, tgMaxChars) };
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return { ok: true, message: output.slice(0, tgMaxChars) };
    }

    if (parsed.pattern && parsed.intent && parsed.intent !== 'unknown') {
      try {
        new RegExp(parsed.pattern);
        await saveLearning({
          re: parsed.pattern,
          intent: parsed.intent,
          args: parsed.args || {},
          original_text: text,
          reason: parsed.reason || '',
          confidence: 0.95,
        });
      } catch {
        console.warn(`[스카] 잘못된 정규식 패턴 무시: ${parsed.pattern}`);
      }
    }

    const userMsg = (parsed.user_response || output).slice(0, tgMaxChars);
    const patternAdded = (parsed.pattern && parsed.intent && parsed.intent !== 'unknown')
      ? `\n\n💡 패턴 학습: \`${parsed.pattern}\` → ${parsed.intent}` : '';

    return { ok: true, message: userMsg + patternAdded };
  }

  return {
    saveLearning,
    runClaudeAnalyzePrompt,
    handleAnalyzeUnknown,
  };
}

module.exports = {
  createSkaIntentLearning,
};
