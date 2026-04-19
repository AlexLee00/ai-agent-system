'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { query, run, get } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));

const SCHEMA = 'legal';

// ─── cases ───────────────────────────────────────────────────

async function createCase(input) {
  const {
    case_number,
    court,
    case_type,
    plaintiff,
    defendant,
    appraisal_items = [],
    assigned_agents = null,
    deadline,
    notes,
  } = input;

  const rows = await query(SCHEMA,
    `INSERT INTO legal.cases
      (case_number, court, case_type, plaintiff, defendant, appraisal_items, assigned_agents, deadline, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (case_number) DO UPDATE
       SET court = EXCLUDED.court,
           case_type = EXCLUDED.case_type,
           plaintiff = EXCLUDED.plaintiff,
           defendant = EXCLUDED.defendant,
           appraisal_items = EXCLUDED.appraisal_items,
           assigned_agents = COALESCE(EXCLUDED.assigned_agents, legal.cases.assigned_agents),
           deadline = EXCLUDED.deadline,
           notes = EXCLUDED.notes,
           updated_at = NOW()
     RETURNING *`,
    [case_number, court, case_type, plaintiff, defendant,
     JSON.stringify(appraisal_items), assigned_agents ? JSON.stringify(assigned_agents) : null,
     deadline, notes]
  );
  return rows[0];
}

async function getCaseById(id) {
  return get(SCHEMA, `SELECT * FROM legal.cases WHERE id = $1`, [id]);
}

async function getCaseByCaseNumber(case_number) {
  return get(SCHEMA, `SELECT * FROM legal.cases WHERE case_number = $1`, [case_number]);
}

async function updateCaseStatus(caseId, status) {
  await run(SCHEMA,
    `UPDATE legal.cases SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, caseId]
  );
}

async function listCases(status = null) {
  if (status) {
    return query(SCHEMA, `SELECT * FROM legal.cases WHERE status = $1 ORDER BY created_at DESC`, [status]);
  }
  return query(SCHEMA, `SELECT * FROM legal.cases ORDER BY created_at DESC`);
}

// ─── code_analyses ────────────────────────────────────────────

async function saveCodeAnalysis(input) {
  const {
    case_id,
    agent,
    analysis_type,
    source_type,
    similarity_score,
    mapping_data = {},
    evidence = [],
    conclusion,
    raw_output,
  } = input;

  const rows = await query(SCHEMA,
    `INSERT INTO legal.code_analyses
      (case_id, agent, analysis_type, source_type, similarity_score, mapping_data, evidence, conclusion, raw_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [case_id, agent, analysis_type, source_type, similarity_score,
     JSON.stringify(mapping_data), JSON.stringify(evidence), conclusion, raw_output]
  );
  return rows[0];
}

async function getCodeAnalyses(caseId) {
  return query(SCHEMA,
    `SELECT * FROM legal.code_analyses WHERE case_id = $1 ORDER BY created_at`,
    [caseId]
  );
}

// ─── case_references ──────────────────────────────────────────

async function saveCaseReference(input) {
  const {
    case_id,
    agent,
    ref_case_number,
    court,
    decision_date,
    summary,
    applicable_law,
    relevance_score = 0,
    jurisdiction = 'domestic',
    raw_output,
  } = input;

  const rows = await query(SCHEMA,
    `INSERT INTO legal.case_references
      (case_id, agent, ref_case_number, court, decision_date, summary, applicable_law, relevance_score, jurisdiction, raw_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [case_id, agent, ref_case_number, court, decision_date, summary, applicable_law, relevance_score, jurisdiction, raw_output]
  );
  return rows[0];
}

async function getCaseReferences(caseId, jurisdiction = null) {
  if (jurisdiction) {
    return query(SCHEMA,
      `SELECT * FROM legal.case_references WHERE case_id = $1 AND jurisdiction = $2 ORDER BY relevance_score DESC`,
      [caseId, jurisdiction]
    );
  }
  return query(SCHEMA,
    `SELECT * FROM legal.case_references WHERE case_id = $1 ORDER BY jurisdiction, relevance_score DESC`,
    [caseId]
  );
}

// ─── reports ──────────────────────────────────────────────────

async function saveReport(input) {
  const {
    case_id,
    report_type = 'final',
    content_md,
    content_path,
    review_status = 'draft',
  } = input;

  const lastVersion = await get(SCHEMA,
    `SELECT COALESCE(MAX(version), 0) AS v FROM legal.reports WHERE case_id = $1 AND report_type = $2`,
    [case_id, report_type]
  );
  const version = (lastVersion?.v ?? 0) + 1;

  const rows = await query(SCHEMA,
    `INSERT INTO legal.reports (case_id, version, report_type, content_md, content_path, review_status)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [case_id, version, report_type, content_md, content_path, review_status]
  );
  return rows[0];
}

async function updateReportStatus(reportId, status, notes = null, balanceScore = null) {
  await run(SCHEMA,
    `UPDATE legal.reports
     SET review_status = $1, review_notes = COALESCE($2, review_notes),
         balance_score = COALESCE($3::jsonb, balance_score), updated_at = NOW()
     WHERE id = $4`,
    [status, notes, balanceScore ? JSON.stringify(balanceScore) : null, reportId]
  );
}

async function getLatestReport(caseId, reportType = 'final') {
  return get(SCHEMA,
    `SELECT * FROM legal.reports WHERE case_id = $1 AND report_type = $2
     ORDER BY version DESC LIMIT 1`,
    [caseId, reportType]
  );
}

// ─── interviews ───────────────────────────────────────────────

async function saveInterview(input) {
  const { case_id, interview_type, interviewer, content, response, analysis, conducted_at } = input;
  const rows = await query(SCHEMA,
    `INSERT INTO legal.interviews (case_id, interview_type, interviewer, content, response, analysis, conducted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [case_id, interview_type, interviewer, content, response, analysis, conducted_at]
  );
  return rows[0];
}

async function getInterviews(caseId) {
  return query(SCHEMA,
    `SELECT * FROM legal.interviews WHERE case_id = $1 ORDER BY created_at`,
    [caseId]
  );
}

// ─── sw_functions ─────────────────────────────────────────────

async function saveSwFunctions(caseId, functions) {
  const results = [];
  for (const fn of functions) {
    const rows = await query(SCHEMA,
      `INSERT INTO legal.sw_functions (case_id, category1, category2, category3, status, notes, inspected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [caseId, fn.category1, fn.category2, fn.category3, fn.status || 'unknown', fn.notes, fn.inspected_at]
    );
    results.push(rows[0]);
  }
  return results;
}

async function getSwFunctions(caseId) {
  return query(SCHEMA,
    `SELECT * FROM legal.sw_functions WHERE case_id = $1 ORDER BY category1, category2, category3`,
    [caseId]
  );
}

// ─── feedback ─────────────────────────────────────────────────

async function saveFeedback(caseId, courtDecision, appraisalAccuracy, notes) {
  const rows = await query(SCHEMA,
    `INSERT INTO legal.feedback (case_id, court_decision, appraisal_accuracy, notes)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [caseId, courtDecision, appraisalAccuracy, notes]
  );
  return rows[0];
}

module.exports = {
  createCase,
  getCaseById,
  getCaseByCaseNumber,
  updateCaseStatus,
  listCases,
  saveCodeAnalysis,
  getCodeAnalyses,
  saveCaseReference,
  getCaseReferences,
  saveReport,
  updateReportStatus,
  getLatestReport,
  saveInterview,
  getInterviews,
  saveSwFunctions,
  getSwFunctions,
  saveFeedback,
};
