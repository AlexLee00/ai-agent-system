// @ts-nocheck
'use strict';

const { WARNING_CODES } = require('./constants');

function safeNumber(value, fallback = null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function round(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function countMatches(text, pattern) {
  const matches = String(text || '').match(pattern);
  return matches ? matches.length : 0;
}

function getSeverityFromWarnings(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (list.includes(WARNING_CODES.IMAGE_TEXT_NOT_FOUND) || list.includes(WARNING_CODES.IMAGE_OCR_LOW_CONFIDENCE)) {
    return 'high';
  }
  if (list.includes(WARNING_CODES.IMAGE_TEXT_SPARSE) || list.includes(WARNING_CODES.IMAGE_ROTATION_DETECTED)) {
    return 'medium';
  }
  if (list.includes(WARNING_CODES.IMAGE_QUALITY_LOW)) {
    return 'low';
  }
  return 'none';
}

function evaluateImageOcrQuality(input = {}) {
  const text = String(input.text || '');
  const width = Math.max(0, safeNumber(input.width, 0) || 0);
  const height = Math.max(0, safeNumber(input.height, 0) || 0);
  const sourceConfidence = safeNumber(input.confidence);
  const area = width > 0 && height > 0 ? width * height : 0;
  const normalizedText = text.trim();
  const textLength = normalizedText.length;
  const lineCount = normalizedText ? normalizedText.split(/\n+/).filter(Boolean).length : 0;
  const nonWhitespaceLength = normalizedText.replace(/\s+/g, '').length;
  const printableCount = countMatches(normalizedText, /[\p{L}\p{N}\p{P}\p{S}]/gu);
  const alnumCount = countMatches(normalizedText, /[\p{L}\p{N}]/gu);
  const printableRatio = nonWhitespaceLength > 0 ? printableCount / nonWhitespaceLength : 0;
  const alnumRatio = nonWhitespaceLength > 0 ? alnumCount / nonWhitespaceLength : 0;
  const aspectRatio = width > 0 && height > 0 ? width / height : null;
  const areaInMegapixels = area > 0 ? area / 1000000 : 0;
  const textDensity = areaInMegapixels > 0 ? textLength / areaInMegapixels : textLength;
  const lineDensity = areaInMegapixels > 0 ? lineCount / areaInMegapixels : lineCount;
  const imageVerySmall = width > 0 && height > 0 ? width < 480 || height < 480 || area < 180000 : false;
  const imageLowResolution = width > 0 && height > 0 ? width < 900 || height < 900 || area < 500000 : false;
  const imageEstimatedSparseText = textLength === 0
    ? false
    : textLength < 32 || lineCount < 2 || textDensity < 60 || lineDensity < 3;

  const warnings = new Set(Array.isArray(input.warnings) ? input.warnings : []);
  if (!textLength) warnings.add(WARNING_CODES.IMAGE_TEXT_NOT_FOUND);
  if (imageEstimatedSparseText) warnings.add(WARNING_CODES.IMAGE_TEXT_SPARSE);
  if (imageVerySmall || imageLowResolution) warnings.add(WARNING_CODES.IMAGE_QUALITY_LOW);

  const rotationCandidate = Boolean(
    aspectRatio
    && (aspectRatio >= 2.4 || aspectRatio <= 0.42)
    && (imageEstimatedSparseText || lineCount <= 2)
  );
  if (rotationCandidate) warnings.add(WARNING_CODES.IMAGE_ROTATION_DETECTED);

  const lowConfidence = Boolean(
    (sourceConfidence !== null && sourceConfidence < 0.55)
    || (textLength > 0 && printableRatio < 0.7)
    || (textLength > 0 && alnumRatio < 0.4)
  );
  if (lowConfidence) warnings.add(WARNING_CODES.IMAGE_OCR_LOW_CONFIDENCE);

  const severity = getSeverityFromWarnings(Array.from(warnings));
  const imageEstimatedLowQuality = Boolean(
    severity === 'high'
    || imageVerySmall
    || imageLowResolution
    || (sourceConfidence !== null && sourceConfidence < 0.45)
  );

  let qualityScore = 1.0;
  if (imageLowResolution) qualityScore -= 0.18;
  if (imageVerySmall) qualityScore -= 0.12;
  if (imageEstimatedSparseText) qualityScore -= 0.2;
  if (rotationCandidate) qualityScore -= 0.15;
  if (sourceConfidence !== null) {
    if (sourceConfidence < 0.55) qualityScore -= 0.22;
    else if (sourceConfidence < 0.7) qualityScore -= 0.1;
  }
  if (printableRatio < 0.7 && textLength > 0) qualityScore -= 0.08;
  if (alnumRatio < 0.4 && textLength > 0) qualityScore -= 0.08;
  if (!textLength) qualityScore = 0;
  qualityScore = Math.max(0, Math.min(1, qualityScore));

  let routingBias = 'default';
  let adaptiveStrategyBias = 'default';
  let conservativeHandling = false;
  if (severity === 'high' || imageEstimatedLowQuality) {
    routingBias = 'conservative_json';
    adaptiveStrategyBias = 'conservative';
    conservativeHandling = true;
  } else if (imageEstimatedSparseText) {
    routingBias = 'concise_summary';
    adaptiveStrategyBias = 'balanced';
    conservativeHandling = true;
  }

  return {
    imageWidth: width || null,
    imageHeight: height || null,
    imageAspectRatio: round(aspectRatio),
    imageOcrQualityScore: round(qualityScore),
    imageOcrConfidence: round(sourceConfidence),
    imageTextDensity: round(textDensity),
    imageLineDensity: round(lineDensity),
    imagePrintableCharacterRatio: round(printableRatio),
    imageAlnumRatio: round(alnumRatio),
    imageIsGrayscale: null,
    imageLowResolution,
    imageVerySmall,
    imageEstimatedLowQuality,
    imageEstimatedSparseText,
    imageQualitySeverity: severity,
    imageRoutingBias: routingBias,
    imageAdaptiveStrategyBias: adaptiveStrategyBias,
    imageConservativeHandling: conservativeHandling,
    imageOcrWarnings: Array.from(warnings),
  };
}

module.exports = {
  evaluateImageOcrQuality,
  getSeverityFromWarnings,
};
