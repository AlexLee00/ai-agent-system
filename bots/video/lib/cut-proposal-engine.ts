// @ts-nocheck
'use strict';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMs(value) {
  return Math.max(0, Math.round(toNumber(value, 0)));
}

function summarizeScene(scene = {}) {
  return String(scene.description || scene.scene_type || scene.ocr_text || '')
    .trim()
    .slice(0, 140);
}

function buildReason(scene, reasonCode) {
  if (reasonCode === 'low_info_tail') {
    return 'OCR 정보 변화가 적은 장면의 후반부라 불필요 구간 후보로 분류했어요.';
  }
  if (reasonCode === 'repeat_scene_tail') {
    return '비슷한 장면 유형이 연속되어 후반부를 줄이는 편이 자연스럽다고 판단했어요.';
  }
  if (reasonCode === 'ocr_failed_tail') {
    return 'OCR 신뢰도가 낮아 설명 연결성이 약한 구간으로 분류했어요.';
  }
  return `${summarizeScene(scene) || '현재 장면'}의 후반부를 줄이는 편이 흐름상 자연스럽다고 판단했어요.`;
}

function buildSegment(scene, reasonCode, confidence, trimStartSec, trimEndSec, index) {
  const startMs = roundMs(trimStartSec * 1000);
  const endMs = roundMs(trimEndSec * 1000);
  if (endMs - startMs < 1200) return null;

  return {
    item_index: index,
    item_type: 'cut_segment',
    proposal_start_ms: startMs,
    proposal_end_ms: endMs,
    confirmed_start_ms: null,
    confirmed_end_ms: null,
    confidence,
    reason_code: reasonCode,
    reason_text: buildReason(scene, reasonCode),
    scene: {
      frame_id: scene.frame_id,
      start_s: toNumber(scene.timestamp_s ?? scene.start_s, 0),
      end_s: toNumber(scene.timestamp_end_s ?? scene.end_s, 0),
      description: scene.description || '',
      scene_type: scene.scene_type || '',
    },
    red_comment: null,
    blue_comment: null,
    user_action: null,
    final: null,
  };
}

function generateCutProposals(sceneIndex = {}, syncMap = {}) {
  const scenes = ensureArray(sceneIndex.scenes);
  const matches = ensureArray(syncMap.matches);
  const proposals = [];
  const seenRanges = new Set();

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const startSec = toNumber(scene.timestamp_s ?? scene.start_s, 0);
    const endSec = toNumber(scene.timestamp_end_s ?? scene.end_s, startSec);
    const durationSec = Math.max(0, endSec - startSec);
    const keywordCount = ensureArray(scene.keywords_en).length + ensureArray(scene.keywords_ko).length;
    const prevScene = scenes[index - 1];
    const sameTypeAsPrev = prevScene && String(prevScene.scene_type || '') === String(scene.scene_type || '');
    const matchedSegments = matches.filter((match) => String(match?.source?.frame_id || '') === String(scene.frame_id || ''));
    const avgMatchScore = matchedSegments.length
      ? matchedSegments.reduce((sum, match) => sum + toNumber(match.match_score, 0), 0) / matchedSegments.length
      : 0;

    let reasonCode = null;
    let trimStartSec = null;
    let trimEndSec = null;
    let confidence = 0;

    if (scene.ocr_failed && durationSec >= 6) {
      reasonCode = 'ocr_failed_tail';
      trimStartSec = Math.max(startSec + 2.5, endSec - Math.min(2.5, durationSec * 0.35));
      trimEndSec = endSec;
      confidence = 0.74;
    } else if (sameTypeAsPrev && durationSec >= 7) {
      reasonCode = 'repeat_scene_tail';
      trimStartSec = Math.max(startSec + 3.5, endSec - Math.min(2.8, durationSec * 0.3));
      trimEndSec = endSec;
      confidence = 0.71;
    } else if (durationSec >= 8 && keywordCount <= 8 && avgMatchScore <= 0.82) {
      reasonCode = 'low_info_tail';
      trimStartSec = Math.max(startSec + 4, endSec - Math.min(3, durationSec * 0.32));
      trimEndSec = endSec;
      confidence = keywordCount <= 4 ? 0.79 : 0.68;
    }

    if (!reasonCode) continue;

    const rangeKey = `${roundMs(trimStartSec * 1000)}-${roundMs(trimEndSec * 1000)}`;
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);

    const segment = buildSegment(scene, reasonCode, confidence, trimStartSec, trimEndSec, proposals.length);
    if (segment) proposals.push(segment);
  }

  return proposals.slice(0, 6).map((item, index) => ({
    ...item,
    item_index: index,
  }));
}

function getNextCutIndex(items) {
  const nextIndex = ensureArray(items).findIndex((item) => !item.user_action);
  return nextIndex === -1 ? Math.max(0, ensureArray(items).length - 1) : nextIndex;
}

function applyCutAction(items, itemIndex, action, modification = null) {
  const nextItems = ensureArray(items).map((item) => ({ ...item }));
  const target = nextItems.find((item) => Number(item.item_index) === Number(itemIndex));
  if (!target) {
    throw new Error(`item_index=${itemIndex} 컷 구간을 찾지 못했습니다.`);
  }

  target.user_action = action;

  if (action === 'confirm') {
    target.final = {
      start_ms: target.proposal_start_ms,
      end_ms: target.proposal_end_ms,
      reason_code: target.reason_code,
      reason_text: target.reason_text,
    };
  } else if (action === 'modify') {
    const startMs = roundMs(modification?.start_ms ?? target.proposal_start_ms);
    const endMs = roundMs(modification?.end_ms ?? target.proposal_end_ms);
    if (endMs - startMs < 1200) {
      throw new Error('컷 구간은 최소 1.2초 이상이어야 합니다.');
    }
    target.final = {
      start_ms: startMs,
      end_ms: endMs,
      reason_code: target.reason_code,
      reason_text: String(modification?.reason || modification?.operator_note || target.reason_text || '').trim() || target.reason_text,
      operator_note: String(modification?.operator_note || '').trim() || null,
    };
  } else if (action === 'skip') {
    target.final = null;
  } else {
    throw new Error(`지원하지 않는 컷 action: ${action}`);
  }

  items.splice(0, items.length, ...nextItems);
  return target;
}

function summarizeCutStats(items) {
  return ensureArray(items).reduce((acc, item) => {
    if (item.user_action === 'confirm') acc.confirmed += 1;
    else if (item.user_action === 'modify') acc.modified += 1;
    else if (item.user_action === 'skip') acc.skipped += 1;
    else acc.pending += 1;
    return acc;
  }, { confirmed: 0, modified: 0, skipped: 0, pending: 0 });
}

module.exports = {
  generateCutProposals,
  getNextCutIndex,
  applyCutAction,
  summarizeCutStats,
};
