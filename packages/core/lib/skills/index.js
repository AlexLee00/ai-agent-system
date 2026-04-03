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
const darwinReplicator = require('./darwin/replicator');
const darwinSynthesis = require('./darwin/synthesis');
const darwinSourceAuditor = require('./darwin/source-auditor');
const justinCitationAudit = require('./justin/citation-audit');
const justinEvidenceMap = require('./justin/evidence-map');
const justinJudgeSimulator = require('./justin/judge-simulator');
const justinPrecedentComparer = require('./justin/precedent-comparer');
const justinDamagesAnalyst = require('./justin/damages-analyst');
const sigmaDataQualityGuard = require('./sigma/data-quality-guard');
const sigmaExperimentDesign = require('./sigma/experiment-design');
const sigmaCausalCheck = require('./sigma/causal-check');
const sigmaFeaturePlanner = require('./sigma/feature-planner');
const sigmaObservabilityPlanner = require('./sigma/observability-planner');
const blogBookSourceVerify = require('./blog/book-source-verify');

module.exports = {
  codeReview, verifyLoop, plan,
  securityPipeline, evalHarness, teamOrchestrator, sessionWrap,
  buildSystem, instinctLearning, patternToSkill, skillExplorer, sessionAnalyzer,
  tdd, handoffVerify,
  darwin: {
    sourceRanking: darwinSourceRanking,
    counterexample: darwinCounterexample,
    replicator: darwinReplicator,
    synthesis: darwinSynthesis,
    sourceAuditor: darwinSourceAuditor,
  },
  justin: {
    citationAudit: justinCitationAudit,
    evidenceMap: justinEvidenceMap,
    judgeSimulator: justinJudgeSimulator,
    precedentComparer: justinPrecedentComparer,
    damagesAnalyst: justinDamagesAnalyst,
  },
  sigma: {
    dataQualityGuard: sigmaDataQualityGuard,
    experimentDesign: sigmaExperimentDesign,
    causalCheck: sigmaCausalCheck,
    featurePlanner: sigmaFeaturePlanner,
    observabilityPlanner: sigmaObservabilityPlanner,
  },
  blog: {
    bookSourceVerify: blogBookSourceVerify,
  },
};
