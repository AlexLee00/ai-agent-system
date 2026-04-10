// @ts-nocheck
'use strict';

function analyzeDamages(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const supportedItems = [];
  const unsupportedItems = [];
  let estimatedTotal = 0;

  for (const item of items) {
    const amount = Number(item.amount || 0);
    const hasEvidence = !!item.has_evidence;
    const label = String(item.label || 'unknown');

    if (hasEvidence) {
      supportedItems.push(label);
      estimatedTotal += amount;
    } else {
      unsupportedItems.push(label);
    }
  }

  let riskLevel = 'low';
  if (unsupportedItems.length > supportedItems.length) riskLevel = 'high';
  else if (unsupportedItems.length > 0) riskLevel = 'medium';

  return {
    estimated_total: Number(estimatedTotal.toFixed(2)),
    supported_items: supportedItems,
    unsupported_items: unsupportedItems,
    risk_level: riskLevel,
  };
}

module.exports = {
  analyzeDamages,
};

