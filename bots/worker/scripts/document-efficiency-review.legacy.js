#!/usr/bin/env node
/**
 * scripts/document-efficiency-review.js
 *
 * 워커 문서 재사용 자산을 운영 관점에서 리뷰한다.
 * - 개선 우선 문서
 * - 좋은 템플릿 후보
 * - OCR 재검토 우선 문서
 */

const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const { createAgentMemory } = require(path.join(__dirname, '../../../packages/core/lib/agent-memory'));
const { buildWorkerCliInsight } = require('../lib/cli-insight.legacy');

const SCHEMA = 'worker';
const reviewMemory = createAgentMemory({ agentId: 'worker.document-efficiency-review', team: 'worker' });

function buildReviewFallbackInsight(review) {
  if (review.improveCandidates.length > 0) {
    return `개선 우선 문서 ${review.improveCandidates.length}건이 있어, 재사용 효율이 낮은 자산부터 정리하는 편이 좋습니다.`;
  }
  if (review.ocrReviewCandidates.length > 0) {
    return `OCR 재검토 후보 ${review.ocrReviewCandidates.length}건이 보여, 이미지 문서 품질부터 다시 확인하는 것이 좋습니다.`;
  }
  if (review.templateCandidates.length > 0) {
    return `재사용 효율이 높은 템플릿 후보 ${review.templateCandidates.length}건이 있어, 표준 양식으로 승격할 가치가 있습니다.`;
  }
  return '문서 재사용 자산이 전반적으로 안정적이며, 우선 정리할 병목은 크지 않습니다.';
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    companyId: Number(argv.find((arg) => arg.startsWith('--company-id='))?.split('=')[1] || 1),
    limit: Math.max(3, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 5)),
    json: argv.includes('--json'),
  };
}

function buildDocumentQualitySummary(metadata = {}) {
  const sourceFileType = String(metadata.sourceFileType || '').trim();
  const extractionMethod = String(metadata.extractionMethod || '').trim();
  const textLength = Math.max(0, Number(metadata.analysisReadyTextLength || 0));
  const qualitySeverity = String(metadata.imageQualitySeverity || 'none').trim();
  const conservative = Boolean(metadata.imageConservativeHandling);
  const sparse = Boolean(metadata.imageEstimatedSparseText);
  const lowQuality = Boolean(metadata.imageEstimatedLowQuality);
  const warnings = Array.isArray(metadata.imageOcrWarnings) && metadata.imageOcrWarnings.length
    ? metadata.imageOcrWarnings
    : Array.isArray(metadata.extractionWarnings) ? metadata.extractionWarnings : [];
  const reasons = [];

  let status = 'good';
  let label = '재사용 양호';

  if (extractionMethod === 'extractor_failed' || textLength <= 0) {
    status = 'needs_review';
    label = '검토 필요';
    reasons.push('파싱 텍스트가 없거나 추출이 실패했습니다.');
  } else if (sourceFileType === 'image' && (qualitySeverity === 'high' || lowQuality)) {
    status = 'needs_review';
    label = '검토 필요';
    reasons.push('이미지 OCR 품질이 낮아 재사용 전 원문 확인이 필요합니다.');
  } else if (
    textLength < 80
    || (sourceFileType === 'image' && (qualitySeverity === 'medium' || qualitySeverity === 'low' || conservative || sparse))
  ) {
    status = 'watch';
    label = '재사용 주의';
    if (textLength < 80) reasons.push('추출 텍스트가 짧아 업무 초안 품질이 낮을 수 있습니다.');
    if (sourceFileType === 'image' && (qualitySeverity === 'medium' || qualitySeverity === 'low' || conservative || sparse)) {
      reasons.push('이미지 문서라 보수적 해석 규칙을 함께 확인하는 것이 좋습니다.');
    }
  }

  if (!reasons.length && warnings.length) reasons.push(`추출 경고: ${warnings.join(', ')}`);

  return {
    status,
    label,
    reasons: reasons.slice(0, 2),
  };
}

function buildDocumentEfficiencySummary(document = {}) {
  const qualitySummary = document.quality_summary || buildDocumentQualitySummary(document.extraction_metadata || {});
  const totalReuseCount = Math.max(0, Number(document.total_reuse_count || 0));
  const linkedReuseCount = Math.max(0, Number(document.linked_reuse_count || 0));
  const reviewedCount = Math.max(0, Number(document.reviewed_reuse_count || 0));
  const acceptedWithoutEditCount = Math.max(0, Number(document.accepted_without_edit_count || 0));
  const editedSessionCount = Math.max(0, Number(document.edited_session_count || 0));
  const avgEditCount = reviewedCount > 0 ? Number(document.avg_edit_count || 0) : 0;
  const conversionRate = totalReuseCount > 0 ? linkedReuseCount / totalReuseCount : 0;
  const acceptedWithoutEditRate = reviewedCount > 0 ? acceptedWithoutEditCount / reviewedCount : 0;

  let score = 50;
  if (qualitySummary.status === 'good') score += 18;
  else if (qualitySummary.status === 'watch') score += 6;
  else score -= 18;
  score += conversionRate * 20;
  score += acceptedWithoutEditRate * 18;
  score += Math.min(totalReuseCount, 10) * 1.2;
  score -= Math.min(avgEditCount, 8) * 3;
  score -= editedSessionCount > 0 ? Math.min(editedSessionCount, 6) * 1.2 : 0;
  const normalized = Math.max(0, Math.min(100, Math.round(score)));

  let status = 'strong';
  let label = '효율 높음';
  if (normalized < 45) {
    status = 'improve';
    label = '개선 필요';
  } else if (normalized < 70) {
    status = 'watch';
    label = '효율 보통';
  }

  return {
    score: normalized,
    status,
    label,
    conversionRate: Math.round(conversionRate * 100),
    acceptedWithoutEditRate: Math.round(acceptedWithoutEditRate * 100),
    avgEditCount: reviewedCount > 0 ? Number(avgEditCount.toFixed(1)) : 0,
    totalReuseCount,
    linkedReuseCount,
    reviewedCount,
    acceptedWithoutEditCount,
    editedSessionCount,
  };
}

async function loadDocuments(companyId) {
  return pgPool.query(SCHEMA, `
    SELECT d.id,
           d.category,
           d.filename,
           d.created_at,
           d.extraction_metadata,
           COALESCE(rs.total_reuse_count, 0) AS total_reuse_count,
           COALESCE(rs.linked_reuse_count, 0) AS linked_reuse_count,
           COALESCE(rs.reviewed_reuse_count, 0) AS reviewed_reuse_count,
           COALESCE(rs.accepted_without_edit_count, 0) AS accepted_without_edit_count,
           COALESCE(rs.edited_session_count, 0) AS edited_session_count,
           COALESCE(rs.avg_edit_count, 0) AS avg_edit_count
      FROM worker.documents d
      LEFT JOIN (
        SELECT e.document_id,
               COUNT(*) AS total_reuse_count,
               COUNT(*) FILTER (WHERE e.linked_entity_type IS NOT NULL AND e.linked_entity_id IS NOT NULL) AS linked_reuse_count,
               COUNT(*) FILTER (WHERE e.feedback_session_id IS NOT NULL) AS reviewed_reuse_count,
               COUNT(*) FILTER (WHERE s.accepted_without_edit = true) AS accepted_without_edit_count,
               COUNT(*) FILTER (WHERE COALESCE(fe.edit_count, 0) > 0) AS edited_session_count,
               AVG(COALESCE(fe.edit_count, 0)::numeric) FILTER (WHERE e.feedback_session_id IS NOT NULL) AS avg_edit_count
          FROM worker.document_reuse_events e
          LEFT JOIN worker.ai_feedback_sessions s ON s.id = e.feedback_session_id
          LEFT JOIN (
            SELECT feedback_session_id,
                   COUNT(*) FILTER (
                     WHERE event_type IN ('field_edited', 'field_added', 'field_removed')
                   )::int AS edit_count
              FROM worker.ai_feedback_events
             GROUP BY feedback_session_id
          ) fe ON fe.feedback_session_id = e.feedback_session_id
         WHERE e.company_id = $1
         GROUP BY e.document_id
      ) rs ON rs.document_id = d.id
     WHERE d.company_id = $1
       AND d.deleted_at IS NULL
     ORDER BY d.created_at DESC
  `, [companyId]);
}

function enrichRows(rows) {
  return rows.map((row) => {
    const quality_summary = buildDocumentQualitySummary(row.extraction_metadata || {});
    const efficiency_summary = buildDocumentEfficiencySummary({
      ...row,
      quality_summary,
    });
    return {
      ...row,
      quality_summary,
      efficiency_summary,
    };
  });
}

function buildReview(rows, limit) {
  const sortedImprove = [...rows]
    .filter((row) => row.efficiency_summary.status === 'improve' || row.quality_summary.status === 'needs_review')
    .sort((a, b) => {
      const scoreDiff = a.efficiency_summary.score - b.efficiency_summary.score;
      if (scoreDiff !== 0) return scoreDiff;
      return Number(b.total_reuse_count || 0) - Number(a.total_reuse_count || 0);
    })
    .slice(0, limit);

  const sortedTemplate = [...rows]
    .filter((row) => row.efficiency_summary.score >= 70 && row.efficiency_summary.totalReuseCount >= 2)
    .sort((a, b) => {
      const scoreDiff = b.efficiency_summary.score - a.efficiency_summary.score;
      if (scoreDiff !== 0) return scoreDiff;
      return Number(b.linked_reuse_count || 0) - Number(a.linked_reuse_count || 0);
    })
    .slice(0, limit);

  const sortedOcr = [...rows]
    .filter((row) => row.quality_summary.status === 'needs_review' || row.quality_summary.status === 'watch')
    .sort((a, b) => {
      const qualityRank = { needs_review: 2, watch: 1, good: 0 };
      const qualityDiff = qualityRank[b.quality_summary.status] - qualityRank[a.quality_summary.status];
      if (qualityDiff !== 0) return qualityDiff;
      return Number(b.total_reuse_count || 0) - Number(a.total_reuse_count || 0);
    })
    .slice(0, limit);

  return {
    totalDocuments: rows.length,
    improveCandidates: sortedImprove,
    templateCandidates: sortedTemplate,
    ocrReviewCandidates: sortedOcr,
  };
}

function toSlimRow(row) {
  return {
    id: row.id,
    filename: row.filename,
    category: row.category,
    created_at: row.created_at,
    quality: row.quality_summary,
    efficiency: row.efficiency_summary,
  };
}

function buildReviewMemoryQuery(review) {
  return [
    'worker document efficiency review',
    review.improveCandidates.length > 0 ? 'improve-present' : 'improve-empty',
    review.templateCandidates.length > 0 ? 'template-present' : 'template-empty',
    review.ocrReviewCandidates.length > 0 ? 'ocr-present' : 'ocr-empty',
    `${review.totalDocuments}-documents`,
  ].filter(Boolean).join(' ');
}

function buildReviewMemorySummary(review) {
  const improveNames = review.improveCandidates.slice(0, 2).map((row) => row.filename).filter(Boolean);
  const templateNames = review.templateCandidates.slice(0, 2).map((row) => row.filename).filter(Boolean);
  const ocrNames = review.ocrReviewCandidates.slice(0, 2).map((row) => row.filename).filter(Boolean);

  return [
    '워커 문서 효율 리뷰',
    `총 문서: ${review.totalDocuments}건`,
    `개선 우선: ${review.improveCandidates.length}건`,
    `좋은 템플릿: ${review.templateCandidates.length}건`,
    `OCR 재검토: ${review.ocrReviewCandidates.length}건`,
    improveNames.length ? `개선 후보 예시: ${improveNames.join(', ')}` : null,
    templateNames.length ? `템플릿 후보 예시: ${templateNames.join(', ')}` : null,
    ocrNames.length ? `OCR 후보 예시: ${ocrNames.join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

function printHuman(review, memoryHints = {}, aiSummary = '') {
  const sections = [];
  sections.push(`📄 워커 문서 효율 리뷰`);
  sections.push('');
  sections.push(`🔍 AI: ${aiSummary || buildReviewFallbackInsight(review)}`);
  sections.push('');
  sections.push(`- 총 문서: ${review.totalDocuments}`);
  sections.push('');

  const groups = [
    ['개선 우선 문서', review.improveCandidates],
    ['좋은 템플릿 후보', review.templateCandidates],
    ['OCR 재검토 우선 문서', review.ocrReviewCandidates],
  ];

  for (const [title, items] of groups) {
    sections.push(title);
    if (!items.length) {
      sections.push('- 없음');
      sections.push('');
      continue;
    }
    for (const row of items) {
      sections.push(`- ${row.filename} (#${row.id})`);
      sections.push(`  카테고리: ${row.category || '-'} | 효율 ${row.efficiency_summary.score}점 (${row.efficiency_summary.label})`);
      sections.push(`  재사용 ${row.efficiency_summary.totalReuseCount}회 / 연결 ${row.efficiency_summary.linkedReuseCount}건 / 전환율 ${row.efficiency_summary.conversionRate}%`);
      sections.push(`  무수정 확정률 ${row.efficiency_summary.acceptedWithoutEditRate}% / 평균 수정 ${row.efficiency_summary.avgEditCount}`);
      if (row.quality_summary.reasons?.[0]) sections.push(`  품질 사유: ${row.quality_summary.reasons[0]}`);
    }
    sections.push('');
  }

  if (memoryHints.episodicHint) sections.push(memoryHints.episodicHint.trimStart(), '');
  if (memoryHints.semanticHint) sections.push(memoryHints.semanticHint.trimStart(), '');

  process.stdout.write(`${sections.join('\n')}\n`);
}

async function main() {
  const { companyId, limit, json } = parseArgs();
  const rows = enrichRows(await loadDocuments(companyId));
  const review = buildReview(rows, limit);
  const memoryQuery = buildReviewMemoryQuery(review);
  const episodicHint = await reviewMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 리뷰',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      review: '리뷰',
    },
    order: ['review'],
  }).catch(() => '');
  const semanticHint = await reviewMemory.recallHint(`${memoryQuery} consolidated efficiency pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const memorySummary = buildReviewMemorySummary(review);
  const aiSummary = await buildWorkerCliInsight({
    bot: 'worker-document-review',
    requestType: 'worker-document-review',
    title: '워커 문서 효율 리뷰',
    data: {
      totalDocuments: review.totalDocuments,
      improveCount: review.improveCandidates.length,
      templateCount: review.templateCandidates.length,
      ocrCount: review.ocrReviewCandidates.length,
      topImprove: review.improveCandidates.slice(0, 2).map((row) => row.filename),
      topTemplate: review.templateCandidates.slice(0, 2).map((row) => row.filename),
      topOcr: review.ocrReviewCandidates.slice(0, 2).map((row) => row.filename),
    },
    fallback: buildReviewFallbackInsight(review),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ...review,
      aiSummary,
      memoryHints: {
        episodicHint,
        semanticHint,
      },
      improveCandidates: review.improveCandidates.map(toSlimRow),
      templateCandidates: review.templateCandidates.map(toSlimRow),
      ocrReviewCandidates: review.ocrReviewCandidates.map(toSlimRow),
    }, null, 2)}\n`);
  } else {
    printHuman(review, { episodicHint, semanticHint }, aiSummary);
  }

  await reviewMemory.remember(memorySummary, 'episodic', {
    importance: 0.64,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'review',
      totalDocuments: review.totalDocuments,
      improveCount: review.improveCandidates.length,
      templateCount: review.templateCandidates.length,
      ocrCount: review.ocrReviewCandidates.length,
    },
  }).catch(() => {});
  await reviewMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
