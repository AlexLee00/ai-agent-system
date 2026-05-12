// @ts-nocheck
'use strict';
/**
 * Humanize Agent — J영역 (CODEX_BLOG_NEURAL_QUALITY_BOOST_V2)
 * "사람처럼 작성" 90%+ 자연스러움 달성.
 *
 * 핵심 원리 (메티 J-5):
 *  ① hedging verbs 회피 (might/could/perhaps → is/will)
 *  ② 개인 경험/감정 삽입
 *  ③ 구체적 세부 (시간/장소/숫자)
 *  ④ 자연스러운 흐름 (다양한 문장 길이)
 *  ⑤ 마스터 스타일 학습
 *
 * 네이버 AI 페널티 = 없음. 품질이 핵심!
 * (출처: 네이버 공식 + AuthorMist arXiv 2503.08716)
 */

const path    = require('path');
const fs      = require('fs');
const env     = require('../../../packages/core/lib/env');
const kst     = require('../../../packages/core/lib/kst');
const { callLlm }              = require('../../../packages/core/lib/llm-fallback');
const { getLlmModelForAgent }  = require('../../../packages/core/lib/llm-model-selector');

// ── AI 작성 표시 감지 ─────────────────────────────────────────────────────────

// 2026년 기준 가장 강한 AI 작성 시그널
const AI_WRITING_SIGNALS = {
  hedgingVerbs: {
    patterns: [
      /\b(might|could|perhaps|possibly|may|seems to|appears to)\b/gi,
      /(~할 수도 있|~일 수도|아마도|어쩌면|~처럼 보|~같아 보)/g,
    ],
    label: 'hedging verbs (AI 최강 시그널)',
    severity: 'critical',
  },
  formulas: {
    patterns: [
      /^(It is important to note|It should be noted|Furthermore|Moreover|In conclusion|To summarize|In summary)/gm,
      /^(결론적으로|더 나아가|게다가|요약하자면|정리하자면|종합하면)/gm,
      /^(첫째로|둘째로|셋째로|First,\s|Second,\s|Third,\s)/gm,
    ],
    label: '정형 AI 표현',
    severity: 'high',
  },
  uniformSentences: {
    check: (text: string) => {
      const sentences = text.split(/[.!?]\s+/).filter(s => s.length > 10);
      if (sentences.length < 5) return false;
      const lengths = sentences.map(s => s.length);
      const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const variance = lengths.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / lengths.length;
      return variance < 200; // 분산 낮음 = 균일한 문장 = AI 시그널
    },
    label: '균일한 문장 길이 (AI 패턴)',
    severity: 'medium',
  },
};

export interface AiSignalReport {
  signalCount: number;
  signals: Array<{ type: string; label: string; severity: string; count: number }>;
  humanizeScore: number;  // 0-100 (높을수록 사람처럼)
  needsHumanize: boolean;
}

/**
 * AI 작성 시그널 감지
 */
export function detectAiSignals(text: string): AiSignalReport {
  const signals = [];
  let totalSignals = 0;

  // hedging verbs 검사
  for (const pattern of AI_WRITING_SIGNALS.hedgingVerbs.patterns) {
    const matches = text.match(pattern) || [];
    if (matches.length > 0) {
      signals.push({
        type: 'hedgingVerbs',
        label: AI_WRITING_SIGNALS.hedgingVerbs.label,
        severity: AI_WRITING_SIGNALS.hedgingVerbs.severity,
        count: matches.length,
      });
      totalSignals += matches.length * 3; // critical = 가중치 3
    }
  }

  // 정형 표현 검사
  for (const pattern of AI_WRITING_SIGNALS.formulas.patterns) {
    const matches = text.match(pattern) || [];
    if (matches.length > 0) {
      signals.push({
        type: 'formulas',
        label: AI_WRITING_SIGNALS.formulas.label,
        severity: AI_WRITING_SIGNALS.formulas.severity,
        count: matches.length,
      });
      totalSignals += matches.length * 2;
    }
  }

  // 균일한 문장 검사
  if (AI_WRITING_SIGNALS.uniformSentences.check(text)) {
    signals.push({
      type: 'uniformSentences',
      label: AI_WRITING_SIGNALS.uniformSentences.label,
      severity: AI_WRITING_SIGNALS.uniformSentences.severity,
      count: 1,
    });
    totalSignals += 5;
  }

  const humanizeScore = Math.max(0, 100 - totalSignals * 8);
  const needsHumanize = humanizeScore < 80;

  return { signalCount: totalSignals, signals, humanizeScore, needsHumanize };
}

// ── 마스터 스타일 프로필 ──────────────────────────────────────────────────────

const MASTER_STYLE_PATH = path.join(
  env.PROJECT_ROOT, 'bots/blog/output/master-style-profile.json'
);

export interface MasterStyleProfile {
  updatedAt: string;
  preferences: {
    tonePhrases: string[];       // 자주 쓰는 문구
    avoidPhrases: string[];      // 피하는 표현
    structurePrefs: string[];    // 구조 선호도
    personalMarkers: string[];   // 개인 표시 (이모티콘, 말투 등)
  };
  learnedAt: string;
}

function loadMasterStyleProfile(): MasterStyleProfile | null {
  try {
    if (fs.existsSync(MASTER_STYLE_PATH)) {
      return JSON.parse(fs.readFileSync(MASTER_STYLE_PATH, 'utf8'));
    }
  } catch {}
  return null;
}

// ── Humanize 시스템 프롬프트 ──────────────────────────────────────────────────

function buildHumanizeSystemPrompt(masterStyle: MasterStyleProfile | null): string {
  const styleHints = masterStyle
    ? `\n마스터 스타일 힌트:\n- 선호 문구: ${masterStyle.preferences.tonePhrases.slice(0, 5).join(', ')}\n- 회피 표현: ${masterStyle.preferences.avoidPhrases.slice(0, 3).join(', ')}`
    : '';

  return `당신은 한국 블로거입니다. 다음 원칙에 따라 글을 자연스럽게 변환하세요:

1. 자연스러운 문장 구조:
   - hedging verbs 완전 제거! ('might/could/perhaps' → 'is/will/이다')
   - 정형 시작 제거 ('결론적으로/더 나아가/첫째로' 등 → 자연스럽게)
   - 문장 길이 다양화 (짧은 문장 + 긴 문장 혼합!)
   - 갑작스러운 전환 OK (자연스러운 사고 흐름)

2. 개인적 감각 추가:
   - 개인 경험 삽입 ('얼마 전에', '직접 해보니', '솔직히 말하면')
   - 감정 표현 ('뭐랄까...', '와!', '생각보다', '의외로')
   - 의견 명확히 ('제 생각엔', '확실한 건')
   - 대화체 가끔 ('맞죠?', '어떻게 생각하세요?')

3. 구체적 세부 추가 (없으면 합리적으로 추가):
   - 정확한 시간/장소 ('어제 오전에', '강남에서')
   - 정확한 숫자 ('약 35,000원', '5분 이내')
   - 감각적 묘사

4. 한국 블로그 특성:
   - 친근한 톤 유지
   - 줄바꿈 자주 (모바일 가독성!)
   - 짧은 단락 (3-5줄)
   - 이모티콘 적절히 😊

5. 절대 회피:
   - 'In conclusion' / '결론적으로'
   - '더 나아가' / '게다가' (접속사 나열)
   - '첫째/둘째/셋째' 정형 구조
   - 평탄한 문장 (모두 비슷한 길이)${styleHints}

원본 내용의 핵심 정보는 100% 보존하면서 자연스러움만 개선하세요.`;
}

// ── 메인 Humanize 함수 ────────────────────────────────────────────────────────

export interface HumanizeResult {
  original: string;
  humanized: string;
  signalsBefore: AiSignalReport;
  signalsAfter: AiSignalReport;
  improved: boolean;
  attempts: number;
}

/**
 * 텍스트 인간화 (90%+ 자연스러움 목표)
 * - 최대 2회 시도
 * - 각 시도 후 시그널 재검사
 */
export async function humanizeText(
  text: string,
  options: {
    maxAttempts?: number;
    targetScore?: number;
    model?: string;
  } = {}
): Promise<HumanizeResult> {
  const {
    maxAttempts = 2,
    targetScore = 80,
    model = getLlmModelForAgent('blot', 'local_fast'),
  } = options;

  const signalsBefore = detectAiSignals(text);
  const masterStyle = loadMasterStyleProfile();

  if (!signalsBefore.needsHumanize) {
    return {
      original: text,
      humanized: text,
      signalsBefore,
      signalsAfter: signalsBefore,
      improved: false,
      attempts: 0,
    };
  }

  console.log(`[인간화] 시그널 감지: ${signalsBefore.signals.map(s => s.label).join(', ')}`);
  console.log(`[인간화] 현재 점수: ${signalsBefore.humanizeScore}/100 (목표: ${targetScore}+)`);

  const systemPrompt = buildHumanizeSystemPrompt(masterStyle);
  let current = text;
  let lastSignals = signalsBefore;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts++;

    const messages = [
      {
        role: 'user',
        content: `다음 글을 사람이 직접 쓴 것처럼 자연스럽게 변환하세요.
핵심 정보는 보존하고, AI 작성 표시(정형 표현, 균일 문장, hedging 등)만 제거하세요.

=== 원본 ===
${current}
=== 끝 ===

변환된 글만 반환하세요 (추가 설명 없이).`,
      },
    ];

    try {
      const response = await callLlm(
        model,
        messages,
        { systemPrompt, maxTokens: 4000, temperature: 0.7 }
      );

      const humanized = (response?.content?.[0]?.text || response?.text || '').trim();
      if (!humanized || humanized.length < text.length * 0.5) {
        console.warn(`[인간화] 시도 ${i + 1}: 결과 너무 짧음 — 스킵`);
        continue;
      }

      const newSignals = detectAiSignals(humanized);
      console.log(`[인간화] 시도 ${i + 1}: ${lastSignals.humanizeScore} → ${newSignals.humanizeScore}`);

      current = humanized;
      lastSignals = newSignals;

      if (newSignals.humanizeScore >= targetScore) {
        console.log(`[인간화] 목표 달성! (${newSignals.humanizeScore}/${targetScore})`);
        break;
      }
    } catch (e: any) {
      console.warn(`[인간화] 시도 ${i + 1} 실패:`, e.message);
    }
  }

  return {
    original: text,
    humanized: current,
    signalsBefore,
    signalsAfter: lastSignals,
    improved: lastSignals.humanizeScore > signalsBefore.humanizeScore,
    attempts,
  };
}

// ── 마스터 스타일 학습 ────────────────────────────────────────────────────────

/**
 * 마스터가 수정한 초안과 원본을 비교해 스타일 패턴 학습
 */
export async function learnFromMasterEdit(
  originalDraft: string,
  masterEdited: string
): Promise<void> {
  const model = getLlmModelForAgent('blot', 'local_fast');

  const prompt = `두 버전의 블로그 포스팅을 비교하여 마스터 편집자의 스타일 선호도를 분석하세요.

=== 원본 초안 ===
${originalDraft.substring(0, 1000)}

=== 마스터 수정본 ===
${masterEdited.substring(0, 1000)}

다음 JSON 형식으로 분석하세요:
{
  "tonePhrases": ["마스터가 선호하는 표현 5개"],
  "avoidPhrases": ["마스터가 제거한 표현 3개"],
  "structurePrefs": ["구조 선호도 3개"],
  "personalMarkers": ["개인 표시 (이모티콘/말투 등) 3개"]
}

JSON만 반환하세요.`;

  try {
    const response = await callLlm(model, [{ role: 'user', content: prompt }], {
      maxTokens: 500,
      temperature: 0.3,
    });

    const text = (response?.content?.[0]?.text || response?.text || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;

    const learned = JSON.parse(match[0]);

    // 기존 프로필과 병합
    const existing = loadMasterStyleProfile();
    const merged: MasterStyleProfile = {
      updatedAt: kst.now().toISOString(),
      learnedAt: kst.today(),
      preferences: {
        tonePhrases: [
          ...new Set([...(existing?.preferences?.tonePhrases || []), ...(learned.tonePhrases || [])]),
        ].slice(0, 20),
        avoidPhrases: [
          ...new Set([...(existing?.preferences?.avoidPhrases || []), ...(learned.avoidPhrases || [])]),
        ].slice(0, 10),
        structurePrefs: [
          ...new Set([...(existing?.preferences?.structurePrefs || []), ...(learned.structurePrefs || [])]),
        ].slice(0, 10),
        personalMarkers: [
          ...new Set([...(existing?.preferences?.personalMarkers || []), ...(learned.personalMarkers || [])]),
        ].slice(0, 10),
      },
    };

    const outputDir = path.dirname(MASTER_STYLE_PATH);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(MASTER_STYLE_PATH, JSON.stringify(merged, null, 2), 'utf8');

    console.log('[인간화] 마스터 스타일 프로필 갱신 완료');
    console.log(`  선호 문구: ${merged.preferences.tonePhrases.slice(0, 3).join(', ')}`);
  } catch (e: any) {
    console.warn('[인간화] 스타일 학습 실패:', e.message);
  }
}

// ── CLI 직접 실행 ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const stdinText = fs.readFileSync('/dev/stdin', 'utf8');
  if (!stdinText.trim()) {
    console.error('사용법: echo "텍스트" | npx tsx humanize-agent.ts');
    process.exit(1);
  }

  humanizeText(stdinText)
    .then(result => {
      console.log('\n=== 인간화 결과 ===');
      console.log(`점수: ${result.signalsBefore.humanizeScore} → ${result.signalsAfter.humanizeScore}`);
      console.log(`시도: ${result.attempts}회`);
      console.log('\n--- 변환된 텍스트 ---');
      console.log(result.humanized);
      process.exit(0);
    })
    .catch(e => {
      console.error(e.message);
      process.exit(1);
    });
}
