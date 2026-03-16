'use strict';

const WARNING_CODES = Object.freeze({
  NATIVE_PDF_TEXT_EMPTY: 'native_pdf_text_empty',
  NATIVE_PDF_TEXT_TOO_SHORT: 'native_pdf_text_too_short',
  OCR_BASED_SOURCE: 'ocr_based_source',
  OCR_UNAVAILABLE: 'ocr_unavailable',
  OCR_FAILED: 'ocr_failed',
  TEXT_ENCODING_FALLBACK: 'text_encoding_fallback',
  TEXT_EMPTY: 'text_empty',
  XLSX_EMPTY_SHEET: 'xlsx_empty_sheet',
  XLSX_TOO_LARGE: 'xlsx_workbook_too_large',
  XLSX_TRUNCATED: 'xlsx_truncated',
  XLSX_SHARED_STRINGS_MISSING: 'xlsx_shared_strings_missing',
  PPTX_EMPTY_SLIDE: 'pptx_empty_slide',
  PPTX_NOTES_MISSING: 'pptx_notes_missing',
  PPTX_TRUNCATED: 'pptx_truncated',
  IMAGE_OCR_LOW_CONFIDENCE: 'image_ocr_low_confidence',
  IMAGE_TEXT_NOT_FOUND: 'image_text_not_found',
  IMAGE_QUALITY_LOW: 'image_quality_low',
  IMAGE_ROTATION_DETECTED: 'image_rotation_detected',
  IMAGE_OCR_PARTIAL: 'image_ocr_partial',
  UNSUPPORTED_FILE_TYPE: 'unsupported_file_type',
  EXTRACTOR_FAILED: 'extractor_failed',
  ZIP_LIST_FAILED: 'zip_list_failed',
  ZIP_ENTRY_MISSING: 'zip_entry_missing',
});

const MIME_TYPE_MAP = Object.freeze({
  pdf: ['application/pdf'],
  txt: ['text/plain', 'text/csv'],
  xlsx: [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  pptx: [
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  image: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
});

const EXTENSION_MAP = Object.freeze({
  pdf: ['.pdf'],
  txt: ['.txt', '.csv'],
  xlsx: ['.xlsx'],
  pptx: ['.pptx'],
  image: ['.png', '.jpg', '.jpeg', '.webp'],
});

module.exports = {
  WARNING_CODES,
  MIME_TYPE_MAP,
  EXTENSION_MAP,
};
