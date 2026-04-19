/**
 * /hub/legal — 저스틴팀 법원 감정 API
 *
 * POST /hub/legal/case            — 새 사건 접수
 * GET  /hub/legal/cases           — 사건 목록 (status 필터 가능)
 * GET  /hub/legal/case/:id        — 사건 상세
 * GET  /hub/legal/case/:id/status — 사건 진행 상태 요약
 * POST /hub/legal/case/:id/approve — 마스터 승인 (status 전환)
 * POST /hub/legal/case/:id/feedback — 판결 피드백 등록 (Phase 6)
 * GET  /hub/legal/case/:id/report  — 최신 감정서 조회
 */

const path = require('path');
const env = require('../../../../packages/core/lib/env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store');
const SENDER_PATH = path.join(env.PROJECT_ROOT, 'packages/core/lib/telegram-sender');

function _notifyNewCase(row: any): void {
  try {
    const sender = require(SENDER_PATH);
    const typeLabel: Record<string, string> = {
      copyright: '저작권 침해', contract: '계약 위반',
      patent: '특허 침해', trade_secret: '영업비밀 침해', other: '기타',
    };
    const label = typeLabel[row.case_type] || row.case_type;
    const msg = `⚖️ [저스틴팀] 새 감정 사건 접수\n사건번호: ${row.case_number}\n법원: ${row.court}\n유형: ${label}\n원고: ${row.plaintiff}\n피고: ${row.defendant}`;
    sender.send('legal', msg).catch(() => {/* 알림 실패는 무시 */});
  } catch {
    // telegram-sender 로드 실패 시 무시 (알림은 부가 기능)
  }
}

const VALID_CASE_TYPES = ['copyright', 'contract', 'patent', 'trade_secret', 'other'] as const;
const VALID_STATUSES = ['received', 'analyzing', 'drafting', 'review', 'approved', 'submitted', 'closed'] as const;
const VALID_APPROVE_TRANSITIONS: Record<string, string> = {
  received: 'analyzing',
  analyzing: 'drafting',
  drafting: 'review',
  review: 'approved',
  approved: 'submitted',
  submitted: 'closed',
};

function str(v: unknown, fallback = ''): string {
  const s = String(v == null ? fallback : v).trim();
  return s || fallback;
}

function intParam(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseId(v: unknown): number | null {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getStore() {
  return require(STORE_PATH);
}

/**
 * POST /hub/legal/case
 * Body: { case_number, court, case_type, plaintiff, defendant, appraisal_items?, deadline?, notes? }
 */
export async function legalCaseCreateRoute(req: any, res: any) {
  try {
    const case_number = str(req.body?.case_number);
    const court = str(req.body?.court);
    const case_type = str(req.body?.case_type, 'other');
    const plaintiff = str(req.body?.plaintiff);
    const defendant = str(req.body?.defendant);

    if (!case_number || !court || !plaintiff || !defendant) {
      return res.status(400).json({ ok: false, error: 'case_number, court, plaintiff, defendant 필수' });
    }
    if (!VALID_CASE_TYPES.includes(case_type as any)) {
      return res.status(400).json({ ok: false, error: `case_type must be one of: ${VALID_CASE_TYPES.join(', ')}` });
    }

    const appraisal_items = Array.isArray(req.body?.appraisal_items) ? req.body.appraisal_items : [];
    const deadline = req.body?.deadline ? str(req.body.deadline) : null;
    const notes = req.body?.notes ? str(req.body.notes) : null;

    const store = getStore();
    const row = await store.createCase({ case_number, court, case_type, plaintiff, defendant, appraisal_items, deadline, notes });

    console.log(`[HubLegal] 사건 접수: ${case_number} (id=${row.id})`);
    _notifyNewCase(row);
    return res.status(201).json({ ok: true, case: row });
  } catch (err: any) {
    console.error('[HubLegal] case 생성 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /hub/legal/cases?status=&limit=&offset=
 */
export async function legalCasesListRoute(req: any, res: any) {
  try {
    const status = str(req.query?.status) || null;
    if (status && !VALID_STATUSES.includes(status as any)) {
      return res.status(400).json({ ok: false, error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const store = getStore();
    let cases = await store.listCases(status);

    const limit = intParam(req.query?.limit, 50, 1, 200);
    const offset = intParam(req.query?.offset, 0, 0, 1_000_000);
    const total = cases.length;
    cases = cases.slice(offset, offset + limit);

    return res.json({ ok: true, total, limit, offset, cases });
  } catch (err: any) {
    console.error('[HubLegal] cases 목록 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /hub/legal/case/:id
 */
export async function legalCaseDetailRoute(req: any, res: any) {
  try {
    const id = parseId(req.params?.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });

    const store = getStore();
    const row = await store.getCaseById(id);
    if (!row) return res.status(404).json({ ok: false, error: `사건 id=${id} 없음` });

    return res.json({ ok: true, case: row });
  } catch (err: any) {
    console.error('[HubLegal] case 조회 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /hub/legal/case/:id/status
 * 분석 결과 요약 포함 (code_analyses, case_references, latest report)
 */
export async function legalCaseStatusRoute(req: any, res: any) {
  try {
    const id = parseId(req.params?.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });

    const store = getStore();
    const row = await store.getCaseById(id);
    if (!row) return res.status(404).json({ ok: false, error: `사건 id=${id} 없음` });

    const [analyses, references, swFunctions, interviews, latestReport] = await Promise.allSettled([
      store.getCodeAnalyses(id),
      store.getCaseReferences(id),
      store.getSwFunctions(id),
      store.getInterviews(id),
      store.getLatestReport(id, 'final'),
    ]);

    return res.json({
      ok: true,
      case_id: id,
      case_number: row.case_number,
      status: row.status,
      case_type: row.case_type,
      deadline: row.deadline,
      summary: {
        code_analyses: analyses.status === 'fulfilled' ? analyses.value.length : 0,
        case_references: references.status === 'fulfilled' ? references.value.length : 0,
        sw_functions: swFunctions.status === 'fulfilled' ? swFunctions.value.length : 0,
        interviews: interviews.status === 'fulfilled' ? interviews.value.length : 0,
        has_draft_report: latestReport.status === 'fulfilled' && latestReport.value != null,
        report_review_status: latestReport.status === 'fulfilled' && latestReport.value
          ? latestReport.value.review_status
          : null,
      },
      updated_at: row.updated_at,
    });
  } catch (err: any) {
    console.error('[HubLegal] case status 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * POST /hub/legal/case/:id/approve
 * Body: { action: 'advance' | 'status', target_status? }
 * - 'advance': 워크플로우 순서대로 다음 단계로 전환
 * - 'status': target_status로 직접 전환 (마스터 긴급 수동 조정)
 */
export async function legalCaseApproveRoute(req: any, res: any) {
  try {
    const id = parseId(req.params?.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });

    const store = getStore();
    const row = await store.getCaseById(id);
    if (!row) return res.status(404).json({ ok: false, error: `사건 id=${id} 없음` });

    const action = str(req.body?.action, 'advance');
    let newStatus: string;

    if (action === 'advance') {
      const next = VALID_APPROVE_TRANSITIONS[row.status];
      if (!next) {
        return res.status(409).json({ ok: false, error: `status '${row.status}'에서 더 이상 진행할 수 없습니다.` });
      }
      newStatus = next;
    } else if (action === 'status') {
      const target = str(req.body?.target_status);
      if (!target || !VALID_STATUSES.includes(target as any)) {
        return res.status(400).json({ ok: false, error: `target_status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      newStatus = target;
    } else {
      return res.status(400).json({ ok: false, error: "action must be 'advance' or 'status'" });
    }

    await store.updateCaseStatus(id, newStatus);
    console.log(`[HubLegal] 사건 상태 전환: ${row.case_number} ${row.status} → ${newStatus}`);

    return res.json({ ok: true, case_id: id, case_number: row.case_number, previous_status: row.status, new_status: newStatus });
  } catch (err: any) {
    console.error('[HubLegal] case approve 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * POST /hub/legal/case/:id/feedback
 * Body: { court_decision, appraisal_accuracy, notes? }
 * Phase 6 — 판결 피드백 등록
 */
export async function legalCaseFeedbackRoute(req: any, res: any) {
  try {
    const id = parseId(req.params?.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });

    const court_decision = str(req.body?.court_decision);
    const appraisal_accuracy = Number(req.body?.appraisal_accuracy);

    if (!court_decision) {
      return res.status(400).json({ ok: false, error: 'court_decision 필수' });
    }
    if (!Number.isFinite(appraisal_accuracy) || appraisal_accuracy < 0 || appraisal_accuracy > 1) {
      return res.status(400).json({ ok: false, error: 'appraisal_accuracy must be 0.0~1.0' });
    }

    const store = getStore();
    const row = await store.getCaseById(id);
    if (!row) return res.status(404).json({ ok: false, error: `사건 id=${id} 없음` });

    const notes = req.body?.notes ? str(req.body.notes) : null;
    const feedback = await store.saveFeedback(id, court_decision, appraisal_accuracy, notes);

    console.log(`[HubLegal] 판결 피드백 등록: ${row.case_number} accuracy=${appraisal_accuracy}`);
    return res.status(201).json({ ok: true, feedback });
  } catch (err: any) {
    console.error('[HubLegal] feedback 등록 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /hub/legal/case/:id/report?type=final
 */
export async function legalCaseReportRoute(req: any, res: any) {
  try {
    const id = parseId(req.params?.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id must be a positive integer' });

    const reportType = str(req.query?.type, 'final');

    const store = getStore();
    const row = await store.getCaseById(id);
    if (!row) return res.status(404).json({ ok: false, error: `사건 id=${id} 없음` });

    const report = await store.getLatestReport(id, reportType);
    if (!report) return res.status(404).json({ ok: false, error: `감정서 없음 (case_id=${id}, type=${reportType})` });

    return res.json({ ok: true, case_number: row.case_number, report });
  } catch (err: any) {
    console.error('[HubLegal] report 조회 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
