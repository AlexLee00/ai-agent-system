'use client';

function truncateText(text, maxLength = 4000) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n...(중략)`;
}

export function buildDocumentPromptAppendix(document = {}, fallbackName = '') {
  const filename = String(document.filename || fallbackName || '').trim() || '첨부 문서';
  const method = String(document.extraction_metadata?.extractionMethod || '').trim();
  const sourceFileType = String(document.extraction_metadata?.sourceFileType || '').trim();
  const parsedText = truncateText(document.extracted_text || document.extracted_text_preview || '', 4000);

  const lines = [`[첨부 파일: ${filename}]`];
  if (sourceFileType || method) {
    const info = [];
    if (sourceFileType) info.push(`유형: ${sourceFileType}`);
    if (method) info.push(`추출: ${method}`);
    lines.push(`[문서 파싱 정보: ${info.join(' / ')}]`);
  }
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
  if (length > 0) {
    return `"${filename}" 문서를 파싱해 프롬프트에 첨부했습니다.`;
  }
  return `"${filename}" 파일을 프롬프트에 첨부했습니다.`;
}
