'use strict';

/**
 * lib/archer/analyzer.js — Claude API를 통한 기술 동향 분석
 * signal-aggregator.js의 callClaudeAPI 패턴 재사용
 */

const https = require('https');
const fs    = require('fs');
const cfg   = require('./config');

// ─── API 키 로드 ─────────────────────────────────────────────────────

function loadApiKey() {
  for (const p of cfg.SECRETS_PATHS) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s.anthropic_api_key) return s.anthropic_api_key;
    } catch { /* try next */ }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

// ─── Claude API 호출 ─────────────────────────────────────────────────

function callClaudeAPI(systemPrompt, userMessage) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.warn('  ⚠️ Anthropic API 키 없음 — 분석 섹션 생략');
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model:       cfg.CLAUDE.model,
      max_tokens:  cfg.CLAUDE.maxTokens,
      temperature: cfg.CLAUDE.temperature,
      system:      systemPrompt,
      messages:    [{ role: 'user', content: userMessage }],
    }));

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const r = JSON.parse(raw);
          resolve(r.content?.[0]?.text || null);
        } catch { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(cfg.THRESHOLDS.claudeTimeout, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── 컨텍스트 빌드 ──────────────────────────────────────────────────

function buildContext(data, prev) {
  const lines = [];

  // GitHub 버전 변경 정보
  lines.push('=== 패키지 최신 버전 ===');
  for (const item of data.github) {
    if (item.error) {
      lines.push(`- ${item.name}: 수집 실패 (${item.error})`);
      continue;
    }
    const prevVer = prev?.versions?.[item.name];
    const changed = prevVer && prevVer !== item.latest ? ` [변경: ${prevVer} → ${item.latest}]` : '';
    lines.push(`- ${item.name}: ${item.latest} (${item.publishedAt})${changed}`);
    if (item.notes && changed) lines.push(`  노트: ${item.notes.slice(0, 200)}`);
  }

  // 내부 봇 운영 현황
  const { luna, ska } = data.bots || {};
  if (luna?.available) {
    lines.push('\n=== 루나팀 현황 ===');
    lines.push(`모드: ${luna.mode || 'DEV'} | 상태: ${luna.status} | 총 실행: ${luna.runCount}회 | 연속오류: ${luna.consecutiveErrors}회`);
    if (luna.signals) {
      const { buy, sell, hold } = luna.signals;
      lines.push(`최근 신호 분포 (로그 기준): BUY ${buy} / SELL ${sell} / HOLD ${hold}`);
    }
    const perf = luna.performance;
    if (perf) {
      lines.push('\n=== 루나팀 7일 성과 (DuckDB) ===');
      const { byAction, total } = perf.signals7d;
      lines.push(`신호 합계: ${total}건 | BUY ${byAction.BUY} / SELL ${byAction.SELL} / HOLD ${byAction.HOLD}`);
      const symLines = Object.entries(perf.signals7d.bySymbol)
        .map(([s, v]) => `${s}(B${v.buy}/S${v.sell}/H${v.hold} conf${v.avgConf}%)`).join(' ');
      if (symLines) lines.push(`심볼별: ${symLines}`);
      lines.push(`드라이런 거래: ${perf.trades7d.total}건 | 누적 PnL: $${perf.trades7d.pnl}`);
      if (perf.positions.length > 0) {
        const posStr = perf.positions.map(p => `${p.symbol} ${p.amount}(미실현 $${p.unrealizedPnl})`).join(', ');
        lines.push(`현재 포지션: ${posStr}`);
      } else {
        lines.push(`현재 포지션: 없음 (드라이런)`);
      }
    }
  }
  if (ska?.available) {
    lines.push('\n=== 스카팀 현황 ===');
    lines.push(`점검횟수: ${ska.checkCount}회 | 연속오류: ${ska.consecutiveErrors}회`);
    if (ska.revenue) {
      lines.push(`7일 매출: ₩${ska.revenue.total7d.toLocaleString()} (스터디룸 ₩${ska.revenue.studyRoom7d.toLocaleString()} + 일반 ₩${ska.revenue.general7d.toLocaleString()})`);
    }
  }

  // 시장 데이터
  const fg = data.market.fearGreed;
  if (fg && !fg.error) {
    lines.push('\n=== 시장 지수 ===');
    lines.push(`공포탐욕지수: ${fg.current?.value} (${fg.current?.valueText}), 7일 평균: ${fg.avg7d}`);
  }
  const btc = data.market.btc;
  const eth = data.market.eth;
  if (btc && !btc.error) lines.push(`BTC/USDT: $${btc.price} (24h: ${btc.change24h}%)`);
  if (eth && !eth.error) lines.push(`ETH/USDT: $${eth.price} (24h: ${eth.change24h}%)`);

  return lines.join('\n');
}

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 ai-agent-system의 기술 인텔리전스 봇 아처(Archer)입니다.
매주 기술스택 현황을 점검하고 시스템 개선 방향을 제안합니다.

우리 시스템:
- Node.js v24 기반 봇 3팀 운영 (스카팀/루나팀/클로드팀)
- 스카팀: 스터디카페 예약 자동화 (Playwright, better-sqlite3, 네이버 연동)
- 루나팀: 암호화폐 자동매매 드라이런 중 (CCXT, DuckDB, Binance/Upbit)
- 클로드팀: 시스템 유지보수 (덱스터, 아처)
- LLM: claude-sonnet-4-6 (메인), gemini-2.5-flash (OpenClaw), Groq (빠른 추론)
- 인프라: macOS launchd, /tmp 로그, JSON 설정

분석 지침:
- 보안 관련 업데이트는 반드시 high urgency
- 우리 시스템에서 실제 사용하는 패키지만 적용 권고
- 자동매매 관련 LLM 모델설계 트렌드도 반영
- 시장 지수 해석은 루나팀 운용 전략에 연결
- 루나팀 신호 분포(BUY/SELL/HOLD 비율)와 시장 상황을 연결해 평가
- 스카팀 매출 추이가 있으면 전주 대비 증감 언급
- 연속오류가 있으면 action_items에 포함

응답 형식 (JSON만, 마크다운 코드블록 없음):
{
  "summary": "이번 주 핵심 변동사항 2-3줄 요약",
  "priority_updates": [
    {
      "package": "패키지명",
      "urgency": "high|medium|low",
      "reason": "업데이트 이유 (1-2문장)",
      "recommendation": "즉시 적용|다음 배포시|관망"
    }
  ],
  "market_insight": "시장 상황 2-3줄 (FnG + BTC 기반, 루나팀 운용 관점)",
  "llm_trends": "LLM API/모델 동향 요약 (우리 시스템 적용 관점)",
  "trading_tech": "자동매매 기술 트렌드 및 루나팀 설계 개선 제안 (1-3항목)",
  "action_items": ["즉시 조치 필요 항목 리스트 (없으면 빈 배열)"]
}`;

// ─── 메인 분석 함수 ──────────────────────────────────────────────────

async function analyze(data, prev) {
  console.log('  🤖 Claude 분석 중...');
  const start = Date.now();

  const context = buildContext(data, prev);
  const userMsg = `다음 수집 데이터를 분석해 주세요:\n\n${context}`;

  const responseText = await callClaudeAPI(SYSTEM_PROMPT, userMsg);
  const elapsed = Date.now() - start;

  if (!responseText) return { error: 'API 응답 없음', elapsed };

  try {
    const cleaned = responseText.replace(/```json?\n?|\n?```/g, '').trim();
    const result  = JSON.parse(cleaned);
    console.log(`  ✅ Claude 분석 완료 (${elapsed}ms)`);
    return { ...result, elapsed };
  } catch {
    console.warn('  ⚠️ Claude 응답 파싱 실패 — raw 텍스트로 저장');
    return { raw: responseText, elapsed };
  }
}

module.exports = { analyze };
