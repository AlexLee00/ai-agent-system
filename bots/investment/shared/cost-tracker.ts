// @ts-nocheck
/**
 * shared/cost-tracker.js — API 비용 추적 · 예산 관리 (Phase 3-A v2.1 ESM)
 *
 * 대상: Claude Haiku (live mode 전용)
 * Groq/Cerebras/SambaNova는 무료 → 별도 추적 불필요
 *
 * 예산:
 *   PAPER_MODE: 일 $0.05 / 월 $1.00
 *   LIVE_MODE:  일 $0.20 / 월 $5.00
 *
 * 기능:
 *   - 매 Haiku 호출마다 비용 계산 및 일일·월간 누계
 *   - 예산 초과 시 BUDGET_EXCEEDED 이벤트 emit
 *   - 파일 영속 (~/.openclaw/investment-cost.json)
 *   - 긴급 트리거(emergency=true) 호출은 예산 초과여도 실행
 */

import { EventEmitter }                                from 'events';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname }                              from 'path';
import { fileURLToPath }                              from 'url';
import { homedir }                                    from 'os';
import { createRequire }                              from 'module';
import yaml                                           from 'js-yaml';
import { getTradingMode }                             from './secrets.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');
const COST_FILE = join(homedir(), '.openclaw', 'investment-cost.json');

// claude-haiku-4-5 단가 ($ per 토큰)
export const HAIKU_PRICING = {
  input:       1.00 / 1_000_000,   // $1.00 per 1M input
  output:      5.00 / 1_000_000,   // $5.00 per 1M output
  cache_write: 1.25 / 1_000_000,   // $1.25 per 1M 캐시 쓰기
  cache_read:  0.10 / 1_000_000,   // $0.10 per 1M 캐시 읽기 (90% 절감)
};

// ─── config.yaml에서 예산 로드 ────────────────────────────────────────

let _budgets = {
  daily_paper:    0.05,
  daily_live:     0.20,
  monthly_paper:  1.00,
  monthly_live:   5.00,
};

try {
  const c = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
  if (c?.cost) {
    _budgets.daily_paper   = c.cost.daily_budget_paper   ?? _budgets.daily_paper;
    _budgets.daily_live    = c.cost.daily_budget_live    ?? _budgets.daily_live;
    _budgets.monthly_paper = c.cost.monthly_budget_paper ?? _budgets.monthly_paper;
    _budgets.monthly_live  = c.cost.monthly_budget_live  ?? _budgets.monthly_live;
  }
} catch { /* config.yaml 없으면 기본값 사용 */ }

// ─── 날짜 헬퍼 ───────────────────────────────────────────────────────

function getKSTDate()  { return kst.today(); }
function getKSTMonth() { return getKSTDate().slice(0, 7); }

// ─── CostTracker 클래스 ──────────────────────────────────────────────

class CostTracker extends EventEmitter {
  constructor() {
    super();
    const paperMode    = getTradingMode() === 'paper';
    this.paperMode     = paperMode;
    this.dailyBudget   = paperMode ? _budgets.daily_paper   : _budgets.daily_live;
    this.monthlyBudget = paperMode ? _budgets.monthly_paper : _budgets.monthly_live;
    this.todayDate     = getKSTDate();
    this.todayMonth    = getKSTMonth();
    this.todayUsage    = 0;
    this.monthUsage    = 0;
    this._load();
  }

  _load() {
    try {
      const data = JSON.parse(readFileSync(COST_FILE, 'utf8'));
      if (data.date  === getKSTDate())  this.todayUsage = data.usage       || 0;
      if (data.month === getKSTMonth()) this.monthUsage = data.month_usage || 0;
    } catch {}
  }

  _save() {
    try {
      const dir = join(homedir(), '.openclaw');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(COST_FILE, JSON.stringify({
        date:          this.todayDate,
        month:         this.todayMonth,
        usage:         this.todayUsage,
        month_usage:   this.monthUsage,
        daily_budget:  this.dailyBudget,
        monthly_budget:this.monthlyBudget,
        paper_mode:    this.paperMode,
        updated_at:    new Date().toISOString(),
      }), 'utf8');
    } catch {}
  }

  _resetIfNewPeriod() {
    const today = getKSTDate();
    const month = getKSTMonth();
    if (today !== this.todayDate) {
      console.log(`  💰 [비용] 날짜 변경 (${this.todayDate}→${today}) — 일일 카운터 초기화`);
      this.todayDate  = today;
      this.todayUsage = 0;
    }
    if (month !== this.todayMonth) {
      console.log(`  💰 [비용] 월 변경 (${this.todayMonth}→${month}) — 월간 카운터 초기화`);
      this.todayMonth = month;
      this.monthUsage = 0;
    }
  }

  /**
   * Anthropic 응답 usage 추적
   * @param {object}  usage      { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }
   * @param {string}  caller     호출 모듈명
   * @param {boolean} emergency  긴급 트리거 여부 (예산 초과 이벤트 skip)
   * @returns {number} 이번 호출 비용 ($)
   */
  track(usage, caller = '', emergency = false) {
    this._resetIfNewPeriod();

    const inp    = usage.input_tokens                || 0;
    const out    = usage.output_tokens               || 0;
    const cwrite = usage.cache_creation_input_tokens || 0;
    const cread  = usage.cache_read_input_tokens     || 0;

    const cost = (inp    * HAIKU_PRICING.input)
               + (out    * HAIKU_PRICING.output)
               + (cwrite * HAIKU_PRICING.cache_write)
               + (cread  * HAIKU_PRICING.cache_read);

    this.todayUsage += cost;
    this.monthUsage += cost;
    this._save();

    const cacheInfo  = cread  > 0 ? ` [캐시히트 ${cread}tok ↓90%]`
                     : cwrite > 0 ? ` [캐시쓰기 ${cwrite}tok]` : '';
    const modeTag    = this.paperMode ? '📄PAPER' : '💸LIVE';
    console.log(`  💰 [비용] ${modeTag} ${caller}: $${cost.toFixed(6)} | 오늘 $${this.todayUsage.toFixed(4)}/$${this.dailyBudget.toFixed(2)} | 이번달 $${this.monthUsage.toFixed(4)}/$${this.monthlyBudget.toFixed(2)}${cacheInfo}`);

    if (!emergency) {
      if (this.todayUsage >= this.dailyBudget) {
        const msg = `⚠️ 루나팀 일일 API 예산 초과 ($${this.dailyBudget.toFixed(2)})\n오늘 사용: $${this.todayUsage.toFixed(4)}`;
        console.warn(`\n${msg}`);
        this.emit('BUDGET_EXCEEDED', { type: 'daily', todayUsage: this.todayUsage, dailyBudget: this.dailyBudget });
      }
      if (this.monthUsage >= this.monthlyBudget) {
        const msg = `⚠️ 루나팀 월간 API 예산 초과 ($${this.monthlyBudget.toFixed(2)})\n이번달 사용: $${this.monthUsage.toFixed(4)}`;
        console.warn(`\n${msg}`);
        this.emit('BUDGET_EXCEEDED', { type: 'monthly', monthUsage: this.monthUsage, monthlyBudget: this.monthlyBudget });
      }
    }

    return cost;
  }

  /** 예산 초과 여부 */
  isExceeded() {
    this._resetIfNewPeriod();
    return this.todayUsage >= this.dailyBudget || this.monthUsage >= this.monthlyBudget;
  }

  /** 오늘 사용량 요약 */
  getToday() {
    this._resetIfNewPeriod();
    return {
      date:           this.todayDate,
      usage:          this.todayUsage,
      dailyBudget:    this.dailyBudget,
      remaining:      Math.max(0, this.dailyBudget - this.todayUsage),
      month:          this.todayMonth,
      monthUsage:     this.monthUsage,
      monthlyBudget:  this.monthlyBudget,
      monthRemaining: Math.max(0, this.monthlyBudget - this.monthUsage),
      paperMode:      this.paperMode,
    };
  }

  /**
   * 오늘 비용 요약을 텔레그램으로 전송
   * @param {Function} sendTelegramFn  report.js의 sendTelegram 함수
   */
  async reportToTelegram(sendTelegramFn) {
    const s    = this.getToday();
    const mode = s.paperMode ? '📄 PAPER' : '💸 LIVE';
    const msg  = [
      `💰 *루나팀 LLM 비용 리포트*`,
      `모드: ${mode}`,
      ``,
      `📅 오늘 (${s.date})`,
      `  사용: $${s.usage.toFixed(4)} / $${s.dailyBudget.toFixed(2)} (${(s.usage / s.dailyBudget * 100).toFixed(1)}%)`,
      `  잔여: $${s.remaining.toFixed(4)}`,
      ``,
      `📆 이번 달 (${s.month})`,
      `  사용: $${s.monthUsage.toFixed(4)} / $${s.monthlyBudget.toFixed(2)} (${(s.monthUsage / s.monthlyBudget * 100).toFixed(1)}%)`,
      `  잔여: $${s.monthRemaining.toFixed(4)}`,
    ].join('\n');
    await sendTelegramFn(msg).catch(e => console.warn('  ⚠️ [비용리포트] 텔레그램 실패:', e.message));
  }
}

// 싱글톤 (같은 프로세스 내 공유)
export const tracker = new CostTracker();
export { CostTracker };
