'use strict';

/**
 * lib/archer/analyzer.js — Claude API 기술 동향 분석
 *
 * v2.0:
 *   - buildContext: GitHub/npm/audit/webSources 기반 (시장·봇 데이터 제거)
 *   - SYSTEM_PROMPT: AI/LLM 기술 트렌드 + 패치업 권고 집중
 *   - 응답 스키마: patches[], security[], llm_api[], ai_techniques[], web_highlights[], summary
 */

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const fs        = require('fs');
const config    = require('./config');

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 AI 개발팀의 수석 기술 인텔리전스 봇 "아처"입니다.
역할: 매주 월요일 아침, 팀에게 AI/LLM 생태계 최신 동향과 패키지 패치 권고를 제공합니다.

분석 관점:
1. **패키지 업데이트**: 현재 사용 버전 vs 최신 버전 비교 — 메이저/마이너 업그레이드 필요 여부
2. **보안 취약점**: npm audit 결과 — critical/high 우선 조치 항목
3. **LLM API 변화**: Anthropic/OpenAI/Groq 등 API 및 SDK 변경사항 — 우리 코드에 영향 가능성
4. **AI 기술 트렌드**: 주간 논문·블로그에서 실무 적용 가능한 기술 추출
5. **웹 소스 하이라이트**: 놓치면 안 되는 주요 발표·릴리스

응답 형식 (JSON만, 추가 텍스트 없음):
{
  "patches": [
    {
      "package":    "패키지명",
      "current":    "현재버전",
      "latest":     "최신버전",
      "priority":   "critical|high|medium|low",
      "reason":     "업그레이드 이유 1문장",
      "action":     "npm update @anthropic-ai/sdk 같은 실행 명령",
      "breaking":   true|false
    }
  ],
  "security": [
    {
      "package":  "패키지명",
      "severity": "critical|high|moderate|low",
      "summary":  "취약점 요약 1문장",
      "action":   "조치 방법"
    }
  ],
  "llm_api": [
    {
      "provider": "Anthropic|OpenAI|Groq|Google",
      "title":    "변경사항 제목",
      "impact":   "우리 시스템에 미치는 영향",
      "action":   "권장 대응 (없으면 '없음')"
    }
  ],
  "ai_techniques": [
    {
      "title":    "기술명",
      "source":   "출처 (논문/블로그)",
      "summary":  "핵심 내용 2문장 이내",
      "applicability": "우리 시스템 적용 가능성"
    }
  ],
  "web_highlights": [
    {
      "source": "소스 ID",
      "title":  "항목 제목",
      "link":   "URL",
      "reason": "주목 이유 1문장"
    }
  ],
  "summary": "이번 주 핵심 요약 3문장 이내 (한국어)"
}

규칙:
- 각 배열은 최대 5개 항목
- 중요하지 않으면 배열을 비워도 됨
- breaking: true인 패치는 반드시 reason에 주의사항 명시
- 응답은 JSON만, 마크다운 코드 블록 없이`;

// ─── 컨텍스트 빌더 ───────────────────────────────────────────────────

function buildContext({ github, npm, webSources, audit, cache }) {
  const prev = cache?.versions || {};
  const lines = [];

  // 1. GitHub 릴리스
  lines.push('## GitHub 최신 릴리스');
  for (const [name, info] of Object.entries(github)) {
    if (info.error) {
      lines.push(`- ${name}: 조회 실패 (${info.error})`);
    } else {
      lines.push(`- ${name}: ${info.tag || '알 수 없음'} (${info.published?.slice(0, 10) || '-'})`);
    }
  }

  // 2. npm 최신 버전 vs 현재 사용 버전
  lines.push('\n## npm 패키지 버전 현황');
  for (const [pkg, info] of Object.entries(npm)) {
    const current = prev[pkg] || config.CURRENT_VERSIONS[pkg] || '알 수 없음';
    const latest  = info.version || '알 수 없음';
    const mark    = current !== '알 수 없음' && latest !== '알 수 없음' && current !== latest ? ' ⬆️' : '';
    lines.push(`- ${pkg}: 현재 ${current} → 최신 ${latest}${mark}`);
  }

  // 3. npm audit 결과
  lines.push('\n## npm audit 보안 스캔');
  if (audit.error) {
    lines.push(`- 스캔 실패: ${audit.error}`);
  } else if (audit.total === 0) {
    lines.push('- 취약점 없음');
  } else {
    const s = audit.summary;
    lines.push(`- 총 ${audit.total}개 취약점`);
    lines.push(`  critical: ${s.critical || 0}, high: ${s.high || 0}, moderate: ${s.moderate || 0}, low: ${s.low || 0}`);
    // 상위 5개 취약점 상세
    const topVulns = Object.entries(audit.vulnerabilities).slice(0, 5);
    for (const [pkg, v] of topVulns) {
      lines.push(`  - [${v.severity}] ${pkg}: ${(v.via?.[0]?.title || v.title || '').slice(0, 80)}`);
    }
  }

  // 4. 웹 소스 수집 항목
  lines.push('\n## 주간 웹 소스 수집');
  for (const src of (webSources || [])) {
    if (src.error || src.items.length === 0) continue;
    lines.push(`\n### ${src.label}`);
    for (const item of src.items.slice(0, 3)) {
      lines.push(`- ${item.title}${item.pubDate ? ` (${item.pubDate.slice(0, 10)})` : ''}`);
    }
  }

  return lines.join('\n');
}

// ─── Claude API 호출 ─────────────────────────────────────────────────

function loadApiKey() {
  for (const p of config.SECRETS_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s?.anthropic_api_key) return s.anthropic_api_key;
    } catch { /* 무시 */ }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

async function callClaude(contextText) {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 없음');

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model:      config.CLAUDE.model,
    max_tokens: config.CLAUDE.maxTokens,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: contextText }],
  });

  return msg.content[0]?.text || '';
}

// ─── 메인 분석 함수 ──────────────────────────────────────────────────

/**
 * @param {object} data    { github, npm, webSources, audit }
 * @param {object} cache   archer-cache.json 기존 데이터
 * @returns {object}       파싱된 분석 결과
 */
async function analyze(data, cache = {}) {
  const contextText = buildContext({ ...data, cache });

  let raw;
  try {
    raw = await callClaude(contextText);
  } catch (e) {
    console.warn(`  ⚠️ [아처] Claude API 실패: ${e.message}`);
    return null;
  }

  // JSON 추출 (코드 블록 감싸인 경우 대비)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('  ⚠️ [아처] JSON 파싱 실패 — 원본:', raw.slice(0, 200));
    return null;
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn('  ⚠️ [아처] JSON 파싱 오류:', e.message);
    return null;
  }
}

module.exports = { analyze, buildContext };
