'use strict';

/**
 * 다윈 연구 제안서 저장소
 */

const fs = require('fs');
const path = require('path');

const SANDBOX_DIR = path.join(__dirname, 'sandbox');
const PROPOSALS_DIR = path.join(__dirname, '../../../../docs/research/proposals');

function ensureDirs() {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  return { sandboxDir: SANDBOX_DIR, proposalsDir: PROPOSALS_DIR };
}

function buildProposalId(paper) {
  const safeId = String(paper.arxiv_id || paper.title || 'proposal')
    .replace(/[/.:\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${safeId}_${Date.now()}`;
}

function saveProposal(proposalData) {
  ensureDirs();
  const proposalFile = path.join(PROPOSALS_DIR, `${proposalData.id}.json`);
  fs.writeFileSync(proposalFile, JSON.stringify(proposalData, null, 2), 'utf8');
  return proposalFile;
}

module.exports = {
  SANDBOX_DIR,
  PROPOSALS_DIR,
  ensureDirs,
  buildProposalId,
  saveProposal,
};
