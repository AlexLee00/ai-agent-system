'use strict';

const codeReview = require('./code-review');
const verifyLoop = require('./verify-loop');
const plan = require('./plan');
const securityPipeline = require('./security-pipeline');
const evalHarness = require('./eval-harness');
const teamOrchestrator = require('./team-orchestrator');
const sessionWrap = require('./session-wrap');
const buildSystem = require('./build-system');
const instinctLearning = require('./instinct-learning');
const patternToSkill = require('./pattern-to-skill');
const skillExplorer = require('./skill-explorer');
const sessionAnalyzer = require('./session-analyzer');
const tdd = require('./tdd');
const handoffVerify = require('./handoff-verify');
const darwinSourceRanking = require('./darwin/source-ranking');
const darwinCounterexample = require('./darwin/counterexample');
const justinCitationAudit = require('./justin/citation-audit');
const justinEvidenceMap = require('./justin/evidence-map');
const sigmaDataQualityGuard = require('./sigma/data-quality-guard');
const sigmaExperimentDesign = require('./sigma/experiment-design');

module.exports = {
  codeReview, verifyLoop, plan,
  securityPipeline, evalHarness, teamOrchestrator, sessionWrap,
  buildSystem, instinctLearning, patternToSkill, skillExplorer, sessionAnalyzer,
  tdd, handoffVerify,
  darwin: { sourceRanking: darwinSourceRanking, counterexample: darwinCounterexample },
  justin: { citationAudit: justinCitationAudit, evidenceMap: justinEvidenceMap },
  sigma: { dataQualityGuard: sigmaDataQualityGuard, experimentDesign: sigmaExperimentDesign },
};
