'use strict';

/**
 * lib/archer/analyzer.js — Claude API 기술 동향 분석
 *
 * v2.0:
 *   - buildContext: GitHub/npm/audit/webSources 기반 (시장·봇 데이터 제거)
 *   - SYSTEM_PROMPT: AI/LLM 기술 트렌드 + 패치업 권고 집중
 *   - 응답 스키마: patches[], security[], llm_api[], ai_techniques[], web_highlights[], summary
 */

const config = require('./config');
const { callWithFallback } = require('../../../../packages/core/lib/llm-fallback');

function normalizeDateLabel(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? String(value).slice(0, 10) : asDate.toISOString().slice(0, 10);
}

function priorityRank(priority = 'medium') {
  return { critical: 4, high: 3, medium: 2, low: 1 }[priority] || 0;
}

function bumpPriority(priority = 'medium') {
  if (priority === 'low') return 'medium';
  if (priority === 'medium') return 'high';
  return priority;
}

function normalizeTextTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3);
}

function hasMeaningfulTitleMismatch(a, b) {
  const left = normalizeTextTokens(a);
  const right = normalizeTextTokens(b);
  if (left.length === 0 || right.length === 0) return false;
  const overlap = left.filter(token => right.includes(token)).length;
  const ratio = overlap / Math.max(Math.min(left.length, right.length), 1);
  return ratio < 0.34;
}

function majorVersion(version) {
  const match = String(version || '').match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function buildDeterministicPatchList(data = {}, existingPatches = []) {
  const npm = data.npm || {};
  const packageUsage = data.packageUsage || {};
  const currentVersions = config.CURRENT_VERSIONS || {};
  const existingMap = new Map((existingPatches || []).map(patch => [patch.package, patch]));
  const patches = [];

  for (const [pkg, info] of Object.entries(npm)) {
    const current = currentVersions[pkg];
    const latest = info?.version;
    if (!current || !latest || current === latest) continue;

    const usage = packageUsage[pkg] || { count: 0, coreCount: 0, files: [], coreFiles: [] };
    const existing = existingMap.get(pkg);
    const breaking = majorVersion(current) !== null && majorVersion(latest) !== null
      ? majorVersion(current) !== majorVersion(latest)
      : false;
    let priority = usage.coreCount > 0 ? 'high' : usage.count > 0 ? 'medium' : 'low';
    if (breaking) priority = 'high';
    if (existing?.priority && priorityRank(existing.priority) > priorityRank(priority)) {
      priority = existing.priority;
    }

    const reasons = [];
    if (breaking) {
      reasons.push('메이저 버전 차이가 있어 적용 전 호환성 점검이 필요합니다.');
    } else {
      reasons.push('최신 패치/버그 수정 반영이 필요합니다.');
    }
    if (usage.count > 0) {
      reasons.push(`로컬 사용 ${usage.count}파일${usage.coreCount > 0 ? `, 핵심 경로 ${usage.coreCount}파일` : ''}입니다.`);
    } else {
      reasons.push('현재 저장소 기준 직접 사용 흔적은 적습니다.');
    }

    patches.push({
      package: pkg,
      current,
      latest,
      priority,
      reason: existing?.reason || reasons.join(' '),
      action: existing?.action || `npm update ${pkg}`,
      breaking: existing?.breaking ?? breaking,
      local_usage: {
        count: usage.count || 0,
        coreCount: usage.coreCount || 0,
        files: usage.files || [],
        coreFiles: usage.coreFiles || [],
      },
    });
  }

  return patches.sort((a, b) => {
    const diff = priorityRank(b.priority) - priorityRank(a.priority);
    if (diff !== 0) return diff;
    return (b.local_usage?.coreCount || 0) - (a.local_usage?.coreCount || 0);
  }).slice(0, 5);
}

function enrichPatchPriorities(analysis, packageUsage = {}) {
  const patches = Array.isArray(analysis?.patches) ? analysis.patches : [];
  for (const patch of patches) {
    const usage = packageUsage[patch.package] || { count: 0, coreCount: 0, files: [], coreFiles: [] };
    patch.local_usage = {
      count: usage.count || 0,
      coreCount: usage.coreCount || 0,
      files: usage.files || [],
      coreFiles: usage.coreFiles || [],
    };
    if (usage.count > 0) {
      const usageNote = `(로컬 사용 ${usage.count}파일${usage.coreCount > 0 ? `, 핵심 경로 ${usage.coreCount}파일` : ''})`;
      if (!String(patch.reason || '').includes(usageNote)) {
        patch.reason = `${patch.reason} ${usageNote}`.trim();
      }
    }
    if (usage.coreCount > 0) {
      patch.priority = bumpPriority(patch.priority);
    }
  }
  analysis.patches = patches.sort((a, b) => {
    const rank = { critical: 4, high: 3, medium: 2, low: 1 };
    const diff = (rank[b.priority] || 0) - (rank[a.priority] || 0);
    if (diff !== 0) return diff;
    return (b.local_usage?.coreCount || 0) - (a.local_usage?.coreCount || 0);
  });
  return analysis;
}

function findBestSourceItem(source, highlight) {
  const items = source?.items || [];
  if (items.length === 0) return null;

  const exactLink = items.find(srcItem => srcItem.link === highlight.link);
  if (exactLink) return exactLink;

  const titleTokens = normalizeTextTokens(highlight.title);
  const scored = items.map(srcItem => {
    const sourceTokens = normalizeTextTokens(srcItem.title);
    const overlap = titleTokens.filter(token => sourceTokens.includes(token)).length;
    return { srcItem, overlap };
  }).sort((a, b) => b.overlap - a.overlap);

  if ((scored[0]?.overlap || 0) > 0) return scored[0].srcItem;
  return items[0];
}

function enrichWebHighlights(analysis, webSources = []) {
  const highlights = Array.isArray(analysis?.web_highlights) ? analysis.web_highlights : [];
  const byLabel = new Map(webSources.map(src => [String(src.label || '').trim(), src]));
  const normalized = [];
  for (const item of highlights) {
    const source = byLabel.get(String(item.source || '').trim());
    if (!source) {
      normalized.push(item);
      continue;
    }
    const matched = findBestSourceItem(source, item);
    if (!matched) continue;

    const titleMismatch = hasMeaningfulTitleMismatch(item.title, matched.title);
    const linkMismatch = item.link !== matched.link;
    if (titleMismatch || linkMismatch) {
      item.reason = `${item.reason || ''}${item.reason ? ' ' : ''}[링크-제목 정합성 재검증 필요]`.trim();
    }
    item.title = matched.title;
    item.link = matched.link;
    normalized.push(item);
  }
  analysis.web_highlights = normalized.slice(0, 5);
  return analysis;
}

function enrichSummary(analysis, data = {}) {
  const patches = Array.isArray(analysis?.patches) ? analysis.patches : [];
  const topPatch = patches.find(item => (item.local_usage?.count || 0) > 0);
  const highlights = Array.isArray(analysis?.web_highlights) ? analysis.web_highlights : [];
  const techniques = Array.isArray(analysis?.ai_techniques) ? analysis.ai_techniques : [];
  const llmApi = Array.isArray(analysis?.llm_api) ? analysis.llm_api : [];
  const segments = [];

  if (topPatch) {
    segments.push(`실사용 영향 1순위는 ${topPatch.package} (${topPatch.local_usage.count}파일${topPatch.local_usage.coreCount > 0 ? `, 핵심 경로 ${topPatch.local_usage.coreCount}파일` : ''})입니다.`);
  } else if (patches.length > 0) {
    segments.push(`이번 주 패치 검토 1순위는 ${patches[0].package}입니다.`);
  } else if (llmApi[0]?.title) {
    segments.push(`이번 주 운영 액션 1순위는 ${llmApi[0].provider}의 '${llmApi[0].title}' 영향 점검입니다.`);
  }

  if (techniques[0]?.title) {
    segments.push(`연구 관찰 1순위는 '${techniques[0].title}'입니다.`);
  }

  if (highlights[0]?.title) {
    segments.push(`웹 하이라이트는 '${highlights[0].title}'입니다.`);
  }

  const deterministic = segments.join(' ');
  const summaryBody = String(analysis.summary || '').trim();
  const normalizedBody = deterministic && summaryBody.startsWith(deterministic)
    ? summaryBody.slice(deterministic.length).trim()
    : summaryBody;
  analysis.summary = deterministic
    ? `${deterministic}${normalizedBody ? ` ${normalizedBody}` : ''}`.trim()
    : normalizedBody;
  return analysis;
}

function normalizeAnalysis(analysis, data = {}) {
  if (!analysis || typeof analysis !== 'object') return analysis;

  const deterministicPatches = buildDeterministicPatchList(data, analysis.patches || []);
  if (!Array.isArray(analysis.patches) || analysis.patches.length === 0) {
    analysis.patches = deterministicPatches;
  } else {
    const merged = new Map();
    for (const patch of deterministicPatches) merged.set(patch.package, patch);
    for (const patch of analysis.patches) {
      merged.set(patch.package, {
        ...merged.get(patch.package),
        ...patch,
      });
    }
    analysis.patches = Array.from(merged.values());
  }

  enrichPatchPriorities(analysis, data.packageUsage || {});
  enrichWebHighlights(analysis, data.webSources || []);
  enrichSummary(analysis, data);
  return analysis;
}

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
  const packageUsage = cache?.packageUsage || {};
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
    const usage = packageUsage[pkg] || { count: 0, coreCount: 0, coreFiles: [] };
    const usageNote = usage.count > 0
      ? ` | 로컬 사용 ${usage.count}파일${usage.coreCount > 0 ? ` | 핵심 ${usage.coreCount}파일 (${usage.coreFiles.slice(0, 3).join(', ')})` : ''}`
      : ' | 로컬 사용 흔적 적음';
    lines.push(`- ${pkg}: 현재 ${current} → 최신 ${latest}${mark}${usageNote}`);
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

// ─── LLM 체인 ──────────────────────────────────────────────────────
// 아처는 문서 기준 Claude Sonnet 급 분석 품질을 우선하고,
// OpenAI/Groq는 가용성·비용 fallback으로 사용한다.
const ARCHER_CHAIN = config.LLM_CHAIN || [
  { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 4096, temperature: 0.2 },
  { provider: 'openai', model: config.OPENAI.model, maxTokens: config.OPENAI.maxTokens, temperature: config.OPENAI.temperature },
];

// ─── 메인 분석 함수 ──────────────────────────────────────────────────

/**
 * @param {object} data    { github, npm, webSources, audit }
 * @param {object} cache   archer-cache.json 기존 데이터
 * @returns {object}       파싱된 분석 결과
 */
async function analyze(data, cache = {}) {
  const contextText = buildContext({ ...data, cache: { ...cache, packageUsage: data.packageUsage || {} } });

  let raw;
  try {
    const { text, provider, model: usedModel, attempt } = await callWithFallback({
      chain:        ARCHER_CHAIN,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt:   contextText,
      logMeta: { team: 'claude', bot: 'archer', requestType: 'architecture_review' },
    });
    if (attempt > 1) {
      console.log(`  ↳ [아처] LLM 폴백: ${provider}/${usedModel} (시도 ${attempt})`);
    }
    raw = text;
  } catch (e) {
    console.warn(`  ⚠️ [아처] LLM 모든 폴백 실패: ${e.message}`);
    return null;
  }

  // JSON 추출 (코드 블록 감싸인 경우 대비)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('  ⚠️ [아처] JSON 파싱 실패 — 원본:', raw.slice(0, 200));
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return normalizeAnalysis(parsed, data);
  } catch (e) {
    console.warn('  ⚠️ [아처] JSON 파싱 오류:', e.message);
    return null;
  }
}

// ── 빌링 트렌드 섹션 ─────────────────────────────────────────────

/**
 * billing_snapshots에서 최근 7일 일별 비용 + 월간 소진율 조회
 * @returns {string} 마크다운 섹션 문자열
 */
async function buildBillingTrendSection() {
  const pgPool = require('../../../../packages/core/lib/pg-pool');
  const lines  = [];

  try {
    // 최근 7일 표는 실제 사용 로그(llm_usage_log)의 일별 합계를 사용한다.
    // billing_snapshots 는 외부 billing API의 "월 누적 snapshot"이므로
    // 최근 일별 비용 표 source 로 쓰면 변화가 없을 때 전부 0으로 보일 수 있다.
    const dailyRows = await pgPool.query('reservation', `
      SELECT created_at::date AS day,
             CASE
               WHEN model ILIKE 'claude%' OR model ILIKE '%claude%' THEN 'anthropic'
               WHEN model ILIKE 'gpt-%'   OR model ILIKE 'openai/%'  THEN 'openai'
               WHEN model ILIKE 'gemini%' OR model ILIKE '%gemini%'  THEN 'google'
               WHEN model ILIKE '%groq%'  OR model ILIKE '%llama%'   THEN 'groq'
               ELSE 'other'
             END AS provider,
             SUM(cost_usd)::float AS total_cost
      FROM llm_usage_log
      WHERE created_at::date >= CURRENT_DATE - 7
      GROUP BY day, provider
      ORDER BY day ASC, provider
    `);

    if (!dailyRows || dailyRows.length === 0) {
      return '## 💰 LLM 비용 트렌드\n\n> 데이터 없음 (llm_usage_log 비어있음)\n';
    }

    // 날짜별 실제 일간 비용 맵
    const byDate = {};
    for (const r of dailyRows) {
      const d = normalizeDateLabel(r.day);
      if (!byDate[d]) byDate[d] = {};
      byDate[d][r.provider] = parseFloat(r.total_cost || 0);
    }

    lines.push('## 💰 LLM 비용 트렌드');
    lines.push('');
    lines.push('| 날짜 | Anthropic | OpenAI | 일합계 |');
    lines.push('|------|-----------|--------|--------|');

    const recentDates = Object.keys(byDate).sort().slice(-7).reverse();
    for (const d of recentDates) {
      const ant = byDate[d].anthropic || 0;
      const oai = byDate[d].openai    || 0;
      lines.push(`| ${d} | $${ant.toFixed(3)} | $${oai.toFixed(3)} | $${(ant + oai).toFixed(3)} |`);
    }
    lines.push('');

    // 월간 소진율 + 예상 월말
    // 누적 snapshot 구조이므로 provider별 "최신" 값만 합산해야 한다.
    const monthRows = await pgPool.query('claude', `
      SELECT DISTINCT ON (provider) provider, cost_usd AS total
      FROM billing_snapshots
      WHERE date >= date_trunc('month', CURRENT_DATE)::date
      ORDER BY provider, date DESC
    `);

    let grandTotal = 0;
    const byProvider = {};
    for (const r of (monthRows || [])) {
      const t = parseFloat(r.total || 0);
      byProvider[r.provider] = t;
      grandTotal += t;
    }

    const now       = new Date();
    const daysPassed  = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const burnRate    = daysPassed > 0 ? grandTotal / daysPassed : 0;
    const projected   = burnRate * daysInMonth;

    lines.push(`**이번 달 누적**: $${grandTotal.toFixed(3)} (Anthropic: $${(byProvider.anthropic || 0).toFixed(3)}, OpenAI: $${(byProvider.openai || 0).toFixed(3)})`);
    lines.push('');
    lines.push(`**소진율**: 일평균 $${burnRate.toFixed(3)} → 예상 월말 **$${projected.toFixed(2)}**`);
    lines.push('');

  } catch (e) {
    lines.push('## 💰 LLM 비용 트렌드');
    lines.push('');
    lines.push(`> 조회 실패: ${e.message}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  analyze,
  normalizeAnalysis,
  buildContext,
  buildBillingTrendSection,
};
