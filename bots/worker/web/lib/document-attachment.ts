// @ts-nocheck
'use client';

function truncateText(text, maxLength = 4000) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n...(중략)`;
}

function buildImageHandlingNotice(metadata = {}) {
  if (String(metadata.sourceFileType || '').trim() !== 'image') return [];

  const warnings = Array.isArray(metadata.imageOcrWarnings) && metadata.imageOcrWarnings.length
    ? metadata.imageOcrWarnings
    : Array.isArray(metadata.extractionWarnings) ? metadata.extractionWarnings : [];
  const severity = String(metadata.imageQualitySeverity || 'none').trim();
  const routingBias = String(metadata.imageRoutingBias || 'default').trim();
  const adaptiveBias = String(metadata.imageAdaptiveStrategyBias || 'default').trim();
  const conservative = Boolean(metadata.imageConservativeHandling);
  const sparse = Boolean(metadata.imageEstimatedSparseText);
  const lowQuality = Boolean(metadata.imageEstimatedLowQuality);
  const lines = [];

  if (warnings.length || severity !== 'none') {
    const info = [];
    if (severity !== 'none') info.push(`severity: ${severity}`);
    if (warnings.length) info.push(`warnings: ${warnings.join(', ')}`);
    lines.push(`[이미지 OCR 품질 정보: ${info.join(' / ')}]`);
  }

  if (conservative || sparse || lowQuality) {
    lines.push('[이미지 OCR 해석 규칙]');
    if (lowQuality) lines.push('- 저품질 이미지로 추정되므로 보이는 텍스트만 사용하고 추정 보완을 하지 마세요.');
    if (sparse) lines.push('- 텍스트가 희소하므로 요약은 짧고 보수적으로 유지하세요.');
    if (conservative) lines.push('- 정보가 불충분하면 억지로 채우지 말고 모름/빈값으로 남기세요.');
    lines.push(`- 권장 라우팅: ${routingBias} / 전략 편향: ${adaptiveBias}`);
    lines.push('[/이미지 OCR 해석 규칙]');
  }

  return lines;
}

export function buildDocumentPromptAppendix(document = {}, fallbackName = '') {
  const filename = String(document.filename || fallbackName || '').trim() || '첨부 문서';
  const metadata = document.extraction_metadata || {};
  const method = String(metadata.extractionMethod || '').trim();
  const sourceFileType = String(metadata.sourceFileType || '').trim();
  const parsedText = truncateText(document.extracted_text || document.extracted_text_preview || '', 4000);

  const lines = [`[첨부 파일: ${filename}]`];
  if (sourceFileType || method) {
    const info = [];
    if (sourceFileType) info.push(`유형: ${sourceFileType}`);
    if (method) info.push(`추출: ${method}`);
    lines.push(`[문서 파싱 정보: ${info.join(' / ')}]`);
  }
  lines.push(...buildImageHandlingNotice(metadata));
  if (parsedText) {
    lines.push('[문서 파싱 텍스트]');
    lines.push(parsedText);
    lines.push('[/문서 파싱 텍스트]');
  } else if (document.ai_summary) {
    lines.push(`참고 요약: ${String(document.ai_summary).trim()}`);
  }
  return lines.filter(Boolean).join('\n').trim();
}

export function buildDocumentUploadNotice(document = {}, fallbackName = '') {
  const filename = String(document.filename || fallbackName || '').trim() || '첨부 문서';
  const length = Number(document.extraction_metadata?.analysisReadyTextLength || 0);
  const conservative = Boolean(document.extraction_metadata?.imageConservativeHandling);
  if (length > 0) {
    return conservative
      ? `"${filename}" 문서를 파싱했습니다. 제출 시 결과에 반영하며, 이미지 OCR 품질을 고려해 보수적으로 처리합니다.`
      : `"${filename}" 문서를 파싱했습니다. 제출 시 결과에 반영합니다.`;
  }
  return `"${filename}" 파일을 첨부했습니다. 제출 시 결과에 반영합니다.`;
}

export function mergePromptWithDocumentContext(prompt = '', appendix = '') {
  const basePrompt = String(prompt || '').trim();
  const documentAppendix = String(appendix || '').trim();
  if (!documentAppendix) return basePrompt;
  if (!basePrompt) return documentAppendix;
  return `${basePrompt}\n\n${documentAppendix}`.trim();
}

export function buildDocumentReusePackage(document = {}, fallbackName = '') {
  const filename = String(document.filename || fallbackName || '').trim() || '첨부 문서';
  const metadata = document.extraction_metadata || {};
  const qualitySeverity = String(metadata.imageQualitySeverity || 'none').trim();
  const routingBias = String(metadata.imageRoutingBias || 'default').trim();
  const conservative = Boolean(metadata.imageConservativeHandling);
  const appendix = buildDocumentPromptAppendix(document, fallbackName);
  const notice = conservative
    ? `"${filename}" 문서를 다시 불러와 보수 해석 규칙과 함께 프롬프트에 첨부했습니다.`
    : `"${filename}" 문서를 다시 불러와 프롬프트에 첨부했습니다.`;

  const hints = [];
  if (qualitySeverity !== 'none') hints.push(`이미지 severity ${qualitySeverity}`);
  if (routingBias !== 'default') hints.push(`권장 라우팅 ${routingBias}`);
  if (metadata.analysisReadyTextLength) hints.push(`텍스트 ${metadata.analysisReadyTextLength}자`);

  return {
    filename,
    notice,
    appendix,
    hints,
    conservative,
  };
}
