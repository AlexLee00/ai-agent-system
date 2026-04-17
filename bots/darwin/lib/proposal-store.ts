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

function _findProposalFile(proposalId) {
  ensureDirs();
  const exact = path.join(PROPOSALS_DIR, `${proposalId}.json`);
  if (fs.existsSync(exact)) return exact;
  const files = fs.readdirSync(PROPOSALS_DIR).filter((file) => file.includes(proposalId));
  if (files.length === 0) return null;
  return path.join(PROPOSALS_DIR, files[0]);
}

function loadProposal(proposalId) {
  const proposalFile = _findProposalFile(proposalId);
  if (!proposalFile) return null;
  return JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
}

function updateStatus(proposalId, status, extra = {}) {
  const proposalFile = _findProposalFile(proposalId);
  if (!proposalFile) return null;
  const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
  proposal.status = status;
  proposal.updated_at = new Date().toISOString();
  Object.assign(proposal, extra || {});
  fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2), 'utf8');
  return proposal;
}

module.exports = {
  SANDBOX_DIR,
  PROPOSALS_DIR,
  ensureDirs,
  buildProposalId,
  saveProposal,
  loadProposal,
  updateStatus,
};
