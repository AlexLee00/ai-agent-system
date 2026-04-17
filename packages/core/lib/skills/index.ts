// @ts-nocheck
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
const darwinGithubAnalysis = require('./darwin/github-analysis');
const justinCitationAudit = require('./justin/citation-audit');
const justinEvidenceMap = require('./justin/evidence-map');
const justinJudgeSimulator = require('./justin/judge-simulator');
const justinPrecedentComparer = require('./justin/precedent-comparer');
const justinDamagesAnalyst = require('./justin/damages-analyst');
const blogBookReviewBook = require('./blog/book-review-book');
const blogBookSourceVerify = require('./blog/book-source-verify');

function optionalRequire(modulePath, fallback = null) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return fallback;
    throw error;
  }
}

const sigmaDataQualityGuard = optionalRequire('./sigma/data-quality-guard');
const sigmaExperimentDesign = optionalRequire('./sigma/experiment-design');
const sigmaCausalCheck = optionalRequire('./sigma/causal-check');
const sigmaFeaturePlanner = optionalRequire('./sigma/feature-planner');
const sigmaObservabilityPlanner = optionalRequire('./sigma/observability-planner');

// SKA 스킬 문서 경로 (마크다운 — LLM 컨텍스트용, require 불필요)
// packages/core/lib/skills/ska/*.md 참조

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
    githubAnalysis: darwinGithubAnalysis,
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
    bookReviewBook: blogBookReviewBook,
    bookSourceVerify: blogBookSourceVerify,
  },
};
