'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * bots/worker/web/server.js — 워커팀 REST API 서버 (포트 4000)
 *
 * POST /api/auth/login          — 로그인
 * POST /api/auth/register       — 사용자 등록 (master만)
 * GET  /api/auth/me             — 내 정보
 * POST /api/auth/change-password
 *
 * GET/POST/PUT/DELETE /api/companies
 * GET/POST/PUT/DELETE /api/users
 * GET/POST/PUT/PUT    /api/approvals
 * GET                 /api/audit
 */

const path        = require('path');
const os          = require('os');
const http        = require('http');
const { randomUUID } = require('crypto');
const { spawn, spawnSync }   = require('child_process');
const { pathToFileURL } = require('url');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');
const { WebSocketServer } = require('ws');
const fs = require('fs');

const pgPool  = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const { hashPassword, verifyPassword, generateToken, verifyToken, validatePasswordPolicy } = require('../lib/auth.ts');
const { requireAuth, requireRole, companyFilter, auditLog, assertCompanyAccess } = require('../lib/company-guard.ts');
const { accessLogger, errorLogger, logAuth } = require('../lib/logger.ts');
const { getSecret } = require('../lib/secrets.ts');
const { syncSkaSalesToWorker } = require('../lib/ska-sales-sync.ts');
const { recalcProgress } = require('../src/ryan.ts');
const { resolveAiPolicy, validateLlmModeForUser } = require('../lib/ai-policy.ts');
const { getMenuPolicyForRole } = require('../lib/menu-policy.ts');
const {
  ALLOWED_APIS,
  API_CATALOG,
  buildProviderOptions,
  getWorkerMonitoringChangeHistory,
  getWorkerMonitoringChangeImpact,
  getWorkerMonitoringPreference,
  getWorkerLlmApplicationSummary,
  getWorkerSelectorSummary,
  getWorkerMonitoringUsageSummary,
  setWorkerMonitoringPreference,
} = require('../lib/llm-api-monitoring.ts');
const { parseNaverBlogUrl } = require(path.join(__dirname, '../../../packages/core/lib/naver-blog-url.js'));
const { describeLLMSelector } = require(path.join(__dirname, '../../../packages/core/lib/llm-model-selector.js'));
const { buildSpeedLookup, buildSelectorAdvice } = require(path.join(__dirname, '../../../packages/core/lib/llm-selector-advisor.legacy.js'));
const { markPublished } = require(path.join(__dirname, '../../blog/lib/publ.ts'));
const orchestratorRuntime = require(path.join(__dirname, '../../../bots/orchestrator/lib/runtime-config.ts'));
const workerRuntime = require('../lib/runtime-config.ts');
const blogRuntime = require(path.join(__dirname, '../../../bots/blog/lib/runtime-config.ts'));
const claudeConfig = require(path.join(__dirname, '../../../bots/claude/lib/config.ts'));
const {
  buildAttendanceProposal,
  normalizeAttendanceProposal,
} = require('../lib/attendance-ai.ts');

// ── AI 모듈 ───────────────────────────────────────────────────────────
const llmRouter   = require(path.join(__dirname, '../../../packages/core/lib/llm-router.legacy.js'));
const rag         = require(path.join(__dirname, '../../../packages/core/lib/rag-safe.js'));
const { publishToRag } = require(path.join(__dirname, '../../../packages/core/lib/reporting-hub.js'));
const { extractDocument } = require(path.join(__dirname, '../../../packages/core/lib/document-parser.legacy.js'));
const { searchFeedbackCases } = require(path.join(__dirname, '../../../packages/core/lib/feedback-rag.legacy.js'));
const videoApi = require('./routes/video-api');
const videoStepApi = require('./routes/video-step-api');
const videoInternalApi = require('./routes/video-internal-api');
const mountAgentRoutes = require('./routes/agents');
const {
  buildScheduleProposal,
  normalizeScheduleProposal,
} = require('../lib/schedule-ai.ts');
const {
  buildEmployeeProposal,
  normalizeEmployeeProposal,
} = require('../lib/employee-ai.ts');
const {
  buildPayrollProposal,
  normalizePayrollProposal,
} = require('../lib/payroll-ai.ts');
const {
  buildSalesProposal,
  normalizeSalesProposal,
} = require('../lib/sales-ai.ts');
const {
  buildExpenseProposal,
  normalizeExpenseProposal,
} = require('../lib/expenses-ai.ts');
const {
  buildExpenseImportNotice,
  parseExpenseRowsFromXlsxExtraction,
} = require('../lib/expenses-import.ts');
const {
  buildProjectProposal,
  normalizeProjectProposal,
} = require('../lib/project-ai.ts');
const {
  buildJournalProposal,
  normalizeJournalProposal,
} = require('../lib/journal-ai.ts');
const {
  buildDocumentProposal,
  normalizeDocumentProposal,
  detectDocumentCategory,
} = require('../lib/document-ai.ts');
const {
  buildLeaveProposal,
  normalizeLeaveProposal,
} = require('../lib/leave-ai.ts');
const { callLLM, callLLMWithFallback } = require('../lib/ai-client.ts');
const { buildSQLPrompt, buildSummaryPrompt, extractSQL, isSelectOnly, isSafeQuestion, hasOnlyAllowedTables, hasCompanyFilter } = require('../lib/ai-helper.ts');
const {
  parseUnrecognizedQuery,
  parsePromotionQuery,
  buildUnrecognizedSummary,
  buildPromotionFamilySummary,
  getPromotionCandidateStatus,
  getPromotionEventReason,
  normalizeIntentText,
} = require(path.join(__dirname, '../../../packages/core/lib/intent-core.js'));
const {
  getPromotionSummary,
  getPromotionRows,
  getPromotionEvents,
  getUnrecognizedReportRows,
  findPromotionCandidate,
  upsertPromotionCandidate,
  clearPromotedUnrecognized,
  clearPromotionCandidateState,
  markUnrecognizedPromoted,
  logPromotionEvent,
  addLearnedPattern,
  removeLearnedPatterns,
  getNamedIntentLearningPath,
} = require(path.join(__dirname, '../../../packages/core/lib/intent-store.js'));
const {
  ensureChatSchema,
  handleChatMessage,
  listSessions: listChatSessions,
  listMessages: listChatMessages,
  resolveEmployeeId,
} = require('../lib/chat-agent.ts');
const {
  approve: approveApprovalRequest,
  reject: rejectApprovalRequest,
  review: reviewApprovalRequest,
} = require('../lib/approval.ts');
const {
  createWorkerProposalFeedbackSession,
  getWorkerFeedbackSessionById,
  replaceWorkerFeedbackEdits,
  markWorkerFeedbackConfirmed,
  markWorkerFeedbackRejected,
  markWorkerFeedbackSubmitted,
  markWorkerFeedbackCommitted,
} = require('../lib/ai-feedback-service.ts');

// ── 파일 업로드 (multer) ──────────────────────────────────────────────
const multer = require('multer');
const UPLOAD_DIR = path.join(__dirname, '../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.txt', '.csv', '.hwp', '.hwpx',
  '.zip', '.rar', '.7z',
];
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'text/plain', 'text/csv',
  'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
  'application/haansofthwp', 'application/hwp',
];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error(`허용되지 않는 파일 형식입니다: ${ext}`), false);
    }
    if (!ALLOWED_MIME_TYPES.includes(mime)) {
      return cb(new Error(`허용되지 않는 MIME 타입입니다: ${mime}`), false);
    }
    cb(null, true);
  },
});

const SCHEMA = 'worker';
const PORT   = parseInt(process.env.WORKER_PORT || '4000', 10);
const WORKER_INTENT_LEARNINGS_PATH = getNamedIntentLearningPath('worker');

const app = express();
const wsClients = new Set();
let chatWss = null;
let taskEventClient = null;
const AI_AGENT_HOME = process.env.AI_AGENT_HOME
  || process.env.JAY_HOME
  || path.join(os.homedir(), '.ai-agent-system');
const AI_AGENT_WORKSPACE = process.env.AI_AGENT_WORKSPACE
  || process.env.JAY_WORKSPACE
  || path.join(AI_AGENT_HOME, 'workspace');
const LLM_CONTROL_DIR = process.env.HUB_LLM_CONTROL_DIR
  || process.env.JAY_LLM_CONTROL_DIR
  || path.join(AI_AGENT_HOME, 'llm-control');
const SPEED_TEST_LATEST_FILE = path.join(AI_AGENT_WORKSPACE, 'llm-speed-test-latest.json');
const LLM_CONTROL_CONFIG_FILE = process.env.HUB_LLM_CONTROL_CONFIG
  || path.join(LLM_CONTROL_DIR, 'models.json');
const ROOT_DIR = path.join(__dirname, '..', '..', '..', '..');
const SPEED_TEST_REVIEW_SCRIPT = path.join(ROOT_DIR, 'scripts', 'reviews', 'llm-selector-speed-review.js');
const SPEED_TEST_DAILY_SCRIPT = path.join(ROOT_DIR, 'scripts', 'reviews', 'llm-selector-speed-daily.js');
const PROVIDER_MODEL_OPTIONS = {
  openai: [
    { model: 'gpt-5-mini', label: 'gpt-5-mini' },
    { model: 'gpt-4o', label: 'gpt-4o' },
    { model: 'gpt-4o-mini', label: 'gpt-4o-mini' },
  ],
  anthropic: [
    { model: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    { model: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' },
  ],
  gemini: [
    { model: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
    { model: 'google-gemini-cli/gemini-2.5-flash', label: 'google-gemini-cli/gemini-2.5-flash' },
  ],
  groq: [
    { model: 'groq/llama-4-scout-17b-16e-instruct', label: 'groq/llama-4-scout-17b-16e-instruct' },
    { model: 'llama-4-scout-17b-16e-instruct', label: 'llama-4-scout-17b-16e-instruct' },
    { model: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'meta-llama/llama-4-scout-17b-16e-instruct' },
    { model: 'openai/gpt-oss-20b', label: 'openai/gpt-oss-20b' },
    { model: 'qwen/qwen3-32b', label: 'qwen/qwen3-32b' },
  ],
};
const SELECTOR_EDIT_CONFIG = {
  'orchestrator.jay.intent': {
    type: 'intent_pair',
    config: 'bots/orchestrator/config.json',
    path: 'runtime_config.llmSelectorOverrides.orchestrator.jay.intent',
  },
  'orchestrator.jay.chat_fallback': {
    type: 'chain',
    config: 'bots/orchestrator/config.json',
    path: 'runtime_config.llmSelectorOverrides.orchestrator.jay.chat_fallback.chain',
  },
  'worker.ai.fallback': {
    type: 'providerModels',
    config: 'bots/worker/config.json',
    path: 'runtime_config.llmSelectorOverrides.worker.ai.fallback.providerModels',
  },
  'worker.chat.task_intake': {
    type: 'chain',
    config: 'bots/worker/config.json',
    path: 'runtime_config.llmSelectorOverrides.worker.chat.task_intake.chain',
  },
  'claude.archer.tech_analysis': {
    type: 'chain',
    config: 'bots/claude/config.json',
    path: 'runtime_config.llmSelectorOverrides.claude.archer.tech_analysis.chain',
  },
  'claude.lead.system_issue_triage': {
    type: 'chain',
    config: 'bots/claude/config.json',
    path: 'runtime_config.llmSelectorOverrides.claude.lead.system_issue_triage.chain',
  },
  'claude.dexter.ai_analyst.warn': {
    type: 'chain',
    config: 'bots/claude/config.json',
    path: 'runtime_config.llmSelectorOverrides.claude.dexter.ai_analyst.chain',
  },
  'claude.dexter.ai_analyst.critical': {
    type: 'chain',
    config: 'bots/claude/config.json',
    path: 'runtime_config.llmSelectorOverrides.claude.dexter.ai_analyst.chain',
  },
  'blog.pos.writer': {
    type: 'chain',
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.pos.writer.chain',
  },
  'blog.gems.writer': {
    type: 'chain',
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.gems.writer.chain',
  },
  'blog.social.summarize': {
    type: 'chain',
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.social.summarize.chain',
  },
  'blog.social.caption': {
    type: 'chain',
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.social.caption.chain',
  },
  'blog.star.summarize': {
    type: 'chain',
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.star.summarize.chain',
  },
  'blog.star.caption': {
    type: 'chain',
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.star.caption.chain',
  },
  'blog.curriculum.recommend': {
    type: 'chain',
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.curriculum.recommend.chain',
  },
  'blog.curriculum.generate': {
    type: 'chain',
    config: 'bots/blog/config.json',
    path: 'runtime_config.llmSelectorOverrides.blog.curriculum.generate.chain',
  },
};

async function runNodeScriptJson(script, args = [], timeoutMs = 60_000) {
  const root = path.join(__dirname, '..', '..', '..', '..');
  try {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 4,
    });
    if (result.error || result.status !== 0) return null;
    return JSON.parse(result.stdout || 'null');
  } catch {
    return null;
  }
}

function loadLatestSpeedSnapshot() {
  try {
    if (!fs.existsSync(SPEED_TEST_LATEST_FILE)) return null;
    return JSON.parse(fs.readFileSync(SPEED_TEST_LATEST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function loadSpeedTestTargets() {
  try {
    if (!fs.existsSync(LLM_CONTROL_CONFIG_FILE)) return [];
    const config = JSON.parse(fs.readFileSync(LLM_CONTROL_CONFIG_FILE, 'utf8'));
    const models = config?.agents?.defaults?.models || {};
    return Object.keys(models)
      .map((modelId) => {
        const [provider, ...rest] = String(modelId || '').split('/');
        if (!provider || !rest.length) return null;
        return {
          modelId,
          provider,
          label: rest.join('/'),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const providerDiff = a.provider.localeCompare(b.provider);
        if (providerDiff !== 0) return providerDiff;
        return a.label.localeCompare(b.label);
      });
  } catch {
    return [];
  }
}

async function buildSpeedTestConsolePayload() {
  const latest = loadLatestSpeedSnapshot();
  const review = await runNodeScriptJson(SPEED_TEST_REVIEW_SCRIPT, ['--days=7', '--json'], 60_000).catch(() => null);
  const targets = loadSpeedTestTargets();
  const results = Array.isArray(latest?.results)
    ? latest.results.map((item) => ({
        rank: Number(item.rank || 0),
        provider: item.provider || 'unknown',
        modelId: item.modelId || '-',
        label: item.label || item.modelId || '-',
        ttft: item.ttft ?? null,
        total: item.total ?? null,
        ok: item.ok === true,
        error: item.error || null,
      }))
    : [];

  return {
    targets,
    latest: latest
      ? {
          capturedAt: latest.capturedAt || null,
          current: latest.current || null,
          recommended: latest.recommended || null,
          applied: latest.applied || null,
          runs: Number(latest.runs || 0),
          prompt: latest.prompt || null,
        }
      : null,
    review: review
      ? {
          days: Number(review.days || 7),
          snapshotCount: Number(review.snapshotCount || 0),
          latestCapturedAt: review.latestCapturedAt || null,
          currentPrimary: review.currentPrimary || null,
          latestRecommended: review.latestRecommended || null,
          recommendation: review.recommendation || 'observe',
          topModels: Array.isArray(review.topModels) ? review.topModels.slice(0, 5) : [],
        }
      : null,
    results,
    summary: {
      targetCount: targets.length,
      resultCount: results.length,
      successCount: results.filter((item) => item.ok).length,
      failedCount: results.filter((item) => !item.ok).length,
    },
  };
}

async function getInvestmentPolicyOverrideSafe() {
  try {
    const moduleUrl = pathToFileURL(path.join(__dirname, '../../investment/shared/runtime-config.js')).href;
    const mod = await import(moduleUrl);
    return mod.getInvestmentLLMPolicyConfig().investmentAgentPolicy || null;
  } catch {
    return null;
  }
}

function getByPath(target, pathString) {
  return String(pathString || '').split('.').filter(Boolean).reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), target);
}

function setByPath(target, pathString, value) {
  const parts = String(pathString || '').split('.').filter(Boolean);
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function dedupeChain(chain = []) {
  const seen = new Set();
  return chain.filter((entry) => {
    const key = `${entry?.provider || ''}:${entry?.model || ''}`;
    if (!entry?.provider || !entry?.model || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildPrimaryChainEntry(provider, model, currentChain = []) {
  const exact = currentChain.find((entry) => entry?.provider === provider && entry?.model === model);
  if (exact) return { ...exact };
  const sameProvider = currentChain.find((entry) => entry?.provider === provider);
  return {
    provider,
    model,
    ...(sameProvider?.maxTokens ? { maxTokens: sameProvider.maxTokens } : {}),
    ...(sameProvider?.temperature != null ? { temperature: sameProvider.temperature } : {}),
  };
}

function buildReorderedChain(currentChain = [], provider, model) {
  const primary = buildPrimaryChainEntry(provider, model, currentChain);
  const rest = currentChain.filter((entry) => !(entry?.provider === provider && entry?.model === model));
  return dedupeChain([primary, ...rest]);
}

function resolveConfigAbsolutePath(relativePath) {
  return path.join(ROOT_DIR, relativePath);
}

function buildSelectorEditorCatalog(globalSelectorSummary) {
  const catalog = {};
  for (const group of globalSelectorSummary?.groups || []) {
    for (const entry of group.entries || []) {
      const mapping = SELECTOR_EDIT_CONFIG[entry.key] || null;
      const primary = (entry.chain || []).find((item) => item.role === 'primary') || null;
      catalog[entry.key] = {
        team: group.title,
        key: entry.key,
        label: entry.label,
        editable: Boolean(mapping),
        editType: mapping?.type || null,
        configPath: mapping?.config || null,
        runtimePath: mapping?.path || null,
        currentProvider: primary?.provider || null,
        currentModel: primary?.model || null,
        roleOptions: (entry.chain || []).map((item) => ({
          role: item.role,
          label: item.role === 'primary' ? 'Primary' : item.role.toUpperCase(),
          provider: item.provider || null,
          model: item.model || null,
        })),
        providerOptions: Object.keys(PROVIDER_MODEL_OPTIONS).map((provider) => ({
          key: provider,
          label: API_CATALOG[provider]?.label || provider,
        })),
        modelOptionsByProvider: PROVIDER_MODEL_OPTIONS,
      };
    }
  }
  return catalog;
}

async function extractUploadedDocument({ absolutePath, filename, mimeType }) {
  try {
    return await extractDocument({
      filePath: absolutePath,
      originalName: filename,
      mimeType,
    });
  } catch (error) {
    return {
      text: '',
      metadata: {
        extractionMethod: 'extractor_failed',
        pageCount: 0,
        extractedTextLength: 0,
        extractionWarnings: ['extractor_failed'],
        sourceFileType: path.extname(filename || '').replace(/^\./, '') || 'unknown',
        chunkStrategy: 'document',
        chunkWarnings: [String(error.message || error)],
        analysisReadyTextLength: 0,
        sourceConfidence: 0,
      },
    };
  }
}

function buildDocumentRagText({ category, filename, summary, extractionText }) {
  const parts = [`[${category || '기타'}] ${filename}`];
  if (summary) parts.push(summary);
  if (extractionText) parts.push(String(extractionText).slice(0, 12000));
  return parts.filter(Boolean).join('\n\n').trim();
}

async function publishWorkerRagEntry({
  collection,
  sourceBot,
  eventType,
  message,
  payload,
  metadata,
  content,
  dedupeKey,
  cooldownMs = 30 * 60 * 1000,
}) {
  await publishToRag({
    ragStore: {
      async store(targetCollection, ragContent, targetMetadata = {}, targetSourceBot = sourceBot) {
        return rag.store(targetCollection, ragContent, targetMetadata, targetSourceBot);
      },
    },
    collection,
    sourceBot,
    event: {
      from_bot: sourceBot,
      team: 'worker',
      event_type: eventType,
      alert_level: 1,
      message,
      payload,
    },
    metadata,
    contentBuilder: () => String(content || ''),
    policy: {
      dedupe: true,
      key: dedupeKey,
      cooldownMs,
    },
  });
}

function buildExtractionPreview(text = '', maxLength = 4000) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n...(중략)`;
}

function scoreUploadedFilename(value = '') {
  const text = String(value || '');
  if (!text) return -100;
  let score = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0xac00 && code <= 0xd7a3) || /[A-Za-z0-9._()[\]\- ]/.test(ch)) {
      score += 2;
    } else if (code < 32 || code === 0xfffd) {
      score -= 6;
    } else {
      score -= 1;
    }
  }
  return score;
}

function normalizeUploadedFilename(rawName) {
  const original = String(rawName || '').trim();
  if (!original) return '';
  try {
    const decoded = Buffer.from(original, 'latin1').toString('utf8').trim();
    if (!decoded || decoded.includes('\uFFFD')) return original;
    return scoreUploadedFilename(decoded) >= scoreUploadedFilename(original) ? decoded : original;
  } catch {
    return original;
  }
}

function buildDeterministicSummary(extraction = {}) {
  const lines = String(extraction.text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  return lines.join(' / ').slice(0, 240);
}

function buildDocumentQualitySummary(metadata = {}) {
  const sourceFileType = String(metadata.sourceFileType || '').trim();
  const extractionMethod = String(metadata.extractionMethod || '').trim();
  const textLength = Math.max(0, Number(metadata.analysisReadyTextLength || 0));
  const qualitySeverity = String(metadata.imageQualitySeverity || 'none').trim();
  const conservative = Boolean(metadata.imageConservativeHandling);
  const sparse = Boolean(metadata.imageEstimatedSparseText);
  const lowQuality = Boolean(metadata.imageEstimatedLowQuality);
  const warnings = Array.isArray(metadata.imageOcrWarnings) && metadata.imageOcrWarnings.length
    ? metadata.imageOcrWarnings
    : Array.isArray(metadata.extractionWarnings) ? metadata.extractionWarnings : [];
  const reasons = [];

  let status = 'good';
  let label = '재사용 양호';

  if (extractionMethod === 'extractor_failed' || textLength <= 0) {
    status = 'needs_review';
    label = '검토 필요';
    reasons.push('파싱 텍스트가 없거나 추출이 실패했습니다.');
  } else if (sourceFileType === 'image' && (qualitySeverity === 'high' || lowQuality)) {
    status = 'needs_review';
    label = '검토 필요';
    reasons.push('이미지 OCR 품질이 낮아 재사용 전 원문 확인이 필요합니다.');
  } else if (
    textLength < 80
    || (sourceFileType === 'image' && (qualitySeverity === 'medium' || qualitySeverity === 'low' || conservative || sparse))
  ) {
    status = 'watch';
    label = '재사용 주의';
    if (textLength < 80) reasons.push('추출 텍스트가 짧아 업무 초안 품질이 낮을 수 있습니다.');
    if (sourceFileType === 'image' && (qualitySeverity === 'medium' || qualitySeverity === 'low' || conservative || sparse)) {
      reasons.push('이미지 문서라 보수적 해석 규칙을 함께 확인하는 것이 좋습니다.');
    }
  }

  if (!reasons.length && warnings.length) {
    reasons.push(`추출 경고: ${warnings.join(', ')}`);
  }

  return {
    status,
    label,
    reasons: reasons.slice(0, 2),
    textLength,
    sourceFileType: sourceFileType || 'unknown',
    extractionMethod: extractionMethod || 'unknown',
    imageQualitySeverity: qualitySeverity,
    conservative,
  };
}

function buildDocumentEfficiencySummary(document = {}) {
  const qualitySummary = document.quality_summary || buildDocumentQualitySummary(document.extraction_metadata || {});
  const totalReuseCount = Math.max(0, Number(document.total_reuse_count || 0));
  const linkedReuseCount = Math.max(0, Number(document.linked_reuse_count || 0));
  const reviewedCount = Math.max(0, Number(document.reviewed_reuse_count || 0));
  const acceptedWithoutEditCount = Math.max(0, Number(document.accepted_without_edit_count || 0));
  const editedSessionCount = Math.max(0, Number(document.edited_session_count || 0));
  const avgEditCount = reviewedCount > 0
    ? Number(document.avg_edit_count || 0)
    : 0;
  const conversionRate = totalReuseCount > 0 ? linkedReuseCount / totalReuseCount : 0;
  const acceptedWithoutEditRate = reviewedCount > 0 ? acceptedWithoutEditCount / reviewedCount : 0;

  let score = 50;
  if (qualitySummary.status === 'good') score += 18;
  else if (qualitySummary.status === 'watch') score += 6;
  else score -= 18;

  score += conversionRate * 20;
  score += acceptedWithoutEditRate * 18;
  score += Math.min(totalReuseCount, 10) * 1.2;
  score -= Math.min(avgEditCount, 8) * 3;
  score -= editedSessionCount > 0 ? Math.min(editedSessionCount, 6) * 1.2 : 0;

  const normalized = Math.max(0, Math.min(100, Math.round(score)));
  let status = 'strong';
  let label = '효율 높음';
  if (normalized < 45) {
    status = 'improve';
    label = '개선 필요';
  } else if (normalized < 70) {
    status = 'watch';
    label = '효율 보통';
  }

  const reasons = [];
  if (qualitySummary.status === 'needs_review') reasons.push('품질 경고가 있어 재사용 효율 상한이 낮습니다.');
  if (acceptedWithoutEditRate >= 0.7 && reviewedCount > 0) reasons.push('무수정 확정률이 높아 실무 전환이 안정적입니다.');
  if (avgEditCount >= 2.5 && reviewedCount > 0) reasons.push('확정 전 수정량이 커서 템플릿 보강이 필요합니다.');
  if (conversionRate >= 0.6 && totalReuseCount >= 3) reasons.push('재사용이 실제 업무 연결로 잘 이어지고 있습니다.');
  if (!reasons.length && totalReuseCount === 0) reasons.push('아직 재사용 표본이 충분하지 않습니다.');

  return {
    score: normalized,
    status,
    label,
    totalReuseCount,
    linkedReuseCount,
    reviewedCount,
    acceptedWithoutEditCount,
    acceptedWithoutEditRate: Math.round(acceptedWithoutEditRate * 100),
    conversionRate: Math.round(conversionRate * 100),
    avgEditCount: reviewedCount > 0 ? Number(avgEditCount.toFixed(1)) : 0,
    reasons: reasons.slice(0, 2),
  };
}

function compareDocumentRows(a, b, sort = 'recent') {
  const createdDiff = new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  const totalA = Number(a.total_reuse_count || 0);
  const totalB = Number(b.total_reuse_count || 0);
  const linkedA = Number(a.linked_reuse_count || 0);
  const linkedB = Number(b.linked_reuse_count || 0);
  const conversionA = totalA > 0 ? linkedA / totalA : 0;
  const conversionB = totalB > 0 ? linkedB / totalB : 0;
  const qualityRank = { needs_review: 3, watch: 2, good: 1 };
  const qualityA = qualityRank[String(a.quality_summary?.status || 'good')] || 0;
  const qualityB = qualityRank[String(b.quality_summary?.status || 'good')] || 0;
  const efficiencyA = Number(a.efficiency_summary?.score || 0);
  const efficiencyB = Number(b.efficiency_summary?.score || 0);

  if (sort === 'reuse') return totalB - totalA || createdDiff;
  if (sort === 'linked') return linkedB - linkedA || createdDiff;
  if (sort === 'conversion') return conversionB - conversionA || linkedB - linkedA || createdDiff;
  if (sort === 'quality') return qualityB - qualityA || createdDiff;
  if (sort === 'efficiency') return efficiencyB - efficiencyA || conversionB - conversionA || createdDiff;
  return createdDiff;
}

function sendWs(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* 무시 */
  }
}

function broadcastTaskEvent(event) {
  for (const ws of wsClients) {
    if (ws.readyState !== 1 || !ws.user) continue;
    if (event.companyId && ws.companyId !== event.companyId) continue;
    if (event.userId && Number(ws.user.id) !== Number(event.userId)) continue;
    sendWs(ws, { type: 'chat.task_result', ...event });
  }
}

// ── 보안 미들웨어 ─────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Next.js 필요
      styleSrc:        ["'self'", "'unsafe-inline'"],
      imgSrc:          ["'self'", 'data:', 'blob:'],
      connectSrc:      ["'self'", 'http://localhost:4000', 'http://localhost:4001'],
      fontSrc:         ["'self'"],
      objectSrc:       ["'none'"],
      frameAncestors:  ["'none'"], // 클릭재킹 방지
    },
  },
  crossOriginEmbedderPolicy: false, // Next.js 호환
}));
app.use(cors({ origin: true, credentials: true })); // 모든 origin 허용 (내부 서버)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => (
    req.path === '/api/health'
    || req.path === '/api/auth/me'
    || req.path === '/api/auth/login'
  ),
  handler: (req, res) => res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', code: 'RATE_LIMIT' }),
});
app.use('/api/', limiter);
app.use('/api/video/internal', express.json({ limit: '5mb' }), videoInternalApi);
app.use('/api/video/steps', requireAuth, videoStepApi);
app.use('/api/video', requireAuth, videoApi);
mountAgentRoutes(app, requireAuth);

// ── 접근 로그 (OWASP) — 모든 라우트 앞에 배치 ─────────────────────
app.use(accessLogger);

// 로그인 엔드포인트는 더 엄격한 Rate Limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  handler: (req, res) => res.status(429).json({ error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.', code: 'RATE_LIMIT' }),
});
app.use('/api/auth/login', loginLimiter);

// AI 전용 Rate Limit (1분 10회)
const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'AI 질문은 1분에 10회까지 가능합니다.', code: 'AI_RATE_LIMIT' }),
});
app.use('/api/ai/', aiLimiter);

// ── 정적 파일 / 루트 리다이렉트 ──────────────────────────────────────
app.get('/', (req, res) => {
  const uiBase = process.env.WORKER_WEB_URL || `${req.protocol}://${req.hostname}:4001`;
  res.redirect(`${uiBase}/dashboard`);
});

const UI_ROUTE_PREFIXES = [
  '/dashboard',
  '/attendance',
  '/schedules',
  '/journals',
  '/work-journals',
  '/sales',
  '/projects',
  '/video',
  '/employees',
  '/payroll',
  '/settings',
  '/ai',
  '/approvals',
  '/login',
  '/change-password',
  '/documents',
  '/chat',
  '/admin',
];

app.get('*', (req, res, next) => {
  if (req.path === '/' || req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
    return next();
  }
  if (!UI_ROUTE_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
    return next();
  }

  const uiBase = process.env.WORKER_WEB_URL || `${req.protocol}://${req.hostname}:4001`;
  return res.redirect(`${uiBase}${req.originalUrl}`);
});

// ── 유틸 ─────────────────────────────────────────────────────────────
function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: '입력값이 올바르지 않습니다.', code: 'INVALID_INPUT', details: errors.array().map(e => e.msg) });
    return false;
  }
  return true;
}

function getKstToday() {
  return kst.today();
}

function getEndOfMonthStr(yearMonth) {
  const [year, month] = String(yearMonth || '').split('-').map(Number);
  if (!year || !month) return null;
  const first = new Date(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01T00:00:00+09:00`);
  first.setUTCMonth(first.getUTCMonth() + 1);
  first.setUTCDate(0);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(first.getUTCDate()).padStart(2, '0')}`;
}

async function buildWorkerMonitoringPayload(user) {
  const selectedApi = await getWorkerMonitoringPreference();
  const company = user?.company_id ? await getCompanyAiPolicy(user.company_id) : null;
  const aiPolicy = resolveAiPolicy({ user, company });
  const emptyUsageSummary = {
    periodHours: 24,
    totalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    successRatePct: 0,
    totalCostUsd: 0,
    avgLatencyMs: null,
    latestCallAt: null,
    byProvider: [],
    byRoute: [],
  };
  const [changeHistory, usageSummary, changeImpact] = await Promise.all([
    getWorkerMonitoringChangeHistory(8),
    getWorkerMonitoringUsageSummary().catch(() => emptyUsageSummary),
    getWorkerMonitoringChangeImpact(3, 12).catch(() => []),
  ]);
  const globalSelectorSummary = await getGlobalSelectorSummary().catch(() => null);
  const speedTestConsole = await buildSpeedTestConsolePayload().catch(() => ({
    targets: [],
    latest: null,
    review: null,
    results: [],
    summary: { targetCount: 0, resultCount: 0, successCount: 0, failedCount: 0 },
  }));

  return {
    selected_api: selectedApi,
    selected_api_label: API_CATALOG[selectedApi]?.label || selectedApi,
    options: buildProviderOptions(),
    ai_policy: aiPolicy,
    application_summary: getWorkerLlmApplicationSummary(selectedApi),
    selector_summary: getWorkerSelectorSummary(selectedApi),
    global_selector_summary: globalSelectorSummary,
    selector_editors: buildSelectorEditorCatalog(globalSelectorSummary),
    speed_test_console: speedTestConsole,
    change_history: changeHistory.map((item) => {
      const previousApi = String(item.previous_value?.selected_api || '').trim().toLowerCase();
      const nextApi = String(item.next_value?.selected_api || '').trim().toLowerCase();
      return {
        id: item.id,
        previous_api: previousApi || null,
        next_api: nextApi || null,
        previous_api_label: API_CATALOG[previousApi]?.label || previousApi || '초기값',
        next_api_label: API_CATALOG[nextApi]?.label || nextApi || '-',
        change_note: item.change_note || '',
        changed_at: item.changed_at,
        changed_by_name: item.changed_by_name,
        changed_by_role: item.changed_by_role,
      };
    }),
    change_impact: changeImpact.map((item) => ({
      id: item.id,
      previous_api: item.previousApi || null,
      next_api: item.nextApi || null,
      previous_api_label: API_CATALOG[item.previousApi]?.label || item.previousApi || '초기값',
      next_api_label: API_CATALOG[item.nextApi]?.label || item.nextApi || '-',
      change_note: item.changeNote || '',
      changed_at: item.changedAt,
      window_hours: item.windowHours,
      enough_data: item.enoughData,
      success_rate_delta_pct: item.successRateDeltaPct,
      avg_latency_delta_ms: item.avgLatencyDeltaMs,
      before: item.before,
      after: item.after,
    })),
    usage_summary: usageSummary,
  };
}

async function buildBlogPublishedUrlPayload(limit = 100) {
  const todayKst = kst.today();
  const rows = await pgPool.query('blog', `
    SELECT
      p.id,
      p.title,
      p.status,
      p.naver_url,
      p.publish_date,
      p.created_at,
      COALESCE(s.status, '') AS schedule_status
    FROM blog.posts p
    LEFT JOIN blog.publish_schedule s
      ON s.id = CASE
        WHEN COALESCE(p.metadata->>'schedule_id', '') ~ '^[0-9]+$'
          THEN (p.metadata->>'schedule_id')::int
        ELSE NULL
      END
    WHERE p.id NOT IN (34, 36, 38)
      AND COALESCE(NULLIF(p.metadata->>'exclude_from_reference', '')::boolean, false) = false
      AND p.status IN ('ready', 'published')
      AND COALESCE(s.status, '') <> 'archived'
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);

  const normalizedRows = rows.map((row) => {
    let publishDate = null;
    if (row.publish_date instanceof Date) {
      publishDate = row.publish_date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    } else if (row.publish_date) {
      const parsed = new Date(row.publish_date);
      publishDate = Number.isNaN(parsed.getTime())
        ? String(row.publish_date).slice(0, 10)
        : parsed.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    }
    const hasActiveSchedule = row.schedule_status === 'scheduled'
      || row.schedule_status === 'writing'
      || row.schedule_status === 'ready';
    const isReadyWithoutUrl = row.status === 'ready' && hasActiveSchedule && !row.naver_url;
    const publishDue = Boolean(isReadyWithoutUrl && publishDate && publishDate <= todayKst);
    const needsUrl = Boolean((row.status === 'published' && !row.naver_url) || publishDue);
    const scheduled = Boolean(isReadyWithoutUrl && !publishDue);

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      naver_url: row.naver_url,
      publish_date: publishDate,
      created_at: row.created_at,
      needs_url: needsUrl,
      scheduled,
      publish_due: publishDue,
    };
  });

  return {
    rows: normalizedRows,
    summary: {
      total: normalizedRows.length,
      missingUrl: normalizedRows.filter((row) => row.needs_url).length,
      scheduled: normalizedRows.filter((row) => row.scheduled).length,
      published: normalizedRows.filter((row) => row.status === 'published').length,
    },
  };
}

function summarizeSelectorDescription(description) {
  if (!description) return [];
  if (description.kind === 'chain') {
    return (description.chain || []).map((entry, index) => ({
      role: index === 0 ? 'primary' : `fallback${index}`,
      provider: entry.provider,
      model: entry.model,
    }));
  }
  const policy = description.policy || {};
  const chain = [];
  if (policy.primary) {
    chain.push({
      role: 'primary',
      provider: policy.primary.provider,
      model: policy.primary.model,
    });
  }
  for (const [index, entry] of (policy.fallbacks || []).entries()) {
    chain.push({
      role: `fallback${index + 1}`,
      provider: entry.provider,
      model: entry.model,
    });
  }
  return chain;
}

function buildSelectorGroup(title, entries) {
  return {
    title,
    entries: entries.map((entry) => ({
      key: entry.key,
      label: entry.label,
      chain: summarizeSelectorDescription(entry.description),
      advice: entry.advice || null,
    })),
  };
}

async function describeRuntimeSelectorByKey(key) {
  const jayOverrides = orchestratorRuntime.getLLMSelectorOverrides();
  const workerOverrides = workerRuntime.getWorkerLLMSelectorOverrides();
  const blogOverrides = blogRuntime.getBlogLLMSelectorOverrides();
  const claudeOverrides = claudeConfig.RUNTIME?.llmSelectorOverrides || {};
  const workerPreferredApi = await getWorkerMonitoringPreference().catch(() => 'groq');
  const investmentPolicyOverride = await getInvestmentPolicyOverrideSafe();

  switch (key) {
    case 'orchestrator.jay.intent':
      return describeLLMSelector(key, { policyOverride: jayOverrides[key] });
    case 'orchestrator.jay.chat_fallback':
      return describeLLMSelector(key, { policyOverride: jayOverrides[key] });
    case 'worker.ai.fallback':
      return describeLLMSelector(key, {
        preferredApi: workerPreferredApi,
        configuredProviders: ['groq', 'anthropic', 'gemini', 'openai'],
        policyOverride: workerOverrides[key],
      });
    case 'worker.chat.task_intake':
      return describeLLMSelector(key, { policyOverride: workerOverrides[key] });
    case 'claude.archer.tech_analysis':
    case 'claude.lead.system_issue_triage':
      return describeLLMSelector(key, { policyOverride: claudeOverrides[key] });
    case 'claude.dexter.ai_analyst.warn':
      return describeLLMSelector('claude.dexter.ai_analyst', {
        level: 2,
        policyOverride: claudeOverrides['claude.dexter.ai_analyst'] || null,
      });
    case 'claude.dexter.ai_analyst.critical':
      return describeLLMSelector('claude.dexter.ai_analyst', {
        level: 4,
        policyOverride: claudeOverrides['claude.dexter.ai_analyst'] || null,
      });
    case 'blog.pos.writer':
    case 'blog.gems.writer':
    case 'blog.social.summarize':
    case 'blog.social.caption':
    case 'blog.star.summarize':
    case 'blog.star.caption':
    case 'blog.curriculum.recommend':
    case 'blog.curriculum.generate':
      return describeLLMSelector(key, { policyOverride: blogOverrides[key] });
    default:
      if (key.startsWith('investment.')) {
        const agentName = key.split('.')[1];
        return describeLLMSelector('investment.agent_policy', {
          agentName,
          policyOverride: investmentPolicyOverride,
        });
      }
      throw new Error(`지원하지 않는 selector key: ${key}`);
  }
}

function buildUpdatedSelectorValue(key, editType, provider, model, description, role = 'primary') {
  const currentChain = Array.isArray(description?.chain) ? description.chain : [];
  const normalizedRole = String(role || 'primary').trim().toLowerCase();
  const targetIndex = normalizedRole === 'primary'
    ? 0
    : Math.max(1, Number.parseInt(normalizedRole.replace('fallback', ''), 10) || 1);

  if (editType === 'providerModels') {
    const reordered = buildReorderedChain(currentChain, provider, model);
    const nextChain = reordered.map((entry, index) => (
      index === targetIndex
        ? buildPrimaryChainEntry(provider, model, currentChain)
        : entry
    ));
    const providerModels = dedupeChain(nextChain).reduce((acc, entry) => {
      if (entry?.provider && entry?.model) acc[entry.provider] = entry.model;
      return acc;
    }, {});
    return providerModels;
  }

  if (editType === 'singleModel') {
    return model;
  }

  if (editType === 'intent_pair') {
    const nextChain = currentChain.length
      ? currentChain.map((entry, index) => (
          index === targetIndex ? buildPrimaryChainEntry(provider, model, currentChain) : entry
        ))
      : [{ provider, model }];
    const reordered = dedupeChain(nextChain);
    return {
      primary: reordered[0]
        ? { provider: reordered[0].provider, model: reordered[0].model }
        : null,
      fallback: reordered[1]
        ? { provider: reordered[1].provider, model: reordered[1].model }
        : null,
    };
  }

  if (!currentChain.length) {
    return [{ provider, model }];
  }
  const nextChain = currentChain.map((entry, index) => (
    index === targetIndex ? buildPrimaryChainEntry(provider, model, currentChain) : entry
  ));
  return dedupeChain(nextChain);
}

async function getGlobalSelectorSummary() {
  const jayOverrides = orchestratorRuntime.getLLMSelectorOverrides();
  const workerOverrides = workerRuntime.getWorkerLLMSelectorOverrides();
  const blogOverrides = blogRuntime.getBlogLLMSelectorOverrides();
  const claudeOverrides = claudeConfig.RUNTIME?.llmSelectorOverrides || {};
  const workerPreferredApi = await getWorkerMonitoringPreference().catch(() => 'groq');
  const investmentPolicyOverride = await getInvestmentPolicyOverrideSafe();
  const speedSnapshot = loadLatestSpeedSnapshot();
  const speedLookup = buildSpeedLookup(speedSnapshot);
  const payload = {
    speedTest: speedSnapshot,
    jay: {
      intent: describeLLMSelector('orchestrator.jay.intent', {
        policyOverride: jayOverrides['orchestrator.jay.intent'],
      }),
      chatFallback: describeLLMSelector('orchestrator.jay.chat_fallback', {
        policyOverride: jayOverrides['orchestrator.jay.chat_fallback'],
      }),
    },
    worker: {
      preferredApi: workerPreferredApi,
      aiFallback: describeLLMSelector('worker.ai.fallback', {
        preferredApi: workerPreferredApi,
        configuredProviders: ['groq', 'anthropic', 'gemini', 'openai'],
        policyOverride: workerOverrides['worker.ai.fallback'],
      }),
      taskIntake: describeLLMSelector('worker.chat.task_intake', {
        policyOverride: workerOverrides['worker.chat.task_intake'],
      }),
    },
    claude: {
      archer: describeLLMSelector('claude.archer.tech_analysis', {
        policyOverride: claudeOverrides['claude.archer.tech_analysis'],
      }),
      lead: describeLLMSelector('claude.lead.system_issue_triage', {
        policyOverride: claudeOverrides['claude.lead.system_issue_triage'],
      }),
      dexterWarn: describeLLMSelector('claude.dexter.ai_analyst', {
        level: 2,
        policyOverride: claudeOverrides['claude.dexter.ai_analyst'] || null,
      }),
      dexterCritical: describeLLMSelector('claude.dexter.ai_analyst', {
        level: 4,
        policyOverride: claudeOverrides['claude.dexter.ai_analyst'] || null,
      }),
    },
    blog: {
      pos: describeLLMSelector('blog.pos.writer', {
        policyOverride: blogOverrides['blog.pos.writer'],
      }),
      gems: describeLLMSelector('blog.gems.writer', {
        policyOverride: blogOverrides['blog.gems.writer'],
      }),
      socialSummarize: describeLLMSelector('blog.social.summarize', {
        policyOverride: blogOverrides['blog.social.summarize'],
      }),
      socialCaption: describeLLMSelector('blog.social.caption', {
        policyOverride: blogOverrides['blog.social.caption'],
      }),
      starSummarize: describeLLMSelector('blog.star.summarize', {
        policyOverride: blogOverrides['blog.star.summarize'],
      }),
      starCaption: describeLLMSelector('blog.star.caption', {
        policyOverride: blogOverrides['blog.star.caption'],
      }),
      curriculumRecommend: describeLLMSelector('blog.curriculum.recommend', {
        policyOverride: blogOverrides['blog.curriculum.recommend'],
      }),
      curriculumGenerate: describeLLMSelector('blog.curriculum.generate', {
        policyOverride: blogOverrides['blog.curriculum.generate'],
      }),
    },
    investment: Object.fromEntries(
      ['luna', 'nemesis', 'oracle', 'hermes', 'sophia', 'zeus', 'athena', 'argos']
        .map((agent) => [agent, describeLLMSelector('investment.agent_policy', {
          agentName: agent,
          policyOverride: investmentPolicyOverride,
        })])
    ),
  };
  payload.advice = {
    jay: {
      intent: buildSelectorAdvice(payload.jay.intent, speedLookup),
      chatFallback: buildSelectorAdvice(payload.jay.chatFallback, speedLookup),
    },
    worker: {
      aiFallback: buildSelectorAdvice(payload.worker.aiFallback, speedLookup),
      taskIntake: buildSelectorAdvice(payload.worker.taskIntake, speedLookup),
    },
    claude: {
      archer: buildSelectorAdvice(payload.claude.archer, speedLookup),
      lead: buildSelectorAdvice(payload.claude.lead, speedLookup),
      dexterWarn: buildSelectorAdvice(payload.claude.dexterWarn, speedLookup),
      dexterCritical: buildSelectorAdvice(payload.claude.dexterCritical, speedLookup),
    },
    blog: {
      pos: buildSelectorAdvice(payload.blog.pos, speedLookup),
      gems: buildSelectorAdvice(payload.blog.gems, speedLookup),
      socialSummarize: buildSelectorAdvice(payload.blog.socialSummarize, speedLookup),
      socialCaption: buildSelectorAdvice(payload.blog.socialCaption, speedLookup),
      starSummarize: buildSelectorAdvice(payload.blog.starSummarize, speedLookup),
      starCaption: buildSelectorAdvice(payload.blog.starCaption, speedLookup),
      curriculumRecommend: buildSelectorAdvice(payload.blog.curriculumRecommend, speedLookup),
      curriculumGenerate: buildSelectorAdvice(payload.blog.curriculumGenerate, speedLookup),
    },
    investment: Object.fromEntries(
      Object.entries(payload.investment || {}).map(([agent, description]) => [
        agent,
        buildSelectorAdvice(description, speedLookup),
      ]),
    ),
  };
  const overrideSuggestionPayload = await runNodeScriptJson(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'llm-selector-override-suggestions.js'),
    ['--json'],
    60_000,
  ).catch(() => null);

  return {
    speed_test: payload.speedTest
      ? {
          captured_at: payload.speedTest.capturedAt || null,
          current: payload.speedTest.current || null,
          recommended: payload.speedTest.recommended || null,
        }
      : null,
    override_suggestions: {
      count: Number(overrideSuggestionPayload?.count || 0),
      suggestions: Array.isArray(overrideSuggestionPayload?.suggestions)
        ? overrideSuggestionPayload.suggestions.slice(0, 6)
        : [],
    },
    groups: [
      buildSelectorGroup('Jay', [
        { key: 'orchestrator.jay.intent', label: 'Intent', description: payload.jay?.intent, advice: payload.advice?.jay?.intent || null },
        { key: 'orchestrator.jay.chat_fallback', label: 'Chat Fallback', description: payload.jay?.chatFallback, advice: payload.advice?.jay?.chatFallback || null },
      ]),
      buildSelectorGroup('Worker', [
        { key: 'worker.ai.fallback', label: 'AI Fallback', description: payload.worker?.aiFallback, advice: payload.advice?.worker?.aiFallback || null },
        { key: 'worker.chat.task_intake', label: 'Task Intake', description: payload.worker?.taskIntake, advice: payload.advice?.worker?.taskIntake || null },
      ]),
      buildSelectorGroup('Claude', [
        { key: 'claude.archer.tech_analysis', label: 'Archer', description: payload.claude?.archer, advice: payload.advice?.claude?.archer || null },
        { key: 'claude.lead.system_issue_triage', label: 'Lead', description: payload.claude?.lead, advice: payload.advice?.claude?.lead || null },
        { key: 'claude.dexter.ai_analyst.warn', label: 'Dexter Warn', description: payload.claude?.dexterWarn, advice: payload.advice?.claude?.dexterWarn || null },
        { key: 'claude.dexter.ai_analyst.critical', label: 'Dexter Critical', description: payload.claude?.dexterCritical, advice: payload.advice?.claude?.dexterCritical || null },
      ]),
      buildSelectorGroup('Blog', [
        { key: 'blog.pos.writer', label: 'POS Writer', description: payload.blog?.pos, advice: payload.advice?.blog?.pos || null },
        { key: 'blog.gems.writer', label: 'GEMS Writer', description: payload.blog?.gems, advice: payload.advice?.blog?.gems || null },
        { key: 'blog.social.summarize', label: 'Social Summarize', description: payload.blog?.socialSummarize, advice: payload.advice?.blog?.socialSummarize || null },
        { key: 'blog.social.caption', label: 'Social Caption', description: payload.blog?.socialCaption, advice: payload.advice?.blog?.socialCaption || null },
      ]),
      buildSelectorGroup('Investment', Object.entries(payload.investment || {}).map(([agent, description]) => ({
        key: `investment.${agent}`,
        label: agent,
        description,
        advice: payload.advice?.investment?.[agent] || null,
      }))),
    ],
  };
}

function pagination(req, options = {}) {
  const maxLimit = Math.max(1, parseInt(options.maxLimit || '100', 10));
  const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit = Math.min(maxLimit, parseInt(req.query.limit || '20', 10));
  const sort  = /^\w+$/.test(req.query.sort || 'created_at') ? (req.query.sort || 'created_at') : 'created_at';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  return { page, limit, offset: (page - 1) * limit, sort, order };
}

async function getCompanyAiPolicy(companyId) {
  if (!companyId) return null;
  return pgPool.get(SCHEMA, `
    SELECT
      id,
      enabled_menus,
      ai_member_ui_mode,
      ai_admin_ui_mode,
      ai_member_llm_mode,
      ai_admin_llm_mode,
      ai_confirmation_mode,
      ai_allow_admin_llm_toggle
    FROM worker.companies
    WHERE id = $1
      AND deleted_at IS NULL
  `, [companyId]);
}

async function buildUserResponse(user) {
  const company = user.role === 'master' ? null : await getCompanyAiPolicy(user.company_id);
  const ai_policy = resolveAiPolicy({ user, company });
  const menu_policy = getMenuPolicyForRole(user.role);

  return {
    ...user,
    enabled_menus: user.role === 'master' ? null : (company?.enabled_menus ?? null),
    ai_policy,
    menu_policy,
  };
}

async function resolveRuntimeAiPolicy(user) {
  const company = user.role === 'master' ? null : await getCompanyAiPolicy(user.company_id);
  return resolveAiPolicy({ user, company });
}

async function getEmployeeIdForRequest(req) {
  return resolveEmployeeId(req.user.id);
}

async function resolveAttendanceEmployee(req, employeeId = null) {
  if (employeeId && req.user.role !== 'member') {
    const target = await pgPool.get(SCHEMA, `
      SELECT id, company_id, name
      FROM worker.employees
      WHERE id=$1
        AND deleted_at IS NULL
    `, [employeeId]);
    if (!target || String(target.company_id) !== String(req.user.company_id)) {
      throw new Error('직원 정보를 찾을 수 없습니다.');
    }
    return { id: target.id, name: target.name };
  }

  const emp = await pgPool.get(SCHEMA, `
    SELECT id, name
    FROM worker.employees
    WHERE company_id=$1
      AND user_id=$2
      AND deleted_at IS NULL
  `, [req.user.company_id, req.user.id]);

  if (!emp) throw new Error('연결된 직원 정보가 없습니다.');
  return emp;
}

function getAttendanceStatusForCheckin(occurredAt) {
  const date = new Date(occurredAt);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find(part => part.type === 'minute')?.value || '0');
  if (hour > 9 || (hour === 9 && minute > 0)) return 'late';
  return 'present';
}

async function applyAttendanceProposal({ companyId, proposal }) {
  if (proposal.action === 'checkin') {
    const existing = await pgPool.get(SCHEMA, `
      SELECT *
      FROM worker.attendance
      WHERE employee_id=$1
        AND date=$2
    `, [proposal.employee_id, proposal.date]);

    if (existing?.check_in) {
      const err = new Error('이미 출근 체크됨');
      err.code = 'DUPLICATE';
      throw err;
    }

    return pgPool.get(SCHEMA, `
      INSERT INTO worker.attendance (company_id, employee_id, date, check_in, status, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (employee_id, date)
      DO UPDATE SET
        check_in = EXCLUDED.check_in,
        status = EXCLUDED.status,
        note = EXCLUDED.note
      RETURNING *
    `, [
      companyId,
      proposal.employee_id,
      proposal.date,
      proposal.occurred_at,
      getAttendanceStatusForCheckin(proposal.occurred_at),
      proposal.note || null,
    ]);
  }

  const existing = await pgPool.get(SCHEMA, `
    SELECT *
    FROM worker.attendance
    WHERE employee_id=$1
      AND date=$2
  `, [proposal.employee_id, proposal.date]);

  if (!existing?.check_in) {
    const err = new Error('출근 기록이 없습니다');
    err.code = 'NOT_CHECKED_IN';
    throw err;
  }

  return pgPool.get(SCHEMA, `
    UPDATE worker.attendance
    SET check_out=$1,
        note=COALESCE($2, note)
    WHERE employee_id=$3
      AND date=$4
    RETURNING *
  `, [
    proposal.occurred_at,
    proposal.note || null,
    proposal.employee_id,
    proposal.date,
  ]);
}

function requireWorkerWebhookSecret(req, res, next) {
  const secret = getSecret('worker_webhook_secret');
  if (!secret) {
    return res.status(503).json({ error: 'worker webhook secret이 설정되지 않았습니다.', code: 'WEBHOOK_SECRET_MISSING' });
  }
  const provided = req.headers['x-worker-webhook-secret']
    || req.headers['x-api-key']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== secret) {
    return res.status(401).json({ error: '웹훅 인증에 실패했습니다.', code: 'WEBHOOK_AUTH_FAILED' });
  }
  next();
}

// ── 인증 API ──────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login',
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { username, password } = req.body;
    try {
      // 연속 5회 실패 → 30분 잠금 (OWASP 계정 잠금)
      const failRow = await pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.access_log
         WHERE username=$1 AND action='login_fail' AND created_at > NOW() - interval '30 minutes'`,
        [username]);
      if (Number(failRow?.cnt ?? 0) >= 5) {
        await logAuth('login_locked', username, req.ip, req.headers['user-agent']);
        return res.status(423).json({ error: '로그인 시도 초과. 30분 후 재시도해주세요.', code: 'ACCOUNT_LOCKED' });
      }

      const user = await pgPool.get(SCHEMA,
        `SELECT * FROM worker.users WHERE username = $1 AND deleted_at IS NULL`, [username]);
      if (!user) {
        await logAuth('login_fail', username, req.ip, req.headers['user-agent'], { reason: '존재하지 않는 아이디' });
        return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'AUTH_FAILED' });
      }

      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        await logAuth('login_fail', username, req.ip, req.headers['user-agent'], { reason: '비밀번호 불일치' });
        return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.', code: 'AUTH_FAILED' });
      }

      // 마지막 로그인 시각 갱신
      await pgPool.run(SCHEMA, `UPDATE worker.users SET last_login_at=NOW() WHERE id=$1`, [user.id]);
      await logAuth('login', username, req.ip, req.headers['user-agent']);

      // employees 자동 등록 (기존 사용자 호환: 로그인 시마다 없으면 생성)
      try {
        const emp = await pgPool.get(SCHEMA,
          `SELECT id FROM worker.employees WHERE user_id=$1 AND deleted_at IS NULL`, [user.id]);
        if (!emp) {
          await pgPool.run(SCHEMA,
            `INSERT INTO worker.employees (company_id, user_id, name) VALUES ($1, $2, $3)`,
            [user.company_id, user.id, user.name]);
        }
      } catch (_) { /* 무시 */ }

      const token = await generateToken(user);
      const { password_hash: _, ...safeUser } = user;
      const hydratedUser = await buildUserResponse(safeUser);
      res.json({ token, user: hydratedUser, must_change_pw: !!user.must_change_pw });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// POST /api/auth/register (master만)
app.post('/api/auth/register',
  requireAuth, requireRole('master'),
  body('username').trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('password').notEmpty(),
  body('name').trim().notEmpty(),
  body('role').isIn(['master','admin','member']),
  body('company_id').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { username, password, name, role, company_id, email, telegram_id } = req.body;

    const policy = validatePasswordPolicy(password);
    if (!policy.valid) return res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });

    try {
      const exists = await pgPool.get(SCHEMA, `SELECT id FROM worker.users WHERE username = $1`, [username]);
      if (exists) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.', code: 'DUPLICATE_USERNAME' });

      const hash = await hashPassword(password);
      const user = await pgPool.get(SCHEMA,
        `INSERT INTO worker.users (company_id, username, password_hash, role, name, email, telegram_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, company_id, username, role, name, email, telegram_id, created_at`,
        [company_id, username, hash, role, name, email || null, telegram_id || null]);
      res.status(201).json({ user });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await pgPool.get(SCHEMA,
      `SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at,
              ai_ui_mode_override, ai_llm_mode_override, ai_confirmation_mode_override
       FROM worker.users
       WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });
    res.json({ user: await buildUserResponse(user) });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password',
  requireAuth,
  body('current_password').notEmpty(),
  body('new_password').notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { current_password, new_password } = req.body;

    const policy = validatePasswordPolicy(new_password);
    if (!policy.valid) return res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });

    try {
      const user = await pgPool.get(SCHEMA, `SELECT * FROM worker.users WHERE id = $1`, [req.user.id]);
      if (!await verifyPassword(current_password, user.password_hash)) {
        return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다.', code: 'AUTH_FAILED' });
      }
      const hash = await hashPassword(new_password);
      await pgPool.run(SCHEMA,
        `UPDATE worker.users SET password_hash=$1, must_change_pw=FALSE, updated_at=NOW() WHERE id=$2`,
        [hash, req.user.id]);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// PUT /api/settings/profile
app.put('/api/settings/profile',
  requireAuth,
  body('name').optional().trim().notEmpty(),
  body('email').optional({ values: 'falsy' }).isEmail(),
  body('telegram_id').optional({ values: 'falsy' }).trim(),
  async (req, res) => {
    if (!validate(req, res)) return;
    if (req.user.role === 'member') {
      return res.status(403).json({ error: '멤버 계정은 개인정보를 직접 수정할 수 없습니다.', code: 'FORBIDDEN' });
    }
    try {
      const { name, email, telegram_id } = req.body;
      await pgPool.run(SCHEMA, `
        UPDATE worker.users
        SET name = COALESCE($1, name),
            email = COALESCE($2, email),
            telegram_id = COALESCE($3, telegram_id),
            updated_at = NOW()
        WHERE id = $4
      `, [
        name || null,
        email || null,
        telegram_id ?? null,
        req.user.id,
      ]);

      const user = await pgPool.get(SCHEMA,
        `SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at,
                ai_ui_mode_override, ai_llm_mode_override, ai_confirmation_mode_override
         FROM worker.users
         WHERE id = $1 AND deleted_at IS NULL`,
        [req.user.id]);
      if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      res.json({ user: await buildUserResponse(user) });
    } catch {
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

// GET /api/settings/ai-policy
app.get('/api/settings/ai-policy', requireAuth, async (req, res) => {
  try {
    const user = await pgPool.get(SCHEMA, `
      SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at,
             ai_ui_mode_override, ai_llm_mode_override, ai_confirmation_mode_override
      FROM worker.users
      WHERE id = $1 AND deleted_at IS NULL
    `, [req.user.id]);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });

    const company = await getCompanyAiPolicy(user.company_id);
    res.json({
      ai_policy: resolveAiPolicy({ user, company }),
      company_policy: company ? {
        ai_member_ui_mode: company.ai_member_ui_mode,
        ai_admin_ui_mode: company.ai_admin_ui_mode,
        ai_member_llm_mode: company.ai_member_llm_mode,
        ai_admin_llm_mode: company.ai_admin_llm_mode,
        ai_confirmation_mode: company.ai_confirmation_mode,
        ai_allow_admin_llm_toggle: company.ai_allow_admin_llm_toggle,
      } : null,
    });
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
  }
});

// PUT /api/settings/ai-policy
app.put('/api/settings/ai-policy',
  requireAuth,
  body('llm_mode').isIn(['off', 'assist', 'full']),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const user = await pgPool.get(SCHEMA, `
        SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at,
               ai_ui_mode_override, ai_llm_mode_override, ai_confirmation_mode_override
        FROM worker.users
        WHERE id = $1 AND deleted_at IS NULL
      `, [req.user.id]);
      if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });

      const company = await getCompanyAiPolicy(user.company_id);
      const decision = validateLlmModeForUser(user, company, req.body.llm_mode);
      if (!decision.ok) {
        return res.status(403).json({ error: decision.error, code: 'FORBIDDEN' });
      }

      await pgPool.run(SCHEMA, `
        UPDATE worker.users
        SET ai_llm_mode_override = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [decision.llmMode, user.id]);

      const updatedUser = { ...user, ai_llm_mode_override: decision.llmMode };
      res.json({
        success: true,
        ai_policy: resolveAiPolicy({ user: updatedUser, company }),
      });
    } catch {
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.get('/api/admin/monitoring/llm-api', requireAuth, requireRole('admin', 'master'), async (req, res) => {
  try {
    const user = await pgPool.get(SCHEMA, `
      SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at,
             ai_ui_mode_override, ai_llm_mode_override, ai_confirmation_mode_override
      FROM worker.users
      WHERE id = $1 AND deleted_at IS NULL
    `, [req.user.id]);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });

    res.json(await buildWorkerMonitoringPayload(user));
  } catch (error) {
    res.status(500).json({ error: '워커 모니터링 정보를 불러오지 못했습니다.', code: 'WORKER_MONITORING_LOAD_FAILED', detail: error.message });
  }
});

app.put('/api/admin/monitoring/llm-api',
  requireAuth,
  requireRole('admin', 'master'),
  body('provider').isIn(ALLOWED_APIS),
  body('note').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const user = await pgPool.get(SCHEMA, `
        SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at,
               ai_ui_mode_override, ai_llm_mode_override, ai_confirmation_mode_override
        FROM worker.users
        WHERE id = $1 AND deleted_at IS NULL
      `, [req.user.id]);
      if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });

      await setWorkerMonitoringPreference(req.body.provider, user.id, req.body.note);
      res.json({
        success: true,
        message: `${API_CATALOG[req.body.provider]?.label || req.body.provider} API를 워커 웹 기본 분석 경로로 저장했습니다.`,
        ...(await buildWorkerMonitoringPayload(user)),
      });
    } catch (error) {
      res.status(500).json({ error: '워커 모니터링 설정을 저장하지 못했습니다.', code: 'WORKER_MONITORING_SAVE_FAILED', detail: error.message });
    }
  }
);

app.put('/api/admin/monitoring/llm-api/selector',
  requireAuth,
  requireRole('admin', 'master'),
  body('key').isString().trim().notEmpty(),
  body('role').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('provider').isString().trim().notEmpty(),
  body('model').isString().trim().notEmpty(),
  body('note').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const user = await pgPool.get(SCHEMA, `
        SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at,
               ai_ui_mode_override, ai_llm_mode_override, ai_confirmation_mode_override
        FROM worker.users
        WHERE id = $1 AND deleted_at IS NULL
      `, [req.user.id]);
      if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });

      const key = String(req.body.key || '').trim();
      const role = String(req.body.role || 'primary').trim().toLowerCase();
      const provider = String(req.body.provider || '').trim();
      const model = String(req.body.model || '').trim();
      const note = String(req.body.note || '').trim();
      const editMeta = SELECTOR_EDIT_CONFIG[key] || null;
      if (!editMeta) {
        return res.status(400).json({ error: '현재 화면에서 직접 변경할 수 없는 selector입니다.', code: 'SELECTOR_NOT_EDITABLE' });
      }
      if (!PROVIDER_MODEL_OPTIONS[provider]) {
        return res.status(400).json({ error: '지원하지 않는 provider입니다.', code: 'INVALID_PROVIDER' });
      }
      if (!PROVIDER_MODEL_OPTIONS[provider].some((item) => item.model === model)) {
        return res.status(400).json({ error: '지원하지 않는 model입니다.', code: 'INVALID_MODEL' });
      }

      const description = await describeRuntimeSelectorByKey(key);
      const availableRoles = Array.isArray(description?.chain)
        ? description.chain.map((entry, index) => (index === 0 ? 'primary' : `fallback${index}`))
        : ['primary'];
      if (!availableRoles.includes(role)) {
        return res.status(400).json({ error: '지원하지 않는 role입니다.', code: 'INVALID_SELECTOR_ROLE' });
      }
      const nextValue = buildUpdatedSelectorValue(key, editMeta.type, provider, model, description, role);
      const configPath = resolveConfigAbsolutePath(editMeta.config);
      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      setByPath(rawConfig, editMeta.path, nextValue);
      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2) + '\n', 'utf8');

      if (key === 'worker.ai.fallback') {
        await setWorkerMonitoringPreference(provider, user.id, note || `selector_edit:${key}:${provider}/${model}`);
      }

      res.json({
        success: true,
        message: `${key} ${role}를 ${provider} / ${model} 로 저장했습니다.`,
        ...(await buildWorkerMonitoringPayload(user)),
      });
    } catch (error) {
      res.status(500).json({ error: 'selector 설정을 저장하지 못했습니다.', code: 'SELECTOR_SAVE_FAILED', detail: error.message });
    }
  }
);

app.post('/api/admin/monitoring/llm-api/speed-test',
  requireAuth,
  requireRole('admin', 'master'),
  async (req, res) => {
    try {
      const user = await pgPool.get(SCHEMA, `
        SELECT id, company_id, username, role, name, email, telegram_id, channel, must_change_pw, last_login_at, created_at,
               ai_ui_mode_override, ai_llm_mode_override, ai_confirmation_mode_override
        FROM worker.users
        WHERE id = $1 AND deleted_at IS NULL
      `, [req.user.id]);
      if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });

      const run = await runNodeScriptJson(SPEED_TEST_DAILY_SCRIPT, ['--days=7', '--json'], 180_000);
      if (!run) {
        return res.status(500).json({
          error: '속도 테스트 실행 결과를 읽지 못했습니다.',
          code: 'SPEED_TEST_RUN_FAILED',
        });
      }

      const speedTestOk = run?.speedTest?.ok !== false;
      res.json({
        success: speedTestOk,
        message: speedTestOk
          ? '속도 테스트를 실행하고 최신 측정 결과를 반영했습니다.'
          : '속도 테스트를 실행했지만 일부 대상 측정이 실패했습니다.',
        speed_test_run: {
          executed_at: run.executedAt || null,
          ok: run?.speedTest?.ok !== false,
          skipped: Boolean(run?.speedTest?.skipped),
          status: Number(run?.speedTest?.status || 0),
          stderr: String(run?.speedTest?.stderr || '').trim(),
        },
        ...(await buildWorkerMonitoringPayload(user)),
      });
    } catch (error) {
      res.status(500).json({
        error: '속도 테스트를 실행하지 못했습니다.',
        code: 'SPEED_TEST_RUN_FAILED',
        detail: error.message,
      });
    }
  }
);

app.get('/api/admin/monitoring/blog-published-urls',
  requireAuth,
  requireRole('admin', 'master'),
  async (req, res) => {
    try {
      const requestedLimit = Number.parseInt(String(req.query.limit || ''), 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 500)
        : 100;
      res.json(await buildBlogPublishedUrlPayload(limit));
    } catch (error) {
      res.status(500).json({
        error: '블로그 발행 URL 목록을 불러오지 못했습니다.',
        code: 'BLOG_PUBLISHED_URL_LOAD_FAILED',
        detail: error.message,
      });
    }
  }
);

app.post('/api/admin/monitoring/blog-published-urls',
  requireAuth,
  requireRole('admin', 'master'),
  body('post_id').isInt({ min: 1 }),
  body('url').isString().trim().isLength({ min: 10, max: 500 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const parsed = parseNaverBlogUrl(req.body.url);
      if (!parsed.ok) {
        return res.status(400).json({
          error: `유효한 네이버 블로그 URL이 아닙니다: ${parsed.reason}`,
          code: 'INVALID_BLOG_URL',
        });
      }

      const post = await pgPool.get('blog', `
        SELECT id, title, status, naver_url, created_at
        FROM blog.posts
        WHERE id = $1
      `, [req.body.post_id]);

      if (!post) {
        return res.status(404).json({ error: '대상 블로그 글을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      }

      await markPublished(post.id, parsed.canonicalUrl);

      const requestedLimit = Number.parseInt(String(req.query.limit || req.body.limit || ''), 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 500)
        : 100;

      res.json({
        success: true,
        message: `블로그 URL을 기록했습니다: ${post.title}`,
        saved: {
          post_id: post.id,
          title: post.title,
          status: 'published',
          naver_url: parsed.canonicalUrl,
          blog_id: parsed.blogId,
          log_no: parsed.logNo,
        },
        ...(await buildBlogPublishedUrlPayload(limit)),
      });
    } catch (error) {
      res.status(500).json({
        error: '블로그 발행 URL을 저장하지 못했습니다.',
        code: 'BLOG_PUBLISHED_URL_SAVE_FAILED',
        detail: error.message,
      });
    }
  }
);

// ── 업체 API (master 전용) ────────────────────────────────────────────

app.get('/api/companies', requireAuth, requireRole('master'), async (req, res) => {
  const { limit, offset, sort, order } = pagination(req);
  const search = req.query.q ? `%${req.query.q}%` : null;
  const status = String(req.query.status || 'active').toLowerCase();
  try {
    const clauses = [];
    const params = [];
    if (status === 'active') clauses.push('c.deleted_at IS NULL');
    else if (status === 'inactive') clauses.push('c.deleted_at IS NOT NULL');
    if (search) {
      params.push(search);
      clauses.push(`(c.name ILIKE $${params.length} OR c.owner ILIKE $${params.length})`);
    }
    params.push(limit, offset);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const pLimit = `$${params.length - 1}`;
    const pOff = `$${params.length}`;
    const rows = await pgPool.query(SCHEMA,
      `SELECT c.*,
        du.name AS deactivated_by_name,
        (SELECT COUNT(*) FROM worker.users    u WHERE u.company_id=c.id AND u.deleted_at IS NULL) AS user_count,
        (SELECT COUNT(*) FROM worker.employees e WHERE e.company_id=c.id AND e.deleted_at IS NULL) AS employee_count
       FROM worker.companies c
       LEFT JOIN worker.users du ON du.id = c.deactivated_by
       ${where}
       ORDER BY c.${sort} ${order} LIMIT ${pLimit} OFFSET ${pOff}`,
      params);
    res.json({ companies: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/companies',
  requireAuth, requireRole('master'), auditLog('CREATE', 'companies'),
  body('id').trim().matches(/^[a-z0-9_]+$/),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { id, name, owner, phone, biz_number, memo } = req.body;
    try {
      const company = await pgPool.get(SCHEMA,
        `INSERT INTO worker.companies (id, name, owner, phone, biz_number, memo)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, name, owner || null, phone || null, biz_number || null, memo || null]);
      res.status(201).json({ company });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '이미 존재하는 업체 ID입니다.', code: 'DUPLICATE' });
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.put('/api/companies/:id',
  requireAuth, requireRole('master'), auditLog('UPDATE', 'companies'),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { name, owner, phone, biz_number, memo } = req.body;
    try {
      const company = await pgPool.get(SCHEMA,
        `UPDATE worker.companies
         SET name=$1, owner=$2, phone=$3, biz_number=$4, memo=$5, updated_at=NOW()
         WHERE id=$6 AND deleted_at IS NULL RETURNING *`,
        [name, owner || null, phone || null, biz_number || null, memo || null, req.params.id]);
      if (!company) return res.status(404).json({ error: '업체를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      res.json({ company });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/companies/:id', requireAuth, requireRole('master'), auditLog('DELETE', 'companies'), async (req, res) => {
  try {
    const reason = String(req.query.reason || '').trim() || null;
    await pgPool.run(SCHEMA,
      `UPDATE worker.companies
       SET deleted_at=NOW(),
           updated_at=NOW(),
           deactivated_reason=$2,
           deactivated_by=$3
       WHERE id=$1`,
      [req.params.id, reason, req.user.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/companies/:id/restore', requireAuth, requireRole('master'), auditLog('RESTORE', 'companies'), async (req, res) => {
  try {
    const company = await pgPool.get(SCHEMA,
      `UPDATE worker.companies
       SET deleted_at=NULL,
           updated_at=NOW(),
           deactivated_reason=NULL,
           deactivated_by=NULL
       WHERE id=$1
       RETURNING *`,
      [req.params.id]);
    if (!company) return res.status(404).json({ error: '업체를 찾을 수 없습니다.', code: 'NOT_FOUND' });
    res.json({ ok: true, company });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/companies/activity', requireAuth, requireRole('master'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 8), 1), 30);
  try {
    const rows = await pgPool.query(SCHEMA, `
      SELECT
        a.id,
        a.action,
        a.created_at,
        COALESCE(u.name, u.username, '알 수 없음') AS actor_name,
        COALESCE(
          a.detail->'body'->>'id',
          a.detail->'params'->>'id'
        ) AS company_id,
        c.name AS company_name,
        c.deactivated_reason,
        c.deleted_at
      FROM worker.audit_log a
      LEFT JOIN worker.users u ON u.id = a.user_id
      LEFT JOIN worker.companies c
        ON c.id = COALESCE(
          a.detail->'body'->>'id',
          a.detail->'params'->>'id'
        )
      WHERE a.target = 'companies'
        AND a.action IN ('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'UPDATE_MENUS')
      ORDER BY a.created_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ activities: rows });
  } catch {
    res.status(500).json({ error: '업체 변경 이력을 불러오지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

// ── 업체 메뉴 설정 API (master 전용) ─────────────────────────────────

const MENU_KEYS = [
  'dashboard','attendance','sales','projects','schedules',
  'journals','employees','payroll','settings','ai','approvals','monitoring',
];
const ALL_MENUS = [
  { key: 'dashboard',  label: '대시보드',  alwaysOn: true },
  { key: 'attendance', label: '근태 관리' },
  { key: 'sales',      label: '매출 관리' },
  { key: 'projects',   label: '프로젝트 관리' },
  { key: 'schedules',  label: '일정 관리' },
  { key: 'journals',   label: '업무 관리' },
  { key: 'employees',  label: '직원 관리' },
  { key: 'payroll',    label: '급여 관리' },
  { key: 'settings',   label: '설정',     alwaysOn: true },
  { key: 'ai',         label: 'AI 분석' },
  { key: 'approvals',  label: '승인 관리' },
  { key: 'monitoring', label: '워커 모니터링' },
];

// GET /api/companies/:id/menus — 업체 메뉴 설정 조회
app.get('/api/companies/:id/menus', requireAuth, requireRole('master'), async (req, res) => {
  try {
    const company = await pgPool.get(SCHEMA,
      `SELECT id, name, enabled_menus FROM worker.companies WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]);
    if (!company) return res.status(404).json({ error: '업체를 찾을 수 없습니다.', code: 'NOT_FOUND' });
    res.json({ company, allMenus: ALL_MENUS });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// PUT /api/companies/:id/menus — 업체 메뉴 설정 저장
app.put('/api/companies/:id/menus',
  requireAuth, requireRole('master'),
  auditLog('UPDATE_MENUS', 'companies'),
  body('enabled_menus').isArray(),
  async (req, res) => {
    if (!validate(req, res)) return;
    let { enabled_menus } = req.body;

    // 유효 키만 허용 + alwaysOn 메뉴 강제 포함
    enabled_menus = [...new Set([
      'dashboard',
      'settings',
      ...enabled_menus.filter(k => MENU_KEYS.includes(k)),
    ])];

    try {
      const company = await pgPool.get(SCHEMA,
        `SELECT id FROM worker.companies WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
      if (!company) return res.status(404).json({ error: '업체를 찾을 수 없습니다.', code: 'NOT_FOUND' });

      await pgPool.run(SCHEMA,
        `UPDATE worker.companies SET enabled_menus=$1, updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(enabled_menus), req.params.id]);

      res.json({ success: true, enabled_menus });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 사용자 API ────────────────────────────────────────────────────────

app.get('/api/users', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  const { limit, offset, sort, order } = pagination(req);
  // 필터: company_id (master가 선택), role
  const cid  = req.companyId || req.query.company_id || null;
  const role = req.query.role || null;
  const conds = ['deleted_at IS NULL'];
  const params = [];
  if (cid)  { params.push(cid);  conds.push(`company_id=$${params.length}`); }
  if (role) { params.push(role); conds.push(`role=$${params.length}`); }
  params.push(limit, offset);
  const where = `WHERE ${conds.join(' AND ')}`;
  const pLimit = `$${params.length - 1}`;
  const pOff   = `$${params.length}`;
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT id,company_id,username,role,name,email,telegram_id,
              channel,must_change_pw,last_login_at,created_at
       FROM worker.users ${where}
       ORDER BY ${sort} ${order} LIMIT ${pLimit} OFFSET ${pOff}`,
      params);
    res.json({ users: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/users',
  requireAuth, requireRole('master','admin'), auditLog('CREATE', 'users'),
  body('username').trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('password').notEmpty(),
  body('name').trim().notEmpty(),
  body('role').isIn(['admin','member']),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { username, password, name, role, email, telegram_id } = req.body;
    const company_id = req.user.role === 'master' ? (req.body.company_id || req.user.company_id) : req.user.company_id;

    const policy = validatePasswordPolicy(password);
    if (!policy.valid) return res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });

    try {
      const hash = await hashPassword(password);
      const user = await pgPool.get(SCHEMA,
        `INSERT INTO worker.users (company_id,username,password_hash,role,name,email,telegram_id,must_change_pw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
         RETURNING id,company_id,username,role,name,email,telegram_id,must_change_pw,created_at`,
        [company_id, username, hash, role, name, email || null, telegram_id || null]);
      // Bug 1 수정: employees 테이블에 자동 등록 (업무일지·근태 등 직원 연동용)
      try {
        await pgPool.run(SCHEMA,
          `INSERT INTO worker.employees (company_id, user_id, name) VALUES ($1, $2, $3)`,
          [company_id, user.id, name]);
      } catch (_) { /* 중복 등록 방지 — 무시 */ }
      res.status(201).json({ user });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '이미 사용 중인 아이디입니다.', code: 'DUPLICATE' });
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.put('/api/users/:id',
  requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'users'),
  body('name').optional().trim().notEmpty(),
  body('email').optional().isEmail(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.users WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;

      const { name, email, telegram_id } = req.body;
      const user = await pgPool.get(SCHEMA,
        `UPDATE worker.users SET name=COALESCE($1,name), email=COALESCE($2,email), telegram_id=COALESCE($3,telegram_id), updated_at=NOW()
         WHERE id=$4 RETURNING id,company_id,username,role,name,email,telegram_id`,
        [name || null, email || null, telegram_id ?? null, req.params.id]);
      res.json({ user });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/users/:id', requireAuth, requireRole('master','admin'), auditLog('DELETE', 'users'), async (req, res) => {
  try {
    const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.users WHERE id=$1`, [req.params.id]);
    if (target && !await assertCompanyAccess(req, res, target.company_id)) return;
    await pgPool.run(SCHEMA, `UPDATE worker.users SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// POST /api/users/:id/reset-pw (master만 — 임시 비밀번호 설정 + must_change_pw=true)
app.post('/api/users/:id/reset-pw',
  requireAuth, requireRole('master'), auditLog('RESET_PW', 'users'),
  body('new_password').notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { new_password } = req.body;
    const policy = validatePasswordPolicy(new_password);
    if (!policy.valid) return res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });
    try {
      const hash = await hashPassword(new_password);
      const user = await pgPool.get(SCHEMA,
        `UPDATE worker.users SET password_hash=$1, must_change_pw=TRUE, updated_at=NOW()
         WHERE id=$2 AND deleted_at IS NULL RETURNING id,username,name`,
        [hash, req.params.id]);
      if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      res.json({ ok: true });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 승인 API ──────────────────────────────────────────────────────────

app.get('/api/approvals', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const cid = req.companyId;
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT ar.*, u.name AS requester_name, t.title AS task_title, t.target_bot
       FROM worker.approval_requests ar
       LEFT JOIN worker.users u ON u.id = ar.requester_id
       LEFT JOIN worker.agent_tasks t ON t.id = ar.target_id AND ar.target_table='agent_tasks'
       WHERE (company_id=$1 OR $1 IS NULL) AND deleted_at IS NULL AND status='pending'
       ORDER BY priority DESC, created_at ASC LIMIT $2 OFFSET $3`,
      [cid, limit, offset]);
    res.json({ approvals: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/approvals',
  requireAuth,
  body('category').trim().notEmpty(),
  body('action').trim().notEmpty(),
  body('target_table').trim().notEmpty(),
  body('payload').isObject(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { category, action, target_table, target_id, payload, priority } = req.body;
    try {
      const approval = await pgPool.get(SCHEMA,
        `INSERT INTO worker.approval_requests (company_id,requester_id,category,action,target_table,target_id,payload,priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user.company_id, req.user.id, category, action, target_table, target_id || null,
         JSON.stringify(payload), priority || 'normal']);
      res.status(201).json({ approval });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/approvals/:id/approve', requireAuth, requireRole('master','admin'), auditLog('APPROVE', 'approval_requests'), async (req, res) => {
  try {
    const approval = await approveApprovalRequest({
      requestId: req.params.id,
      approverId: req.user.id,
      approverRole: req.user.role,
      approverCompanyId: req.user.company_id,
    });
    if (!approval) return res.status(404).json({ error: '승인 요청을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    res.json({ approval });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.put('/api/approvals/:id/review',
  requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'approval_requests'),
  body('title').optional({ values: 'falsy' }).trim(),
  body('description').optional({ values: 'falsy' }).trim(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const approval = await reviewApprovalRequest({
        requestId: req.params.id,
        approverRole: req.user.role,
        approverCompanyId: req.user.company_id,
        title: req.body.title,
        description: req.body.description,
      });
      if (!approval) return res.status(404).json({ error: '승인 요청을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      res.json({ approval });
    } catch (e) {
      res.status(400).json({ error: e.message || '승인 요청 수정에 실패했습니다.', code: 'APPROVAL_REVIEW_FAILED' });
    }
  }
);

app.put('/api/approvals/:id/reject',
  requireAuth, requireRole('master','admin'), auditLog('REJECT', 'approval_requests'),
  body('reason').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const approval = await rejectApprovalRequest({
        requestId: req.params.id,
        approverId: req.user.id,
        reason: req.body.reason,
        approverRole: req.user.role,
        approverCompanyId: req.user.company_id,
      });
      if (!approval) return res.status(404).json({ error: '승인 요청을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      res.json({ approval });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 감사 로그 API ────────────────────────────────────────────────────

app.get('/api/audit', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT * FROM worker.audit_log
       WHERE (company_id=$1 OR $1 IS NULL)
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.companyId, limit, offset]);
    res.json({ logs: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ══════════════════════════════════════════════════════════════════════
// Phase 2 API — 직원(노아) / 근태(노아) / 매출(올리버) / 문서(에밀리)
// ══════════════════════════════════════════════════════════════════════

// ── 직원 API (노아) ────────────────────────────────────────────────────

app.get('/api/employees', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset, sort, order } = pagination(req);
  const validSort = ['name','position','department','hire_date','created_at'].includes(sort) ? sort : 'name';
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT id,company_id,user_id,name,phone,position,department,hire_date,status,base_salary,created_at
       FROM worker.employees
       WHERE company_id=$1 AND deleted_at IS NULL
       ORDER BY ${validSort} ${order} LIMIT $2 OFFSET $3`,
      [req.companyId, limit, offset]);
    res.json({ employees: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/employees',
  requireAuth, requireRole('master','admin'), auditLog('CREATE', 'employees'),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { name, phone, position, department, hire_date, user_id } = req.body;
    const companyId = req.user.role === 'master' ? (req.body.company_id || req.user.company_id) : req.user.company_id;
    try {
      const emp = await pgPool.get(SCHEMA,
        `INSERT INTO worker.employees (company_id,user_id,name,phone,position,department,hire_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,company_id,name,position,department,hire_date,status`,
        [companyId, user_id||null, name, phone||null, position||null, department||null, hire_date||null]);
      res.status(201).json({ employee: emp });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.post('/api/employees/proposals', requireAuth, requireRole('master', 'admin'), async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const proposal = buildEmployeeProposal({ prompt });
    const sourceRefId = `employee-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'employee_prompt',
      sourceRefType: 'employee_proposal',
      sourceRefId,
      flowCode: 'employee_create',
      actionCode: 'create_employee',
      proposalId: sourceRefId,
      aiInputText: prompt || proposal.name,
      aiInputPayload: { prompt },
      aiOutputType: 'employee_record',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });
    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'employee_create',
      actionCode: 'create_employee',
      query: `${prompt} ${proposal.name} ${proposal.department} ${proposal.position}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });
    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '직원 제안을 생성하지 못했습니다.', code: 'EMPLOYEE_PROPOSAL_FAILED' });
  }
});

app.post('/api/employees/proposals/:id/confirm', requireAuth, requireRole('master', 'admin'), async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '직원 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    const proposal = normalizeEmployeeProposal(req.body.proposal || session.original_snapshot_json || {});
    if (!proposal.name) {
      return res.status(400).json({ error: '이름은 필수입니다.', code: 'INVALID_EMPLOYEE_PROPOSAL' });
    }
    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'employee_confirm' },
    });
    const row = await pgPool.get(SCHEMA,
      `INSERT INTO worker.employees (company_id,user_id,name,phone,position,department,hire_date,status,base_salary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,company_id,user_id,name,phone,position,department,hire_date,status,base_salary`,
      [
        req.user.company_id,
        null,
        proposal.name,
        proposal.phone || null,
        proposal.position || null,
        proposal.department || null,
        proposal.hire_date || null,
        proposal.status || 'active',
        proposal.base_salary ? Number(proposal.base_salary) : null,
      ]);
    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'employee_confirm', employee_id: row.id },
    });
    const committedSnapshot = {
      ...proposal,
      employee_id: row.id,
      status: 'committed',
    };
    await markWorkerFeedbackCommitted({
      sessionId: session.id,
      submittedSnapshot: committedSnapshot,
      eventMeta: { source: 'employee_confirm', employee_id: row.id },
    });
    res.json({ ok: true, employee: row, proposal: committedSnapshot });
  } catch (error) {
    res.status(500).json({ error: error.message || '직원 확정 처리 중 오류가 발생했습니다.', code: 'EMPLOYEE_CONFIRM_FAILED' });
  }
});

app.post('/api/employees/proposals/:id/reject', requireAuth, requireRole('master', 'admin'), async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '직원 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: { source: 'employee_reject' },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '직원 제안을 반려하지 못했습니다.', code: 'EMPLOYEE_REJECT_FAILED' });
  }
});

app.put('/api/employees/:id',
  requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'employees'),
  body('name').optional().trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.employees WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      if (!target) return res.status(404).json({ error: '직원을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;

      const { name, phone, position, department, hire_date, status, user_id, base_salary } = req.body;
      const emp = await pgPool.get(SCHEMA,
        `UPDATE worker.employees
         SET name=COALESCE($1,name), phone=COALESCE($2,phone), position=COALESCE($3,position),
             department=COALESCE($4,department), hire_date=COALESCE($5,hire_date),
             status=COALESCE($6,status), user_id=COALESCE($7,user_id),
             base_salary=COALESCE($8,base_salary)
         WHERE id=$9 RETURNING id,company_id,name,phone,position,department,hire_date,status,base_salary`,
        [name||null, phone||null, position||null, department||null, hire_date||null,
         status||null, user_id||null, base_salary ?? null, req.params.id]);
      res.json({ employee: emp });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/employees/:id', requireAuth, requireRole('master','admin'), auditLog('DELETE', 'employees'), async (req, res) => {
  try {
    const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.employees WHERE id=$1`, [req.params.id]);
    if (target && !await assertCompanyAccess(req, res, target.company_id)) return;
    await pgPool.run(SCHEMA, `UPDATE worker.employees SET deleted_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 근태 API (노아) ────────────────────────────────────────────────────

app.get('/api/attendance', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const startDate = req.query.start_date || req.query.date || kst.today();
  const endDate = req.query.end_date || req.query.date || startDate;
  try {
    let employeeFilter = '';
    const params = [req.companyId, startDate, endDate, limit, offset];
    if (req.user.role === 'member') {
      const employeeId = await getEmployeeIdForRequest(req);
      if (!employeeId) {
        return res.json({ attendance: [] });
      }
      employeeFilter = ' AND a.employee_id=$6';
      params.push(employeeId);
    }
    const rows = await pgPool.query(SCHEMA,
      `SELECT a.*, e.name AS employee_name
       FROM worker.attendance a
       JOIN worker.employees e ON e.id=a.employee_id
       WHERE a.company_id=$1 AND a.date BETWEEN $2 AND $3
       ${employeeFilter}
       ORDER BY a.date DESC, e.name LIMIT $4 OFFSET $5`,
      params);
    res.json({ attendance: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/attendance/leave-status', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const startDate = req.query.start_date || req.query.date || kst.today();
  const endDate = req.query.end_date || req.query.date || startDate;
  try {
    let requesterFilter = '';
    const params = [req.companyId, startDate, endDate, limit, offset];
    if (req.user.role === 'member') {
      requesterFilter = ' AND ar.requester_id=$6';
      params.push(req.user.id);
    }
    const rows = await pgPool.query(SCHEMA,
      `SELECT
         ar.id,
         ar.status,
         ar.created_at,
         ar.updated_at,
         ar.payload,
         COALESCE(ar.payload->>'employee_name', u.name, '직원') AS employee_name,
         COALESCE(ar.payload->>'leave_date', '') AS leave_date,
         COALESCE(ar.payload->>'leave_type_label', ar.payload->>'leave_type', '휴가') AS leave_type_label,
         COALESCE(ar.payload->>'reason', '') AS reason
       FROM worker.approval_requests ar
       LEFT JOIN worker.users u ON u.id=ar.requester_id
       WHERE ar.company_id=$1
         AND ar.category='leave'
         AND COALESCE(ar.payload->>'leave_date', '') BETWEEN $2 AND $3
         ${requesterFilter}
       ORDER BY COALESCE(ar.payload->>'leave_date', '') DESC, ar.created_at DESC
       LIMIT $4 OFFSET $5`,
      params);
    res.json({ leave_requests: rows });
  } catch {
    res.status(500).json({ error: '휴가 현황을 불러오지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.get('/api/attendance/leave-approvals', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT
         ar.id,
         ar.status,
         ar.created_at,
         ar.updated_at,
         ar.payload,
         COALESCE(ar.payload->>'employee_name', u.name, '직원') AS employee_name,
         COALESCE(ar.payload->>'leave_date', '') AS leave_date,
         COALESCE(ar.payload->>'leave_type_label', ar.payload->>'leave_type', '휴가') AS leave_type_label,
         COALESCE(ar.payload->>'reason', '') AS reason
       FROM worker.approval_requests ar
       LEFT JOIN worker.users u ON u.id=ar.requester_id
       WHERE ar.company_id=$1
         AND ar.category='leave'
         AND ar.status='pending'
       ORDER BY COALESCE(ar.payload->>'leave_date', '') ASC, ar.created_at ASC`,
      [req.companyId]);
    res.json({ leave_approvals: rows });
  } catch {
    res.status(500).json({ error: '휴가 승인 현황을 불러오지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.post('/api/attendance/checkin', requireAuth, async (req, res) => {
  const today = kst.today();
  const now   = new Date().toISOString();
  try {
    // user_id로 employee 조회
    const emp = await pgPool.get(SCHEMA,
      `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [req.user.company_id, req.user.id]);
    if (!emp) {
      // employee_id 직접 지정도 허용 (admin)
      const empId = req.body.employee_id;
      if (!empId) return res.status(404).json({ error: '연결된 직원 정보 없음', code: 'NOT_FOUND' });
      await pgPool.run(SCHEMA,
        `INSERT INTO worker.attendance (company_id,employee_id,date,check_in,status)
         VALUES ($1,$2,$3,$4,'present') ON CONFLICT (employee_id,date) DO UPDATE SET check_in=$4`,
        [req.user.company_id, empId, today, now]);
      return res.json({ ok: true, check_in: now });
    }
    const existing = await pgPool.get(SCHEMA,
      `SELECT check_in FROM worker.attendance WHERE employee_id=$1 AND date=$2`, [emp.id, today]);
    if (existing?.check_in) return res.status(409).json({ error: '이미 출근 체크됨', code: 'DUPLICATE' });
    await pgPool.run(SCHEMA,
      `INSERT INTO worker.attendance (company_id,employee_id,date,check_in,status)
       VALUES ($1,$2,$3,$4,'present') ON CONFLICT (employee_id,date) DO UPDATE SET check_in=$4`,
      [req.user.company_id, emp.id, today, now]);
    res.json({ ok: true, check_in: now });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/attendance/checkout', requireAuth, async (req, res) => {
  const today = kst.today();
  const now   = new Date().toISOString();
  try {
    const emp = await pgPool.get(SCHEMA,
      `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [req.user.company_id, req.user.id]);
    const empId = emp?.id || req.body.employee_id;
    if (!empId) return res.status(404).json({ error: '연결된 직원 정보 없음', code: 'NOT_FOUND' });

    const existing = await pgPool.get(SCHEMA,
      `SELECT check_in FROM worker.attendance WHERE employee_id=$1 AND date=$2`, [empId, today]);
    if (!existing?.check_in) return res.status(400).json({ error: '출근 기록이 없습니다', code: 'NOT_CHECKED_IN' });

    await pgPool.run(SCHEMA,
      `UPDATE worker.attendance SET check_out=$1 WHERE employee_id=$2 AND date=$3`,
      [now, empId, today]);
    res.json({ ok: true, check_out: now });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.put('/api/attendance/:id',
  requireAuth, requireRole('master','admin'), companyFilter, auditLog('UPDATE', 'attendance'),
  async (req, res) => {
    try {
      const target = await pgPool.get(SCHEMA,
        `SELECT company_id FROM worker.attendance WHERE id=$1`,
        [req.params.id]);
      if (!target) return res.status(404).json({ error: '근태 기록을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;

      const { check_in, check_out, status, note } = req.body;
      const attendance = await pgPool.get(SCHEMA,
        `UPDATE worker.attendance
         SET check_in = COALESCE($1, check_in),
             check_out = COALESCE($2, check_out),
             status = COALESCE($3, status),
             note = COALESCE($4, note),
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [check_in || null, check_out || null, status || null, note ?? null, req.params.id]);
      res.json({ attendance });
    } catch {
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.delete('/api/attendance/:id',
  requireAuth, requireRole('master','admin'), companyFilter, auditLog('DELETE', 'attendance'),
  async (req, res) => {
    try {
      const target = await pgPool.get(SCHEMA,
        `SELECT company_id FROM worker.attendance WHERE id=$1`,
        [req.params.id]);
      if (!target) return res.status(404).json({ error: '근태 기록을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;
      await pgPool.run(SCHEMA, `DELETE FROM worker.attendance WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.post('/api/attendance/proposals', requireAuth, async (req, res) => {
  try {
    const employee = await resolveAttendanceEmployee(req, req.body.employee_id || null);
    const prompt = String(req.body.prompt || '').trim();
    const fallbackAction = req.body.action || '';
    const proposal = buildAttendanceProposal({
      prompt,
      fallbackAction,
      employee,
      now: new Date(),
    });
    const sourceRefId = `attendance-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'attendance_prompt',
      sourceRefType: 'attendance_proposal',
      sourceRefId,
      flowCode: proposal.action === 'checkout' ? 'attendance_checkout' : 'attendance_checkin',
      actionCode: proposal.action,
      proposalId: sourceRefId,
      aiInputText: prompt || proposal.action_label,
      aiInputPayload: {
        prompt,
        action: fallbackAction || proposal.action,
        employee_id: employee.id,
      },
      aiOutputType: 'attendance_record',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });

    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: proposal.action === 'checkout' ? 'attendance_checkout' : 'attendance_checkin',
      actionCode: proposal.action,
      query: `${prompt || proposal.summary} ${proposal.action_label} ${proposal.note || ''}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });

    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    const code = error.code || 'BAD_REQUEST';
    const status = code === 'BAD_REQUEST' ? 400 : 500;
    res.status(status).json({ error: error.message || '근태 제안을 생성하지 못했습니다.', code });
  }
});

app.post('/api/attendance/proposals/:id/confirm', requireAuth, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '근태 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }

    const employee = await resolveAttendanceEmployee(req);
    const proposal = normalizeAttendanceProposal(req.body.proposal || session.original_snapshot_json || {}, employee);

    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: {
        source: 'attendance_confirm',
      },
    });

    const attendance = await applyAttendanceProposal({
      companyId: req.user.company_id,
      proposal,
    });

    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: {
        source: 'attendance_confirm',
      },
    });

    const committedSnapshot = {
      ...proposal,
      attendance_id: attendance.id,
      status: 'committed',
      attendance_status: attendance.status,
    };

    await markWorkerFeedbackCommitted({
      sessionId: session.id,
      submittedSnapshot: committedSnapshot,
      eventMeta: {
        source: 'attendance_confirm',
        attendance_id: attendance.id,
      },
    });

    res.json({ ok: true, attendance, proposal: committedSnapshot });
  } catch (error) {
    const code = error.code || 'SERVER_ERROR';
    const status = code === 'DUPLICATE' ? 409 : code === 'NOT_CHECKED_IN' ? 400 : 500;
    res.status(status).json({ error: error.message || '근태 확정 처리 중 오류가 발생했습니다.', code });
  }
});

app.post('/api/attendance/proposals/:id/reject', requireAuth, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '근태 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }

    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: {
        source: 'attendance_reject',
      },
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '근태 제안을 반려하지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.post('/api/leave/proposals', requireAuth, async (req, res) => {
  try {
    const employee = await resolveAttendanceEmployee(req, req.body.employee_id || null);
    const prompt = String(req.body.prompt || '').trim();
    const proposal = buildLeaveProposal({ prompt, employee });
    const sourceRefId = `leave-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'leave_prompt',
      sourceRefType: 'leave_proposal',
      sourceRefId,
      flowCode: 'attendance_leave_request',
      actionCode: 'leave_request',
      proposalId: sourceRefId,
      aiInputText: prompt,
      aiInputPayload: { prompt, employee_id: employee.id },
      aiOutputType: 'leave_request',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });

    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'attendance_leave_request',
      actionCode: 'leave_request',
      query: `${prompt} ${proposal.leave_type_label} ${proposal.reason}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });

    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '휴가 제안을 생성하지 못했습니다.', code: 'LEAVE_PROPOSAL_FAILED' });
  }
});

app.post('/api/leave/proposals/:id/confirm', requireAuth, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '휴가 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }

    const employee = await resolveAttendanceEmployee(req);
    const proposal = normalizeLeaveProposal(req.body.proposal || session.original_snapshot_json || {}, employee);

    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'leave_confirm' },
    });

    const duplicateLeave = await pgPool.get(SCHEMA,
      `SELECT id, status
       FROM worker.approval_requests
       WHERE company_id = $1
         AND category = 'leave'
         AND status IN ('pending', 'approved')
         AND COALESCE(payload->>'employee_id', '') = $2
         AND COALESCE(payload->>'leave_date', '') = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [
        req.user.company_id,
        String(proposal.employee_id || ''),
        proposal.leave_date,
      ],
    );

    if (duplicateLeave) {
      const statusLabel = duplicateLeave.status === 'approved' ? '이미 승인된' : '이미 신청 중인';
      return res.status(409).json({
        error: `${proposal.leave_date}에는 ${statusLabel} 휴가가 있습니다.`,
        code: 'DUPLICATE_LEAVE_REQUEST',
      });
    }

    const approval = await pgPool.get(SCHEMA,
      `INSERT INTO worker.approval_requests (
        company_id, requester_id, category, action, target_table, payload, status, priority
      ) VALUES ($1, $2, 'leave', 'leave_request', 'attendance', $3::jsonb, 'pending', 'normal')
      RETURNING *`,
      [
        req.user.company_id,
        req.user.id,
        JSON.stringify({
          employee_id: proposal.employee_id,
          employee_name: proposal.employee_name,
          leave_date: proposal.leave_date,
          leave_type: proposal.leave_type,
          leave_type_label: proposal.leave_type_label,
          reason: proposal.reason,
          feedback_session_id: session.id,
        }),
      ],
    );

    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'leave_confirm', approval_id: approval.id },
    });

    const submittedSnapshot = {
      ...proposal,
      approval_id: approval.id,
      status: 'submitted',
    };

    await markWorkerFeedbackSubmitted({
      sessionId: session.id,
      submittedSnapshot,
      eventMeta: { source: 'leave_confirm', approval_id: approval.id },
    });

    res.json({ ok: true, approval, proposal: submittedSnapshot });
  } catch (error) {
    res.status(500).json({ error: error.message || '휴가 신청을 접수하지 못했습니다.', code: 'LEAVE_CONFIRM_FAILED' });
  }
});

app.post('/api/leave/proposals/:id/reject', requireAuth, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '휴가 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }

    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: { source: 'leave_reject' },
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '휴가 제안을 반려하지 못했습니다.', code: 'LEAVE_REJECT_FAILED' });
  }
});

// ── 매출 API (올리버) ──────────────────────────────────────────────────

app.get('/api/sales', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req, { maxLimit: 1000 });
  const from = req.query.from || new Date(Date.now() - 30*24*3600*1000).toISOString().slice(0,10);
  const to   = req.query.to   || kst.today();
  try {
    await syncSkaSalesToWorker(req.companyId);
    const rows = await pgPool.query(SCHEMA,
      `SELECT id, TO_CHAR(date,'YYYY-MM-DD') AS date, amount, category, description, registered_by, created_at
       FROM worker.sales
       WHERE company_id=$1 AND date BETWEEN $2 AND $3 AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC LIMIT $4 OFFSET $5`,
      [req.companyId, from, to, limit, offset]);
    res.json({ sales: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/sales/summary', requireAuth, companyFilter, async (req, res) => {
  try {
    await syncSkaSalesToWorker(req.companyId);
    const [daily, lifetime, currentYear, currentMonth, weekly, monthly, daily30] = await Promise.all([
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
         FROM worker.sales WHERE company_id=$1 AND date=CURRENT_DATE AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
         FROM worker.sales WHERE company_id=$1 AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
         FROM worker.sales
         WHERE company_id=$1
           AND date >= DATE_TRUNC('year', CURRENT_DATE)::date
           AND date < (DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year')::date
           AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
         FROM worker.sales
         WHERE company_id=$1
           AND date >= DATE_TRUNC('month', CURRENT_DATE)::date
           AND date < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::date
           AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date, SUM(amount) AS total, COUNT(*) AS cnt
         FROM worker.sales WHERE company_id=$1 AND date>=CURRENT_DATE-6 AND deleted_at IS NULL
         GROUP BY date ORDER BY date`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT TO_CHAR(date,'YYYY-MM') AS month, SUM(amount) AS total, COUNT(*) AS cnt
         FROM worker.sales WHERE company_id=$1 AND date>=CURRENT_DATE-364 AND deleted_at IS NULL
         GROUP BY 1 ORDER BY 1`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date, SUM(amount) AS total, COUNT(*) AS cnt
         FROM worker.sales WHERE company_id=$1 AND date>=CURRENT_DATE-29 AND deleted_at IS NULL
         GROUP BY date ORDER BY date`,
        [req.companyId]),
    ]);
    res.json({
      today: { total: Number(daily?.total ?? 0), count: Number(daily?.cnt ?? 0) },
      lifetime: { total: Number(lifetime?.total ?? 0), count: Number(lifetime?.cnt ?? 0) },
      currentYear: { total: Number(currentYear?.total ?? 0), count: Number(currentYear?.cnt ?? 0) },
      currentMonth: { total: Number(currentMonth?.total ?? 0), count: Number(currentMonth?.cnt ?? 0) },
      weekly,
      monthly,
      daily30,
    });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/sales',
  requireAuth, companyFilter, auditLog('CREATE', 'sales'),
  body('amount').isInt({ min: 1 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { amount, category, description, date } = req.body;
    const saleDate = date || kst.today();
    try {
      const sale = await pgPool.get(SCHEMA,
        `INSERT INTO worker.sales (company_id,date,amount,category,description,registered_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,date,amount,category`,
        [req.user.company_id, saleDate, amount, category||'기타', description||null, req.user.id]);
      res.status(201).json({ sale });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.post('/api/sales/proposals', requireAuth, companyFilter, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const proposal = buildSalesProposal({ prompt });
    const sourceRefId = `sales-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'sales_prompt',
      sourceRefType: 'sales_proposal',
      sourceRefId,
      flowCode: 'sales_create',
      actionCode: 'create_sale',
      proposalId: sourceRefId,
      aiInputText: prompt || proposal.summary,
      aiInputPayload: {
        prompt,
        amount: proposal.amount,
        category: proposal.category,
        date: proposal.date,
      },
      aiOutputType: 'sales_record',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });
    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'sales_create',
      actionCode: 'create_sale',
      query: `${prompt || proposal.summary} ${proposal.category} ${proposal.amount}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });
    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '매출 제안을 생성하지 못했습니다.', code: 'SALES_PROPOSAL_FAILED' });
  }
});

app.post('/api/sales/proposals/:id/confirm', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '매출 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    const proposal = normalizeSalesProposal(req.body.proposal || session.original_snapshot_json || {});
    const reuseEventId = Number(req.body?.reuse_event_id || 0) || null;
    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'sales_confirm' },
    });
    const sale = await pgPool.get(SCHEMA,
      `INSERT INTO worker.sales (company_id,date,amount,category,description,registered_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,date,amount,category,description`,
      [req.user.company_id, proposal.date, proposal.amount, proposal.category || '기타', proposal.description || null, req.user.id]);
    await linkDocumentReuseEvent({
      reuseEventId,
      feedbackSessionId: session.id,
      entityType: 'sales',
      entityId: sale.id,
      companyId: req.companyId,
    });
    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'sales_confirm', sale_id: sale.id },
    });
    const committedSnapshot = {
      ...proposal,
      sale_id: sale.id,
      status: 'committed',
    };
    await markWorkerFeedbackCommitted({
      sessionId: session.id,
      submittedSnapshot: committedSnapshot,
      eventMeta: { source: 'sales_confirm', sale_id: sale.id },
    });
    res.json({ ok: true, sale, proposal: committedSnapshot });
  } catch (error) {
    res.status(500).json({ error: error.message || '매출 확정 처리 중 오류가 발생했습니다.', code: 'SALES_CONFIRM_FAILED' });
  }
});

app.post('/api/sales/proposals/:id/reject', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '매출 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: { source: 'sales_reject' },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '매출 제안을 반려하지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.put('/api/sales/:id',
  requireAuth, companyFilter, auditLog('UPDATE', 'sales'),
  body('amount').optional().isInt({ min: 1 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.sales WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      if (!target) return res.status(404).json({ error: '매출 항목을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;
      const { amount, category, description, date } = req.body;
      const sale = await pgPool.get(SCHEMA,
        `UPDATE worker.sales
         SET amount=COALESCE($1,amount), category=COALESCE($2,category),
             description=COALESCE($3,description), date=COALESCE($4,date)
         WHERE id=$5 RETURNING id,date,amount,category`,
        [amount||null, category||null, description||null, date||null, req.params.id]);
      res.json({ sale });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/sales/:id', requireAuth, companyFilter, auditLog('DELETE', 'sales'), async (req, res) => {
  try {
    const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.sales WHERE id=$1`, [req.params.id]);
    if (target && !await assertCompanyAccess(req, res, target.company_id)) return;
    await pgPool.run(SCHEMA, `UPDATE worker.sales SET deleted_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 매입 API (sales 확장 1차) ────────────────────────────────────────

app.get('/api/expenses', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req, { maxLimit: 1000 });
  const from = req.query.from || new Date(Date.now() - 30*24*3600*1000).toISOString().slice(0,10);
  const to   = req.query.to   || kst.today();
  const category = String(req.query.category || '').trim();
  try {
    const params = [req.companyId, from, to];
    let where = `company_id=$1 AND date BETWEEN $2 AND $3 AND deleted_at IS NULL`;
    if (category) {
      params.push(category);
      where += ` AND category=$${params.length}`;
    }
    params.push(limit, offset);
    const rows = await pgPool.query(SCHEMA,
      `SELECT id,
              TO_CHAR(date,'YYYY-MM-DD') AS date,
              category,
              item_name,
              amount,
              quantity,
              unit_price,
              note,
              expense_type,
              source_type,
              source_file_id,
              source_row_key,
              registered_by,
              created_at
         FROM worker.expenses
        WHERE ${where}
        ORDER BY date DESC, created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    res.json({ expenses: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/expenses/summary', requireAuth, companyFilter, async (req, res) => {
  try {
    const [daily, lifetime, currentYear, currentMonth, weekly, monthly, daily30, byCategory] = await Promise.all([
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
           FROM worker.expenses
          WHERE company_id=$1 AND date=CURRENT_DATE AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
           FROM worker.expenses
          WHERE company_id=$1 AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
           FROM worker.expenses
          WHERE company_id=$1
            AND date >= DATE_TRUNC('year', CURRENT_DATE)::date
            AND date < (DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year')::date
            AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
           FROM worker.expenses
          WHERE company_id=$1
            AND date >= DATE_TRUNC('month', CURRENT_DATE)::date
            AND date < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::date
            AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date, SUM(amount) AS total, COUNT(*) AS cnt
           FROM worker.expenses
          WHERE company_id=$1 AND date>=CURRENT_DATE-6 AND deleted_at IS NULL
          GROUP BY date ORDER BY date`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT TO_CHAR(date,'YYYY-MM') AS month, SUM(amount) AS total, COUNT(*) AS cnt
           FROM worker.expenses
          WHERE company_id=$1 AND date>=CURRENT_DATE-364 AND deleted_at IS NULL
          GROUP BY 1 ORDER BY 1`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date, SUM(amount) AS total, COUNT(*) AS cnt
           FROM worker.expenses
          WHERE company_id=$1 AND date>=CURRENT_DATE-29 AND deleted_at IS NULL
          GROUP BY date ORDER BY date`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT COALESCE(category,'기타') AS category, SUM(amount) AS total, COUNT(*) AS cnt
           FROM worker.expenses
          WHERE company_id=$1 AND deleted_at IS NULL
          GROUP BY 1
          ORDER BY total DESC, category ASC`,
        [req.companyId]),
    ]);
    res.json({
      today: { total: Number(daily?.total ?? 0), count: Number(daily?.cnt ?? 0) },
      lifetime: { total: Number(lifetime?.total ?? 0), count: Number(lifetime?.cnt ?? 0) },
      currentYear: { total: Number(currentYear?.total ?? 0), count: Number(currentYear?.cnt ?? 0) },
      currentMonth: { total: Number(currentMonth?.total ?? 0), count: Number(currentMonth?.cnt ?? 0) },
      weekly,
      monthly,
      daily30,
      byCategory,
    });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/expenses',
  requireAuth, companyFilter, auditLog('CREATE', 'expenses'),
  body('amount').isInt({ min: 1 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    const {
      amount,
      category,
      item_name,
      note,
      date,
      quantity,
      unit_price,
      expense_type,
      source_type,
      source_file_id,
      source_row_key,
    } = req.body;
    const expenseDate = date || kst.today();
    const safeExpenseType = ['fixed', 'variable'].includes(String(expense_type || '')) ? String(expense_type) : 'variable';
    const safeSourceType = String(source_type || 'manual').trim() || 'manual';
    const parsedQuantity = quantity === '' || quantity == null ? null : Number(quantity);
    const parsedUnitPrice = unit_price === '' || unit_price == null ? null : Number(unit_price);
    try {
      const expense = await pgPool.get(SCHEMA,
        `INSERT INTO worker.expenses (
           company_id,date,category,item_name,amount,quantity,unit_price,note,expense_type,
           source_type,source_file_id,source_row_key,registered_by
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, date, category, item_name, amount, quantity, unit_price, expense_type`,
        [
          req.user.company_id,
          expenseDate,
          category || '기타',
          item_name || null,
          amount,
          Number.isFinite(parsedQuantity) ? parsedQuantity : null,
          Number.isFinite(parsedUnitPrice) ? parsedUnitPrice : null,
          note || null,
          safeExpenseType,
          safeSourceType,
          source_file_id || null,
          source_row_key || null,
          req.user.id,
        ]);
      res.status(201).json({ expense });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: '이미 반영된 매입 행입니다.', code: 'DUPLICATE_EXPENSE_ROW' });
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.put('/api/expenses/:id',
  requireAuth, companyFilter, auditLog('UPDATE', 'expenses'),
  body('amount').optional().isInt({ min: 1 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.expenses WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      if (!target) return res.status(404).json({ error: '매입 항목을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (!await assertCompanyAccess(req, res, target.company_id)) return;
      const {
        amount,
        category,
        item_name,
        note,
        date,
        quantity,
        unit_price,
        expense_type,
      } = req.body;
      const parsedQuantity = quantity === '' || quantity == null ? null : Number(quantity);
      const parsedUnitPrice = unit_price === '' || unit_price == null ? null : Number(unit_price);
      const normalizedExpenseType = expense_type == null
        ? null
        : (['fixed', 'variable'].includes(String(expense_type)) ? String(expense_type) : 'variable');
      const expense = await pgPool.get(SCHEMA,
        `UPDATE worker.expenses
            SET amount=COALESCE($1,amount),
                category=COALESCE($2,category),
                item_name=COALESCE($3,item_name),
                note=COALESCE($4,note),
                date=COALESCE($5,date),
                quantity=COALESCE($6,quantity),
                unit_price=COALESCE($7,unit_price),
                expense_type=COALESCE($8,expense_type),
                updated_at=NOW()
          WHERE id=$9
        RETURNING id, date, category, item_name, amount, quantity, unit_price, expense_type`,
        [
          amount || null,
          category || null,
          item_name || null,
          note || null,
          date || null,
          Number.isFinite(parsedQuantity) ? parsedQuantity : null,
          Number.isFinite(parsedUnitPrice) ? parsedUnitPrice : null,
          normalizedExpenseType,
          req.params.id,
        ]);
      res.json({ expense });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/expenses/:id', requireAuth, companyFilter, auditLog('DELETE', 'expenses'), async (req, res) => {
  try {
    const target = await pgPool.get(SCHEMA, `SELECT company_id FROM worker.expenses WHERE id=$1`, [req.params.id]);
    if (target && !await assertCompanyAccess(req, res, target.company_id)) return;
    await pgPool.run(SCHEMA, `UPDATE worker.expenses SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/expenses/proposals', requireAuth, companyFilter, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const proposal = buildExpenseProposal({ prompt });
    const sourceRefId = `expense-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'expense_prompt',
      sourceRefType: 'expense_proposal',
      sourceRefId,
      flowCode: 'expense_create',
      actionCode: 'create_expense',
      proposalId: sourceRefId,
      aiInputText: prompt || proposal.summary,
      aiInputPayload: {
        prompt,
        amount: proposal.amount,
        category: proposal.category,
        date: proposal.date,
      },
      aiOutputType: 'expense_record',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });
    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'expense_create',
      actionCode: 'create_expense',
      query: `${prompt || proposal.summary} ${proposal.category} ${proposal.amount}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });
    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '매입 제안을 생성하지 못했습니다.', code: 'EXPENSE_PROPOSAL_FAILED' });
  }
});

app.post('/api/expenses/proposals/:id/confirm', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '매입 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    const proposal = normalizeExpenseProposal(req.body.proposal || session.original_snapshot_json || {});
    const reuseEventId = Number(req.body?.reuse_event_id || 0) || null;
    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'expense_confirm' },
    });
    const expense = await pgPool.get(SCHEMA,
      `INSERT INTO worker.expenses (
         company_id,date,category,item_name,amount,note,expense_type,source_type,registered_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,date,category,item_name,amount,note,expense_type`,
      [
        req.user.company_id,
        proposal.date,
        proposal.category || '기타',
        proposal.item_name || null,
        proposal.amount,
        proposal.note || null,
        proposal.expense_type || 'variable',
        'ai_proposal',
        req.user.id,
      ]);
    await linkDocumentReuseEvent({
      reuseEventId,
      feedbackSessionId: session.id,
      entityType: 'expense',
      entityId: expense.id,
      companyId: req.companyId,
    });
    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'expense_confirm', expense_id: expense.id },
    });
    const committedSnapshot = {
      ...proposal,
      expense_id: expense.id,
      status: 'committed',
    };
    await markWorkerFeedbackCommitted({
      sessionId: session.id,
      submittedSnapshot: committedSnapshot,
      eventMeta: { source: 'expense_confirm', expense_id: expense.id },
    });
    res.json({ ok: true, expense, proposal: committedSnapshot });
  } catch (error) {
    res.status(500).json({ error: error.message || '매입 확정 처리 중 오류가 발생했습니다.', code: 'EXPENSE_CONFIRM_FAILED' });
  }
});

app.post('/api/expenses/proposals/:id/reject', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '매입 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: { source: 'expense_reject' },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '매입 제안을 반려하지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.post('/api/expenses/import/excel',
  requireAuth, companyFilter, upload.single('file'), auditLog('IMPORT', 'expenses'),
  async (req, res) => {
    const rawName = req.file?.originalname || req.body?.filename;
    const filename = normalizeUploadedFilename(rawName);
    if (!filename?.trim()) return res.status(400).json({ error: '파일이 없습니다.', code: 'NO_FILE' });
    const filePath = req.file ? `/uploads/${req.file.filename}` : null;
    if (!filePath) return res.status(400).json({ error: '업로드 파일이 필요합니다.', code: 'NO_FILE' });

    try {
      const absolutePath = path.join(UPLOAD_DIR, path.basename(req.file.filename));
      const extraction = await extractUploadedDocument({
        absolutePath,
        filename,
        mimeType: req.file?.mimetype || '',
      });
      const expenseRows = parseExpenseRowsFromXlsxExtraction(extraction.text || '');
      if (!expenseRows.length) {
        return res.status(400).json({ error: '매입내역 시트에서 반영할 행을 찾지 못했습니다.', code: 'NO_EXPENSE_ROWS' });
      }

      const deterministicSummary = buildDeterministicSummary(extraction);
      const doc = await pgPool.get(SCHEMA,
        `INSERT INTO worker.documents (company_id,category,filename,file_path,uploaded_by,ai_summary,extracted_text,extraction_metadata,extracted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id,category,filename,ai_summary,created_at`,
        [
          req.user.company_id,
          '매입관리',
          filename,
          filePath,
          req.user.id,
          deterministicSummary || null,
          extraction.text || null,
          JSON.stringify(extraction.metadata || {}),
          extraction.text ? new Date() : null,
        ]);

      const existingRows = await pgPool.query(SCHEMA,
        `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date,
                COALESCE(category,'') AS category,
                COALESCE(item_name,'') AS item_name,
                amount,
                COALESCE(note,'') AS note
           FROM worker.expenses
          WHERE company_id=$1
            AND source_type='excel_import'
            AND deleted_at IS NULL`,
        [req.companyId]);
      const signatureSet = new Set(
        existingRows.map((row) => [row.date, row.category, row.item_name, String(row.amount), row.note].join('|'))
      );

      let importedCount = 0;
      let skippedCount = 0;
      for (const row of expenseRows) {
        const signature = [row.date, row.category || '', row.item_name || '', String(row.amount), row.note || ''].join('|');
        if (signatureSet.has(signature)) {
          skippedCount += 1;
          continue;
        }
        await pgPool.run(SCHEMA,
          `INSERT INTO worker.expenses (
             company_id,date,category,item_name,amount,quantity,unit_price,note,expense_type,
             source_type,source_file_id,source_row_key,registered_by
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            req.companyId,
            row.date,
            row.category || '기타',
            row.item_name || null,
            row.amount,
            row.quantity,
            row.unit_price,
            row.note || null,
            row.expense_type || 'variable',
            'excel_import',
            doc.id,
            row.source_row_key,
            req.user.id,
          ]);
        signatureSet.add(signature);
        importedCount += 1;
      }

      res.status(201).json({
        ok: true,
        importedCount,
        skippedCount,
        notice: buildExpenseImportNotice({ filename, importedCount, skippedCount }),
        document: {
          ...doc,
          extraction_metadata: extraction.metadata,
          extracted_text_preview: buildExtractionPreview(extraction.text),
        },
      });
    } catch (error) {
      console.error('[worker/expenses/import] 실패:', error?.stack || error?.message || error);
      res.status(500).json({ error: '매입 엑셀 import 중 오류가 발생했습니다.', code: 'EXPENSE_IMPORT_FAILED' });
    }
  }
);

// ── 문서 API (에밀리) ──────────────────────────────────────────────────

app.get('/api/documents', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const keyword  = req.query.keyword  || '';
  const category = req.query.category || '';
  const qualityStatus = String(req.query.quality_status || 'all').trim();
  const sort = String(req.query.sort || 'recent').trim();
  const params   = [req.companyId];
  let where = `company_id=$1 AND deleted_at IS NULL`;
  if (keyword)  { params.push(`%${keyword}%`);  where += ` AND (filename ILIKE $${params.length} OR ai_summary ILIKE $${params.length})`; }
  if (category) { params.push(category); where += ` AND category=$${params.length}`; }
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT d.id,
              d.category,
              d.filename,
              d.ai_summary,
              d.uploaded_by,
              d.created_at,
              d.extraction_metadata,
              COALESCE(rs.total_reuse_count, 0) AS total_reuse_count,
              COALESCE(rs.linked_reuse_count, 0) AS linked_reuse_count,
              COALESCE(rs.reviewed_reuse_count, 0) AS reviewed_reuse_count,
              COALESCE(rs.accepted_without_edit_count, 0) AS accepted_without_edit_count,
              COALESCE(rs.edited_session_count, 0) AS edited_session_count,
              COALESCE(rs.avg_edit_count, 0) AS avg_edit_count
         FROM worker.documents d
         LEFT JOIN (
           SELECT e.document_id,
                  COUNT(*) AS total_reuse_count,
                  COUNT(*) FILTER (WHERE linked_entity_type IS NOT NULL AND linked_entity_id IS NOT NULL) AS linked_reuse_count,
                  COUNT(*) FILTER (WHERE feedback_session_id IS NOT NULL) AS reviewed_reuse_count,
                  COUNT(*) FILTER (WHERE s.accepted_without_edit = true) AS accepted_without_edit_count,
                  COUNT(*) FILTER (WHERE COALESCE(fe.edit_count, 0) > 0) AS edited_session_count,
                  AVG(COALESCE(fe.edit_count, 0)::numeric) FILTER (WHERE e.feedback_session_id IS NOT NULL) AS avg_edit_count
             FROM worker.document_reuse_events e
             LEFT JOIN worker.ai_feedback_sessions s ON s.id = e.feedback_session_id
             LEFT JOIN (
               SELECT feedback_session_id,
                      COUNT(*) FILTER (
                        WHERE event_type IN ('field_edited', 'field_added', 'field_removed')
                      )::int AS edit_count
               FROM worker.ai_feedback_events
               GROUP BY feedback_session_id
             ) fe ON fe.feedback_session_id = e.feedback_session_id
            WHERE e.company_id = $1
            GROUP BY e.document_id
         ) rs ON rs.document_id = d.id
       WHERE ${where.replace(/company_id/g, 'd.company_id')} ORDER BY d.created_at DESC`,
      params);
    const documents = rows.map((row) => ({
      ...row,
      quality_summary: buildDocumentQualitySummary(row.extraction_metadata || {}),
      efficiency_summary: buildDocumentEfficiencySummary({
        ...row,
        quality_summary: buildDocumentQualitySummary(row.extraction_metadata || {}),
      }),
      download_url: `/api/documents/${row.id}/download`,
    }));
    const filtered = qualityStatus === 'all'
      ? documents
      : documents.filter((document) => String(document.quality_summary?.status || 'good') === qualityStatus);
    const sorted = filtered.sort((a, b) => compareDocumentRows(a, b, sort));
    res.json({
      documents: sorted.slice(offset, offset + limit),
    });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/documents/upload',
  requireAuth, upload.single('file'), auditLog('UPLOAD', 'documents'),
  async (req, res) => {
    const rawName   = req.file?.originalname || req.body?.filename;
    const filename  = normalizeUploadedFilename(rawName);
    if (!filename?.trim()) return res.status(400).json({ error: '파일이 없습니다.', code: 'NO_FILE' });
    const file_path = req.file ? `/uploads/${req.file.filename}` : req.body?.file_path || null;
    const category  = req.body?.category || '';

    // 규칙 기반 분류 (Gemini 없이)
    let detectedCategory = category || '기타';
    if (!category) {
      detectedCategory = detectDocumentCategory(filename, '기타');
    }

    try {
      const absolutePath = req.file ? path.join(UPLOAD_DIR, path.basename(req.file.filename)) : null;
      const extraction = absolutePath
        ? await extractUploadedDocument({
            absolutePath,
            filename,
            mimeType: req.file?.mimetype || '',
          })
        : { text: '', metadata: {} };
      const deterministicSummary = buildDeterministicSummary(extraction);
      const doc = await pgPool.get(SCHEMA,
        `INSERT INTO worker.documents (company_id,category,filename,file_path,uploaded_by,ai_summary,extracted_text,extraction_metadata,extracted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,category,filename,ai_summary,created_at`,
        [
          req.user.company_id,
          detectedCategory,
          filename,
          file_path || null,
          req.user.id,
          deterministicSummary || null,
          extraction.text || null,
          JSON.stringify(extraction.metadata || {}),
          extraction.text ? new Date() : null,
        ]);
      // RAG 자동 저장 (실패해도 본 기능 영향 없음)
      publishWorkerRagEntry({
        collection: 'rag_work_docs',
        sourceBot: 'emily',
        eventType: 'worker_document_rag',
        message: `[문서] ${filename}`,
        payload: {
          title: filename,
          summary: detectedCategory || '기타',
          details: [`document_id: ${doc.id}`],
        },
        metadata: { company_id: req.user.company_id, document_id: doc.id, category: detectedCategory },
        content: buildDocumentRagText({
          category: detectedCategory,
          filename,
          extractionText: extraction.text,
        }),
        dedupeKey: `worker-doc-rag:${req.user.company_id}:${doc.id}`,
      }).catch(() => {});
      res.status(201).json({
        document: {
          ...doc,
          extraction_metadata: extraction.metadata,
          extracted_text_preview: buildExtractionPreview(extraction.text),
        },
      });
    } catch (error) {
      console.error('[worker/documents/upload] 실패:', error?.stack || error?.message || error);
      res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.get('/api/documents/:id/download', requireAuth, companyFilter, async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT id, filename, file_path
       FROM worker.documents
       WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!row?.file_path) return res.status(404).json({ error: '문서를 찾을 수 없습니다.', code: 'NOT_FOUND' });

    const storedName = path.basename(String(row.file_path));
    const absolutePath = path.join(UPLOAD_DIR, storedName);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: '저장된 파일을 찾을 수 없습니다.', code: 'FILE_NOT_FOUND' });
    }

    return res.download(absolutePath, row.filename);
  } catch {
    res.status(500).json({ error: '문서 다운로드 중 오류가 발생했습니다.', code: 'SERVER_ERROR' });
  }
});

app.get('/api/documents/:id', requireAuth, companyFilter, async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT id, category, filename, file_path, ai_summary, uploaded_by, created_at,
              extracted_text, extraction_metadata, extracted_at
       FROM worker.documents
       WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '문서를 찾을 수 없습니다.', code: 'NOT_FOUND' });

    res.json({
      ok: true,
      document: {
        id: row.id,
        category: row.category,
        filename: row.filename,
        ai_summary: row.ai_summary || '',
        uploaded_by: row.uploaded_by,
        created_at: row.created_at,
        extracted_at: row.extracted_at,
        extracted_text_preview: buildExtractionPreview(row.extracted_text || ''),
        extraction_metadata: row.extraction_metadata || {},
        quality_summary: buildDocumentQualitySummary(row.extraction_metadata || {}),
        efficiency_summary: buildDocumentEfficiencySummary({
          extraction_metadata: row.extraction_metadata || {},
        }),
        download_url: `/api/documents/${row.id}/download`,
      },
    });
  } catch {
    res.status(500).json({ error: '문서 정보를 불러오지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.get('/api/documents/:id/reuse-events', requireAuth, companyFilter, async (req, res) => {
  try {
    const target = await pgPool.get(SCHEMA,
      `SELECT id FROM worker.documents WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!target) return res.status(404).json({ error: '문서를 찾을 수 없습니다.', code: 'NOT_FOUND' });

    const rows = await pgPool.query(SCHEMA,
      `SELECT e.id, e.target_menu, e.prompt_length, e.reused_by, e.created_at,
              e.feedback_session_id, e.linked_entity_type, e.linked_entity_id, e.committed_at,
              u.name AS reused_by_name,
              s.feedback_status,
              s.accepted_without_edit,
              COALESCE(fe.edit_count, 0) AS edit_count
       FROM worker.document_reuse_events e
       LEFT JOIN worker.users u ON u.id = e.reused_by
       LEFT JOIN worker.ai_feedback_sessions s ON s.id = e.feedback_session_id
       LEFT JOIN (
         SELECT feedback_session_id,
                COUNT(*) FILTER (
                  WHERE event_type IN ('field_edited', 'field_added', 'field_removed')
                )::int AS edit_count
         FROM worker.ai_feedback_events
         GROUP BY feedback_session_id
       ) fe ON fe.feedback_session_id = e.feedback_session_id
       WHERE e.document_id=$1 AND e.company_id=$2
       ORDER BY e.created_at DESC
       LIMIT 20`,
      [req.params.id, req.companyId]);
    res.json({ ok: true, events: rows });
  } catch {
    res.status(500).json({ error: '문서 재사용 이력을 불러오지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.post('/api/documents/:id/reuse-events', requireAuth, companyFilter, async (req, res) => {
  try {
    const targetMenu = String(req.body?.target_menu || '').trim();
    const promptLength = Math.max(0, Number(req.body?.prompt_length || 0));
    if (!targetMenu) {
      return res.status(400).json({ error: '대상 메뉴가 필요합니다.', code: 'INVALID_TARGET_MENU' });
    }
    const target = await pgPool.get(SCHEMA,
      `SELECT id FROM worker.documents WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!target) return res.status(404).json({ error: '문서를 찾을 수 없습니다.', code: 'NOT_FOUND' });

    const event = await pgPool.get(SCHEMA,
      `INSERT INTO worker.document_reuse_events (document_id, company_id, target_menu, prompt_length, reused_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, document_id, target_menu, prompt_length, reused_by, created_at`,
      [req.params.id, req.companyId, targetMenu, promptLength, req.user.id]);
    res.status(201).json({ ok: true, event });
  } catch {
    res.status(500).json({ error: '문서 재사용 이력을 저장하지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

async function linkDocumentReuseEvent({ reuseEventId, feedbackSessionId, entityType, entityId, companyId }) {
  if (!reuseEventId || !companyId) return;
  await pgPool.query(SCHEMA,
    `UPDATE worker.document_reuse_events
        SET feedback_session_id = COALESCE($3, feedback_session_id),
            linked_entity_type = COALESCE($4, linked_entity_type),
            linked_entity_id = COALESCE($5, linked_entity_id),
            committed_at = CASE
              WHEN $4 IS NOT NULL AND $5 IS NOT NULL THEN NOW()
              ELSE committed_at
            END
      WHERE id = $1 AND company_id = $2`,
    [reuseEventId, companyId, feedbackSessionId || null, entityType || null, entityId || null]);
}

app.get('/api/documents/:id/extraction', requireAuth, companyFilter, async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT id, filename, extracted_text, extraction_metadata, extracted_at
       FROM worker.documents
       WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '문서를 찾을 수 없습니다.', code: 'NOT_FOUND' });

    res.json({
      ok: true,
      document: {
        id: row.id,
        filename: row.filename,
        extracted_text: row.extracted_text || '',
        extracted_text_preview: buildExtractionPreview(row.extracted_text || ''),
        extraction_metadata: row.extraction_metadata || {},
        quality_summary: buildDocumentQualitySummary(row.extraction_metadata || {}),
        efficiency_summary: buildDocumentEfficiencySummary({
          extraction_metadata: row.extraction_metadata || {},
        }),
        extracted_at: row.extracted_at,
      },
    });
  } catch {
    res.status(500).json({ error: '문서 파싱 결과를 불러오지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.delete('/api/documents/:id', requireAuth, companyFilter, auditLog('DELETE', 'documents'), async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `UPDATE worker.documents SET deleted_at=NOW() WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '문서 없음', code: 'NOT_FOUND' });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/documents/proposals', requireAuth, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const filename = String(req.body.filename || '').trim();
    const proposal = buildDocumentProposal({ prompt, filename });
    const sourceRefId = `document-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'document_prompt',
      sourceRefType: 'document_proposal',
      sourceRefId,
      flowCode: 'document_upload',
      actionCode: 'upload_document',
      proposalId: sourceRefId,
      aiInputText: prompt,
      aiInputPayload: {
        prompt,
        filename,
      },
      aiOutputType: 'document_record',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });

    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'document_upload',
      actionCode: 'upload_document',
      query: `${prompt} ${filename} ${proposal.category} ${proposal.request_summary}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });

    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    const code = error.code || 'BAD_REQUEST';
    const status = code === 'BAD_REQUEST' ? 400 : 500;
    res.status(status).json({ error: error.message || '문서 제안을 생성하지 못했습니다.', code });
  }
});

app.post('/api/documents/proposals/:id/confirm',
  requireAuth,
  upload.single('file'),
  auditLog('UPLOAD', 'documents'),
  async (req, res) => {
    try {
      const session = await getWorkerFeedbackSessionById(Number(req.params.id));
      if (!session || String(session.user_id) !== String(req.user.id)) {
        return res.status(404).json({ error: '문서 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
      }

      const rawProposal = req.body.proposal ? JSON.parse(req.body.proposal) : (session.original_snapshot_json || {});
      const uploadedName = normalizeUploadedFilename(req.file?.originalname || '');
      const proposal = normalizeDocumentProposal({
        ...rawProposal,
        filename: rawProposal?.filename || uploadedName,
      });

      if (!req.file) {
        return res.status(400).json({ error: '업로드할 파일을 선택해주세요.', code: 'NO_FILE' });
      }

      await replaceWorkerFeedbackEdits({
        sessionId: session.id,
        submittedSnapshot: proposal,
        eventMeta: {
          source: 'document_confirm',
        },
      });

      await markWorkerFeedbackConfirmed({
        sessionId: session.id,
        submittedSnapshot: proposal,
        eventMeta: {
          source: 'document_confirm',
        },
      });

      const filePath = `/uploads/${req.file.filename}`;
      const absolutePath = path.join(UPLOAD_DIR, path.basename(req.file.filename));
      const extraction = await extractUploadedDocument({
        absolutePath,
        filename: proposal.filename || uploadedName || '업로드 문서',
        mimeType: req.file?.mimetype || '',
      });
      const document = await pgPool.get(SCHEMA,
        `INSERT INTO worker.documents (company_id,category,filename,file_path,uploaded_by,ai_summary,extracted_text,extraction_metadata,extracted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id,category,filename,ai_summary,uploaded_by,created_at`,
        [
          req.user.company_id,
          proposal.category || '기타',
          proposal.filename || uploadedName || '업로드 문서',
          filePath,
          req.user.id,
          proposal.request_summary || null,
          extraction.text || null,
          JSON.stringify(extraction.metadata || {}),
          extraction.text ? new Date() : null,
        ]);

      publishWorkerRagEntry({
        collection: 'rag_work_docs',
        sourceBot: 'emily',
        eventType: 'worker_document_rag',
        message: `[문서확정] ${document.filename}`,
        payload: {
          title: document.filename,
          summary: proposal.category || '기타',
          details: [`document_id: ${document.id}`, `feedback_session_id: ${session.id}`],
        },
        metadata: {
          company_id: req.user.company_id,
          document_id: document.id,
          category: proposal.category || '기타',
          feedback_session_id: session.id,
        },
        content: buildDocumentRagText({
          category: proposal.category || '기타',
          filename: document.filename,
          summary: proposal.request_summary || '',
          extractionText: extraction.text,
        }),
        dedupeKey: `worker-doc-rag:${req.user.company_id}:${document.id}:${session.id}`,
      }).catch(() => {});

      await markWorkerFeedbackCommitted({
        sessionId: session.id,
        submittedSnapshot: {
          ...proposal,
          document_id: document.id,
        },
        eventMeta: {
          source: 'document_confirm',
          document_id: document.id,
        },
      });

      res.status(201).json({
        ok: true,
        document: {
          ...document,
          download_url: `/api/documents/${document.id}/download`,
          extraction_metadata: extraction.metadata,
          extracted_text_preview: buildExtractionPreview(extraction.text),
        },
      });
    } catch (error) {
      console.error('[worker/documents/confirm] 실패:', error?.stack || error?.message || error);
      res.status(500).json({ error: error.message || '문서 업로드를 완료하지 못했습니다.', code: 'SERVER_ERROR' });
    }
  }
);

app.post('/api/documents/proposals/:id/reject', requireAuth, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '문서 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: {
        source: 'document_reject',
      },
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || '문서 제안을 반려하지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

// ── 업무일지 API (에밀리 확장) ───────────────────────────────────────

app.get('/api/journals', requireAuth, companyFilter, async (req, res) => {
  const { page, limit, offset } = pagination(req);
  const { date, employee_id, category, keyword } = req.query;
  const params = [req.companyId];
  let where = 'j.company_id=$1 AND j.deleted_at IS NULL';
  if (date)        { params.push(date);           where += ` AND j.date=$${params.length}`; }
  if (employee_id) { params.push(employee_id);    where += ` AND j.employee_id=$${params.length}`; }
  if (category) {
    if (category === 'general' || category === 'daily_work') {
      params.push(['general', 'task']);
      where += ` AND j.category = ANY($${params.length})`;
    } else {
      params.push(category);
      where += ` AND j.category=$${params.length}`;
    }
  }
  if (keyword)     { params.push(`%${keyword}%`); where += ` AND j.content ILIKE $${params.length}`; }
  params.push(limit, offset);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT j.*, e.name AS employee_name
       FROM worker.work_journals j
       JOIN worker.employees e ON e.id=j.employee_id
       WHERE ${where}
       ORDER BY j.date DESC, j.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params);
    res.json({ journals: rows, page, limit });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/journals/:id', requireAuth, companyFilter, async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT j.*, e.name AS employee_name
       FROM worker.work_journals j
       JOIN worker.employees e ON e.id=j.employee_id
       WHERE j.id=$1 AND j.company_id=$2 AND j.deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '업무일지를 찾을 수 없습니다.', code: 'NOT_FOUND' });
    res.json({ journal: row });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/journals/proposals', requireAuth, companyFilter, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    let emp = await pgPool.get(SCHEMA,
      `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [req.companyId, req.user.id]);
    const employeeId = emp?.id ||
      (req.body.employee_id && ['admin', 'master'].includes(req.user.role) ? Number(req.body.employee_id) : null);
    if (!employeeId) {
      return res.status(404).json({ error: '연결된 직원 정보가 없습니다. 관리자에게 문의하세요.', code: 'NOT_FOUND' });
    }

    const proposal = buildJournalProposal({ prompt });
    const sourceRefId = `journal-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'journal_prompt',
      sourceRefType: 'journal_proposal',
      sourceRefId,
      flowCode: 'journal_create',
      actionCode: 'create_journal',
      proposalId: sourceRefId,
      aiInputText: prompt || proposal.summary,
      aiInputPayload: {
        prompt,
        employee_id: employeeId,
        date: proposal.date,
        category: proposal.category,
      },
      aiOutputType: 'work_journal',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });

    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'journal_create',
      actionCode: 'create_journal',
      query: `${prompt || proposal.summary} ${proposal.category} ${proposal.content}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });

    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        employee_id: employeeId,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '업무일지 제안을 생성하지 못했습니다.', code: 'JOURNAL_PROPOSAL_FAILED' });
  }
});

app.post('/api/journals/proposals/:id/confirm', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '업무일지 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }

    let emp = await pgPool.get(SCHEMA,
      `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [req.companyId, req.user.id]);
    const employeeId = emp?.id ||
      (req.body.employee_id && ['admin', 'master'].includes(req.user.role) ? Number(req.body.employee_id) : null);
    if (!employeeId) {
      return res.status(404).json({ error: '연결된 직원 정보가 없습니다. 관리자에게 문의하세요.', code: 'NOT_FOUND' });
    }

    const proposal = normalizeJournalProposal(req.body.proposal || session.original_snapshot_json || {});
    const reuseEventId = Number(req.body?.reuse_event_id || 0) || null;
    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'journal_confirm' },
    });

    const journal = await pgPool.get(SCHEMA,
      `INSERT INTO worker.work_journals (company_id, employee_id, date, content, category)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [req.companyId, employeeId, proposal.date, proposal.content, proposal.category || 'general']);
    await linkDocumentReuseEvent({
      reuseEventId,
      feedbackSessionId: session.id,
      entityType: 'journals',
      entityId: journal.id,
      companyId: req.companyId,
    });

    publishWorkerRagEntry({
      collection: 'rag_work_docs',
      sourceBot: 'emily',
      eventType: 'worker_journal_rag',
      message: `[업무일지] ${proposal.content.slice(0, 500)}`,
      payload: {
        title: '업무일지',
        summary: proposal.category || 'general',
        details: [`journal_id: ${journal.id}`],
      },
      metadata: { company_id: req.companyId, journal_id: journal.id, category: proposal.category || 'general' },
      content: `[업무일지] ${proposal.content.slice(0, 500)}`,
      dedupeKey: `worker-journal-rag:${req.companyId}:${journal.id}`,
    }).catch(() => {});

    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'journal_confirm', journal_id: journal.id },
    });

    const committedSnapshot = {
      ...proposal,
      journal_id: journal.id,
      status: 'committed',
    };

    await markWorkerFeedbackCommitted({
      sessionId: session.id,
      submittedSnapshot: committedSnapshot,
      eventMeta: { source: 'journal_confirm', journal_id: journal.id },
    });

    res.json({ ok: true, journal, proposal: committedSnapshot });
  } catch (error) {
    res.status(500).json({ error: error.message || '업무일지 확정 처리 중 오류가 발생했습니다.', code: 'JOURNAL_CONFIRM_FAILED' });
  }
});

app.post('/api/journals/proposals/:id/reject', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '업무일지 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: { source: 'journal_reject' },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '업무일지 제안을 반려하지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.post('/api/journals',
  requireAuth, companyFilter, auditLog('CREATE', 'work_journals'),
  body('content').trim().notEmpty(),
  body('category').optional().isIn(['general','daily_work','meeting','report','other']),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { content, category, date } = req.body;
    const normalizedCategory = category === 'daily_work' || category === 'task' ? 'general' : category;
    try {
      // 사용자와 연결된 직원 조회
      let emp = await pgPool.get(SCHEMA,
        `SELECT id FROM worker.employees WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
        [req.companyId, req.user.id]);
      // 직원 미연결 시 body.employee_id (admin/master 전용)
      const empId = emp?.id ||
        (req.body.employee_id && ['admin','master'].includes(req.user.role) ? Number(req.body.employee_id) : null);
      if (!empId) return res.status(404).json({ error: '연결된 직원 정보가 없습니다. 관리자에게 문의하세요.', code: 'NOT_FOUND' });
      const row = await pgPool.get(SCHEMA,
        `INSERT INTO worker.work_journals (company_id, employee_id, date, content, category)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.companyId, empId, date || new Date().toISOString().slice(0,10), content, normalizedCategory || 'general']);
      // RAG 자동 저장 (실패해도 본 기능 영향 없음)
      publishWorkerRagEntry({
        collection: 'rag_work_docs',
        sourceBot: 'emily',
        eventType: 'worker_journal_rag',
        message: `[업무일지] ${content.slice(0, 500)}`,
        payload: {
          title: '업무일지',
          summary: normalizedCategory || 'general',
          details: [`journal_id: ${row.id}`],
        },
        metadata: { company_id: req.companyId, journal_id: row.id, category: normalizedCategory || 'general' },
        content: `[업무일지] ${content.slice(0, 500)}`,
        dedupeKey: `worker-journal-rag:${req.companyId}:${row.id}`,
      }).catch(() => {});
      res.status(201).json({ journal: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/journals/:id',
  requireAuth, companyFilter,
  body('content').optional().trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const existing = await pgPool.get(SCHEMA,
        `SELECT j.*, e.user_id FROM worker.work_journals j
         JOIN worker.employees e ON e.id=j.employee_id
         WHERE j.id=$1 AND j.company_id=$2 AND j.deleted_at IS NULL`,
        [req.params.id, req.companyId]);
      if (!existing) return res.status(404).json({ error: '업무일지를 찾을 수 없습니다.', code: 'NOT_FOUND' });
      if (existing.user_id !== req.user.id && !['admin','master'].includes(req.user.role)) {
        return res.status(403).json({ error: '본인 작성만 수정할 수 있습니다.', code: 'FORBIDDEN' });
      }
      const { content, category } = req.body;
      const normalizedCategory = category === 'daily_work' || category === 'task' ? 'general' : category;
      const row = await pgPool.get(SCHEMA,
        `UPDATE worker.work_journals
         SET content=COALESCE($1,content), category=COALESCE($2,category), updated_at=NOW()
         WHERE id=$3 RETURNING *`,
        [content || null, normalizedCategory || null, req.params.id]);
      await pgPool.run(SCHEMA,
        `INSERT INTO worker.audit_log (company_id,user_id,action,target_type,target_id)
         VALUES ($1,$2,'update','work_journal',$3)`,
        [req.companyId, req.user.id, req.params.id]);
      res.json({ journal: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/journals/:id', requireAuth, companyFilter, async (req, res) => {
  try {
    const existing = await pgPool.get(SCHEMA,
      `SELECT j.*, e.user_id FROM worker.work_journals j
       JOIN worker.employees e ON e.id=j.employee_id
       WHERE j.id=$1 AND j.company_id=$2 AND j.deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!existing) return res.status(404).json({ error: '업무일지를 찾을 수 없습니다.', code: 'NOT_FOUND' });
    if (existing.user_id !== req.user.id && !['admin','master'].includes(req.user.role)) {
      return res.status(403).json({ error: '본인 작성만 삭제할 수 있습니다.', code: 'FORBIDDEN' });
    }
    await pgPool.run(SCHEMA, `UPDATE worker.work_journals SET deleted_at=NOW() WHERE id=$1`, [req.params.id]);
    await pgPool.run(SCHEMA,
      `INSERT INTO worker.audit_log (company_id,user_id,action,target_type,target_id)
       VALUES ($1,$2,'delete','work_journal',$3)`,
      [req.companyId, req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 대시보드 요약 API ─────────────────────────────────────────────────

app.get('/api/dashboard/summary', requireAuth, companyFilter, async (req, res) => {
  try {
    await syncSkaSalesToWorker(req.companyId);
    const [salesRow, attendRow, docsRow, approvalsRow, projectsRow, schedulesRow] = await Promise.all([
      pgPool.get(SCHEMA,
        `SELECT COALESCE(SUM(amount),0) AS total FROM worker.sales
         WHERE company_id=$1 AND date=CURRENT_DATE AND deleted_at IS NULL`, [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.attendance a
         JOIN worker.employees e ON e.id=a.employee_id
         WHERE a.company_id=$1 AND a.date=CURRENT_DATE AND a.check_in IS NOT NULL AND e.deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.documents
         WHERE company_id=$1 AND ai_summary IS NULL AND deleted_at IS NULL`, [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.approval_requests
         WHERE company_id=$1 AND status='pending' AND deleted_at IS NULL`, [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.projects
         WHERE company_id=$1 AND status IN ('planning','in_progress','review') AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.schedules
         WHERE company_id=$1 AND deleted_at IS NULL AND start_time::date=CURRENT_DATE`,
        [req.companyId]),
    ]);
    res.json({
      today_sales:       Number(salesRow?.total     ?? 0),
      checked_in:        Number(attendRow?.cnt      ?? 0),
      pending_docs:      Number(docsRow?.cnt        ?? 0),
      pending_approvals: Number(approvalsRow?.cnt   ?? 0),
      active_projects:   Number(projectsRow?.cnt    ?? 0),
      today_schedules:   Number(schedulesRow?.cnt   ?? 0),
    });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/dashboard/alerts', requireAuth, requireRole('master', 'admin'), companyFilter, async (req, res) => {
  try {
    const [pendingApprovalsRow, uncheckedRows, upcomingSchedules, pendingDocsRow, dueProjects] = await Promise.all([
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt FROM worker.approval_requests
         WHERE company_id=$1 AND status='pending' AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT e.id, e.name, e.department, e.position
         FROM worker.employees e
         LEFT JOIN worker.attendance a
           ON a.employee_id=e.id
          AND a.company_id=e.company_id
          AND a.date=CURRENT_DATE
         WHERE e.company_id=$1
           AND e.deleted_at IS NULL
           AND COALESCE(e.status, 'active')='active'
           AND a.check_in IS NULL
         ORDER BY e.name ASC
         LIMIT 5`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT id, title, start_time, type
         FROM worker.schedules
         WHERE company_id=$1
           AND deleted_at IS NULL
           AND start_time >= NOW()
           AND start_time < NOW() + INTERVAL '6 hours'
         ORDER BY start_time ASC
         LIMIT 3`,
        [req.companyId]),
      pgPool.get(SCHEMA,
        `SELECT COUNT(*) AS cnt
         FROM worker.documents
         WHERE company_id=$1
           AND ai_summary IS NULL
           AND deleted_at IS NULL`,
        [req.companyId]),
      pgPool.query(SCHEMA,
        `SELECT id, name, status, end_date
         FROM worker.projects
         WHERE company_id=$1
           AND deleted_at IS NULL
           AND status IN ('planning','in_progress','review')
           AND end_date IS NOT NULL
           AND end_date <= CURRENT_DATE + INTERVAL '7 days'
         ORDER BY end_date ASC
         LIMIT 3`,
        [req.companyId]),
    ]);

    const nowMinutes = (kst.currentHour() * 60) + kst.currentMinute();
    const workdayStartMinutes = 9 * 60;
    const minutesUntilCheckIn = Math.max(workdayStartMinutes - nowMinutes, 0);

    res.json({
      pending_approvals: Number(pendingApprovalsRow?.cnt ?? 0),
      unchecked_in_count: uncheckedRows.length,
      unchecked_in_preview: uncheckedRows,
      minutes_until_checkin: minutesUntilCheckIn,
      upcoming_schedules: upcomingSchedules,
      pending_docs_count: Number(pendingDocsRow?.cnt ?? 0),
      due_projects_count: dueProjects.length,
      due_projects_preview: dueProjects,
      generated_at: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
  }
});

// ── 최근 활동 피드 ────────────────────────────────────────────────────
app.get('/api/activity', requireAuth, companyFilter, async (req, res) => {
  try {
    const rows = await pgPool.query(SCHEMA, `
      SELECT type, created_at, actor, detail, priority_rank FROM (
        SELECT 'approval' AS type,
               COALESCE(ar.updated_at, ar.created_at) AS created_at,
               COALESCE(u.name, '승인 대기') AS actor,
               CONCAT(
                 CASE
                   WHEN ar.category = 'leave' OR ar.action = 'leave_request' THEN '휴가'
                   WHEN ar.category = 'attendance' THEN '근태'
                   WHEN ar.category = 'employee' THEN '직원'
                   WHEN ar.category = 'payroll' THEN '급여'
                   WHEN ar.category = 'schedule' THEN '일정'
                   WHEN ar.category = 'sales' THEN '매출'
                   WHEN ar.category = 'project' THEN '프로젝트'
                   ELSE COALESCE(ar.category, '업무')
                 END,
                 ' ',
                 CASE
                   WHEN ar.status = 'pending' THEN '승인 대기 중입니다'
                   WHEN ar.status = 'approved' THEN '승인되었습니다'
                   WHEN ar.status = 'rejected' THEN '반려되었습니다'
                   ELSE '상태가 갱신되었습니다'
                 END
               ) AS detail,
               CASE WHEN ar.status = 'pending' THEN 1 ELSE 2 END AS priority_rank
        FROM worker.approval_requests ar
        LEFT JOIN worker.users u ON u.id = ar.approver_id
        WHERE ar.company_id = $1 AND ar.deleted_at IS NULL
        UNION ALL
        SELECT 'attendance' AS type,
               COALESCE(a.check_out, a.created_at) AS created_at,
               e.name AS actor,
               CONCAT(
                 COALESCE(e.name,'직원'),
                 '이(가) ',
                 CASE WHEN a.check_out IS NOT NULL THEN '퇴근' ELSE '출근' END,
                 ' 체크했습니다'
               ) AS detail,
               2 AS priority_rank
        FROM worker.attendance a
        LEFT JOIN worker.employees e ON e.id = a.employee_id
        WHERE a.company_id = $1
        UNION ALL
        SELECT 'schedule' AS type,
               COALESCE(s.updated_at, s.created_at) AS created_at,
               NULL AS actor,
               CONCAT(COALESCE(s.title, '일정'), ' 일정이 등록되거나 갱신되었습니다') AS detail,
               CASE
                 WHEN s.start_time::date = (NOW() AT TIME ZONE 'Asia/Seoul')::date THEN 2
                 ELSE 3
               END AS priority_rank
        FROM worker.schedules s
        WHERE s.company_id = $1 AND s.deleted_at IS NULL
        UNION ALL
        SELECT 'sales' AS type, s.created_at, NULL AS actor,
               CONCAT('₩', TO_CHAR(s.amount, 'FM999,999,999'), ' 매출이 등록되었습니다') AS detail,
               3 AS priority_rank
        FROM worker.sales s
        WHERE s.company_id = $1 AND s.deleted_at IS NULL
        UNION ALL
        SELECT 'document' AS type,
               d.created_at,
               COALESCE(u.name, '업무 시스템') AS actor,
               CONCAT(COALESCE(d.filename, '문서'), ' 문서가 업로드되었습니다') AS detail,
               CASE WHEN COALESCE(NULLIF(TRIM(d.ai_summary), ''), '') = '' THEN 2 ELSE 3 END AS priority_rank
        FROM worker.documents d
        LEFT JOIN worker.users u ON u.id = d.uploaded_by
        WHERE d.company_id = $1 AND d.deleted_at IS NULL
        UNION ALL
        SELECT 'project' AS type,
               COALESCE(p.updated_at, p.created_at) AS created_at,
               e.name AS actor,
               CONCAT(COALESCE(p.name, '프로젝트'), ' 진행 상태가 갱신되었습니다') AS detail,
               CASE
                 WHEN p.status IN ('planning', 'in_progress', 'review')
                      AND p.end_date IS NOT NULL
                      AND p.end_date <= ((NOW() AT TIME ZONE 'Asia/Seoul')::date + INTERVAL '7 days')::date
                   THEN 2
                 ELSE 3
               END AS priority_rank
        FROM worker.projects p
        LEFT JOIN worker.employees e ON e.id = p.owner_id
        WHERE p.company_id = $1 AND p.deleted_at IS NULL
        UNION ALL
        SELECT 'journal' AS type, j.created_at, e.name AS actor,
               CONCAT(COALESCE(e.name,'직원'), '이(가) 업무일지를 작성했습니다') AS detail
               , 4 AS priority_rank
        FROM worker.work_journals j
        LEFT JOIN worker.employees e ON e.id = j.employee_id
        WHERE j.company_id = $1 AND j.deleted_at IS NULL
      ) t
      ORDER BY priority_rank ASC, created_at DESC
      LIMIT 10
    `, [req.companyId]);
    res.json({ activities: rows });
  } catch (e) {
    console.error('[activity]', e.message);
    res.status(500).json({ error: '활동 조회 실패' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Phase 3 API — 급여(소피) / 프로젝트(라이언) / 일정(클로이)
// ══════════════════════════════════════════════════════════════════════

// ── 급여 API (소피) ────────────────────────────────────────────────────

app.get('/api/payroll', requireAuth, companyFilter, async (req, res) => {
  const yearMonth = req.query.year_month || new Date().toISOString().slice(0, 7);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT p.*, e.name AS employee_name
       FROM worker.payroll p JOIN worker.employees e ON e.id=p.employee_id
       WHERE p.company_id=$1 AND p.year_month=$2
       ORDER BY e.name`,
      [req.companyId, yearMonth]);
    res.json({ payroll: rows, year_month: yearMonth });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/payroll/summary', requireAuth, companyFilter, async (req, res) => {
  const yearMonth = req.query.year_month || new Date().toISOString().slice(0, 7);
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(net_salary),0) AS total_net,
              COALESCE(SUM(deduction),0) AS total_deduction,
              COALESCE(SUM(base_salary),0) AS total_base
       FROM worker.payroll WHERE company_id=$1 AND year_month=$2`,
      [req.companyId, yearMonth]);
    res.json({ summary: row, year_month: yearMonth });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/payroll/:id', requireAuth, companyFilter, async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT p.*, e.name AS employee_name
       FROM worker.payroll p JOIN worker.employees e ON e.id=p.employee_id
       WHERE p.id=$1 AND p.company_id=$2`,
      [req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '급여 정보 없음', code: 'NOT_FOUND' });
    res.json({ payroll: row });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/payroll/proposals', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const proposal = buildPayrollProposal({
      prompt,
      now: new Date(),
    });
    const sourceRefId = `payroll-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'payroll_prompt',
      sourceRefType: 'payroll_proposal',
      sourceRefId,
      flowCode: 'payroll_calculate',
      actionCode: 'calculate_payroll',
      proposalId: sourceRefId,
      aiInputText: prompt || proposal.summary,
      aiInputPayload: {
        prompt,
        year_month: proposal.year_month,
      },
      aiOutputType: 'payroll_batch',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });
    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'payroll_calculate',
      actionCode: 'calculate_payroll',
      query: `${prompt || proposal.summary} ${proposal.year_month}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });
    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '급여 제안을 생성하지 못했습니다.', code: 'PAYROLL_PROPOSAL_FAILED' });
  }
});

app.post('/api/payroll/proposals/:id/confirm', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '급여 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    const proposal = normalizePayrollProposal(req.body.proposal || session.original_snapshot_json || {});
    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'payroll_confirm' },
    });
    const { calculatePayroll } = require('../src/sophie');
    const results = await calculatePayroll(req.companyId, proposal.year_month);
    const totalNet = results.reduce((sum, row) => sum + Number(row.net_salary || 0), 0);
    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: {
        source: 'payroll_confirm',
        year_month: proposal.year_month,
        result_count: results.length,
      },
    });
    const committedSnapshot = {
      ...proposal,
      result_count: results.length,
      total_net_salary: totalNet,
      status: 'committed',
    };
    await markWorkerFeedbackCommitted({
      sessionId: session.id,
      submittedSnapshot: committedSnapshot,
      eventMeta: {
        source: 'payroll_confirm',
        year_month: proposal.year_month,
        result_count: results.length,
      },
    });
    res.json({
      ok: true,
      count: results.length,
      year_month: proposal.year_month,
      proposal: committedSnapshot,
      message: `${proposal.year_month} 급여 계산이 완료되었습니다.`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || '급여 확정 처리 중 오류가 발생했습니다.', code: 'PAYROLL_CONFIRM_FAILED' });
  }
});

app.post('/api/payroll/proposals/:id/reject', requireAuth, requireRole('master','admin'), companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '급여 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: { source: 'payroll_reject' },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '급여 제안을 반려하지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.post('/api/payroll/calculate', requireAuth, requireRole('master','admin'), companyFilter, auditLog('CALCULATE', 'payroll'), async (req, res) => {
  const yearMonth = req.body.year_month || new Date().toISOString().slice(0, 7);
  try {
    const { calculatePayroll } = require('../src/sophie');
    const results = await calculatePayroll(req.companyId, yearMonth);
    res.json({ ok: true, count: results.length, year_month: yearMonth });
  } catch (e) { res.status(500).json({ error: e.message, code: 'SERVER_ERROR' }); }
});

app.put('/api/payroll/:id', requireAuth, requireRole('master','admin'), auditLog('UPDATE', 'payroll'), async (req, res) => {
  const { net_salary, status, incentive, base_salary } = req.body;
  try {
    const row = await pgPool.get(SCHEMA,
      `UPDATE worker.payroll
       SET net_salary=COALESCE($1,net_salary), status=COALESCE($2,status),
           incentive=COALESCE($3,incentive), base_salary=COALESCE($4,base_salary),
           confirmed_by=$5, updated_at=NOW()
       WHERE id=$6 AND company_id=$7 RETURNING *`,
      [net_salary??null, status||null, incentive??null, base_salary??null,
       req.user.id, req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '급여 정보 없음', code: 'NOT_FOUND' });
    res.json({ payroll: row });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 프로젝트 API (라이언) ──────────────────────────────────────────────

app.get('/api/agent-tasks', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const status = req.query.status || '';
  const params = [req.companyId];
  let where = 't.company_id=$1';
  if (status) {
    params.push(status);
    where += ` AND t.status=$${params.length}`;
  }
  params.push(limit, offset);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT t.*, u.name AS user_name, ar.status AS approval_status
       FROM worker.agent_tasks t
       LEFT JOIN worker.users u ON u.id = t.user_id
       LEFT JOIN worker.approval_requests ar ON ar.id = t.approval_id
       WHERE ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    res.json({ tasks: rows });
  } catch {
    res.status(500).json({ error: '업무 큐를 불러오지 못했습니다.', code: 'AGENT_TASK_LOAD_FAILED' });
  }
});

app.get('/api/projects', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  const status = req.query.status || '';
  const params = [req.companyId];
  let where = 'p.company_id=$1 AND p.deleted_at IS NULL';
  if (status) { params.push(status); where += ` AND p.status=$${params.length}`; }
  params.push(limit, offset);
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT p.*, e.name AS owner_name
       FROM worker.projects p LEFT JOIN worker.employees e ON e.id=p.owner_id
       WHERE ${where}
       ORDER BY p.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params);
    res.json({ projects: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/projects',
  requireAuth, companyFilter, auditLog('CREATE', 'projects'),
  body('name').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { name, description, owner_id, start_date, end_date } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `INSERT INTO worker.projects (company_id, name, description, owner_id, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.companyId, name, description||null, owner_id||null, start_date||null, end_date||null]);
      res.status(201).json({ project: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.post('/api/projects/proposals', requireAuth, companyFilter, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const proposal = buildProjectProposal({ prompt });
    const sourceRefId = `project-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'project_prompt',
      sourceRefType: 'project_proposal',
      sourceRefId,
      flowCode: 'project_create',
      actionCode: 'create_project',
      proposalId: sourceRefId,
      aiInputText: prompt || proposal.summary,
      aiInputPayload: {
        prompt,
        name: proposal.name,
      },
      aiOutputType: 'project_record',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });
    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'project_create',
      actionCode: 'create_project',
      query: `${prompt || proposal.summary} ${proposal.name}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });
    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '프로젝트 제안을 생성하지 못했습니다.', code: 'PROJECT_PROPOSAL_FAILED' });
  }
});

app.post('/api/projects/proposals/:id/confirm', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '프로젝트 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    const proposal = normalizeProjectProposal(req.body.proposal || session.original_snapshot_json || {});
    const reuseEventId = Number(req.body?.reuse_event_id || 0) || null;
    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'project_confirm' },
    });
    const row = await pgPool.get(SCHEMA,
      `INSERT INTO worker.projects (company_id, name, description, status, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.companyId, proposal.name, proposal.description || null, proposal.status || 'planning', proposal.start_date || null, proposal.end_date || null]);
    await linkDocumentReuseEvent({
      reuseEventId,
      feedbackSessionId: session.id,
      entityType: 'projects',
      entityId: row.id,
      companyId: req.companyId,
    });
    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'project_confirm', project_id: row.id },
    });
    const committedSnapshot = {
      ...proposal,
      project_id: row.id,
      status: 'committed',
    };
    await markWorkerFeedbackCommitted({
      sessionId: session.id,
      submittedSnapshot: committedSnapshot,
      eventMeta: { source: 'project_confirm', project_id: row.id },
    });
    res.json({ ok: true, project: row, proposal: committedSnapshot });
  } catch (error) {
    res.status(500).json({ error: error.message || '프로젝트 확정 처리 중 오류가 발생했습니다.', code: 'PROJECT_CONFIRM_FAILED' });
  }
});

app.post('/api/projects/proposals/:id/reject', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '프로젝트 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: { source: 'project_reject' },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '프로젝트 제안을 반려하지 못했습니다.', code: 'SERVER_ERROR' });
  }
});

app.get('/api/projects/:id', requireAuth, companyFilter, async (req, res) => {
  try {
    const row = await pgPool.get(SCHEMA,
      `SELECT p.*, e.name AS owner_name
       FROM worker.projects p LEFT JOIN worker.employees e ON e.id=p.owner_id
       WHERE p.id=$1 AND p.company_id=$2 AND p.deleted_at IS NULL`,
      [req.params.id, req.companyId]);
    if (!row) return res.status(404).json({ error: '프로젝트 없음', code: 'NOT_FOUND' });
    res.json({ project: row });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.put('/api/projects/:id',
  requireAuth, companyFilter, auditLog('UPDATE', 'projects'),
  body('name').optional().trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { name, description, status, owner_id, start_date, end_date, progress } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `UPDATE worker.projects
         SET name=COALESCE($1,name), description=COALESCE($2,description),
             status=COALESCE($3,status), owner_id=COALESCE($4,owner_id),
             start_date=COALESCE($5,start_date), end_date=COALESCE($6,end_date),
             progress=COALESCE($7,progress), updated_at=NOW()
         WHERE id=$8 AND company_id=$9 AND deleted_at IS NULL RETURNING *`,
        [name||null, description||null, status||null, owner_id||null,
         start_date||null, end_date||null, progress??null,
         req.params.id, req.companyId]);
      if (!row) return res.status(404).json({ error: '프로젝트 없음', code: 'NOT_FOUND' });
      res.json({ project: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/projects/:id', requireAuth, companyFilter, auditLog('DELETE', 'projects'), async (req, res) => {
  try {
    await pgPool.run(SCHEMA,
      `UPDATE worker.projects SET deleted_at=NOW() WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 마일스톤 API (라이언) ──────────────────────────────────────────────

app.get('/api/projects/:id/milestones', requireAuth, companyFilter, async (req, res) => {
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT m.*, e.name AS assignee_name
       FROM worker.milestones m LEFT JOIN worker.employees e ON e.id=m.assigned_to
       WHERE m.project_id=$1 AND m.company_id=$2 AND m.deleted_at IS NULL
       ORDER BY m.due_date ASC NULLS LAST, m.created_at ASC`,
      [req.params.id, req.companyId]);
    res.json({ milestones: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/projects/:id/milestones',
  requireAuth, companyFilter, requireRole('master','admin'), auditLog('CREATE', 'milestones'),
  body('title').trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { title, description, due_date, assigned_to } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `INSERT INTO worker.milestones (project_id, company_id, title, description, due_date, assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, req.companyId, title, description||null, due_date||null, assigned_to||null]);
      await recalcProgress(req.params.id, req.companyId);
      res.status(201).json({ milestone: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.put('/api/milestones/:id',
  requireAuth, companyFilter, requireRole('master','admin'), auditLog('UPDATE', 'milestones'),
  async (req, res) => {
    const { title, description, status, due_date, assigned_to } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `UPDATE worker.milestones AS m
         SET title=COALESCE($1, m.title),
             description=COALESCE($2, m.description),
             status=COALESCE($3, m.status),
             due_date=COALESCE($4, m.due_date),
             assigned_to=COALESCE($5, m.assigned_to),
             completed_at=CASE WHEN $3='completed' THEN NOW() ELSE m.completed_at END
         FROM worker.projects AS p
         WHERE m.id=$6
           AND m.deleted_at IS NULL
           AND m.project_id = p.id
           AND p.company_id = $7
         RETURNING m.*`,
        [title||null, description||null, status||null, due_date||null,
         assigned_to||null, req.params.id, req.companyId]);
      if (!row) return res.status(404).json({ error: '마일스톤 없음', code: 'NOT_FOUND' });
      await recalcProgress(row.project_id, req.companyId);
      res.json({ milestone: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

// ── 일정 API (클로이) ──────────────────────────────────────────────────

app.get('/api/schedules', requireAuth, companyFilter, async (req, res) => {
  const { limit, offset } = pagination(req);
  let from, to;
  if (req.query.year_month) {
    from = `${req.query.year_month}-01`;
    to   = getEndOfMonthStr(req.query.year_month);
  } else {
    from = req.query.from || getKstToday();
    to   = req.query.to   || kst.daysAgoStr(-30);
  }
  try {
    const rows = await pgPool.query(SCHEMA,
      `SELECT * FROM worker.schedules
       WHERE company_id=$1 AND deleted_at IS NULL
         AND start_time::date BETWEEN $2 AND $3
       ORDER BY start_time LIMIT $4 OFFSET $5`,
      [req.companyId, from, to, limit, offset]);
    res.json({ schedules: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.get('/api/schedules/today', requireAuth, companyFilter, async (req, res) => {
  try {
    const { getTodaySchedules } = require('../src/chloe');
    const rows = await getTodaySchedules(req.companyId);
    res.json({ schedules: rows });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

app.post('/api/schedules',
  requireAuth, companyFilter, auditLog('CREATE', 'schedules'),
  body('title').trim().notEmpty(),
  body('start_time').notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { title, description, type, start_time, end_time, all_day, location, attendees, recurrence, reminder } = req.body;
    try {
      const employeeId = await getEmployeeIdForRequest(req);
      const row = await pgPool.get(SCHEMA,
        `INSERT INTO worker.schedules
           (company_id, title, description, type, start_time, end_time, all_day,
            location, attendees, recurrence, reminder, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.companyId, title, description||null, type||'task',
         start_time, end_time||null, all_day||false,
         location||null, JSON.stringify(attendees||[]),
         recurrence||null, reminder??30, employeeId]);
      // RAG 자동 저장 (실패해도 본 기능 영향 없음)
      publishWorkerRagEntry({
        collection: 'rag_schedule',
        sourceBot: 'chloe',
        eventType: 'worker_schedule_rag',
        message: `[일정] ${title} | ${start_time}${end_time ? '~' + end_time : ''} | ${type || 'task'}`,
        payload: {
          title,
          summary: `${start_time}${end_time ? `~${end_time}` : ''} | ${type || 'task'}`,
          details: [`schedule_id: ${row.id}`],
        },
        metadata: { company_id: req.companyId, schedule_id: row.id, type: type || 'task' },
        content: `[일정] ${title} | ${start_time}${end_time ? '~' + end_time : ''} | ${type || 'task'}`,
        dedupeKey: `worker-schedule-rag:${req.companyId}:${row.id}`,
      }).catch(() => {});
      res.status(201).json({ schedule: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.post('/api/schedules/proposals', requireAuth, companyFilter, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const fallbackType = String(req.body.type || '').trim();
    const proposal = buildScheduleProposal({
      prompt,
      fallbackType,
      now: new Date(),
    });
    const sourceRefId = `schedule-proposal:${randomUUID()}`;
    const session = await createWorkerProposalFeedbackSession({
      companyId: req.user.company_id,
      userId: req.user.id,
      sourceType: 'schedule_prompt',
      sourceRefType: 'schedule_proposal',
      sourceRefId,
      flowCode: 'schedule_create',
      actionCode: 'create_schedule',
      proposalId: sourceRefId,
      aiInputText: prompt || proposal.title,
      aiInputPayload: {
        prompt,
        type: fallbackType || proposal.type,
      },
      aiOutputType: 'schedule_record',
      originalSnapshot: proposal,
      eventMeta: proposal.parser_meta,
    });
    const similarCases = await searchFeedbackCases(rag, {
      schema: SCHEMA,
      flowCode: 'schedule_create',
      actionCode: 'create_schedule',
      query: `${prompt || proposal.summary} ${proposal.title} ${proposal.type}`.trim(),
      acceptedWithoutEditOnly: true,
      sourceBot: 'worker-feedback',
    });
    res.json({
      ok: true,
      session_id: session.id,
      proposal: {
        ...proposal,
        feedback_session_id: session.id,
        similar_cases: similarCases,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '일정 제안을 생성하지 못했습니다.', code: 'SCHEDULE_PROPOSAL_FAILED' });
  }
});

app.post('/api/schedules/proposals/:id/confirm', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '일정 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    const proposal = normalizeScheduleProposal(req.body.proposal || session.original_snapshot_json || {});
    const reuseEventId = Number(req.body?.reuse_event_id || 0) || null;
    await replaceWorkerFeedbackEdits({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'schedule_confirm' },
    });
    const employeeId = await getEmployeeIdForRequest(req);
    const row = await pgPool.get(SCHEMA,
      `INSERT INTO worker.schedules
         (company_id, title, description, type, start_time, end_time, all_day,
          location, attendees, recurrence, reminder, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.companyId, proposal.title, proposal.description || null, proposal.type || 'task',
        proposal.start_time, proposal.end_time || null, proposal.all_day || false,
        proposal.location || null, JSON.stringify(proposal.attendees || []),
        proposal.recurrence || null, proposal.reminder ?? 30, employeeId]);
    await linkDocumentReuseEvent({
      reuseEventId,
      feedbackSessionId: session.id,
      entityType: 'schedules',
      entityId: row.id,
      companyId: req.companyId,
    });
    await markWorkerFeedbackConfirmed({
      sessionId: session.id,
      submittedSnapshot: proposal,
      eventMeta: { source: 'schedule_confirm', schedule_id: row.id },
    });
    const committedSnapshot = {
      ...proposal,
      schedule_id: row.id,
      status: 'committed',
    };
    await markWorkerFeedbackCommitted({
      sessionId: session.id,
      submittedSnapshot: committedSnapshot,
      eventMeta: { source: 'schedule_confirm', schedule_id: row.id },
    });
    publishWorkerRagEntry({
      collection: 'rag_schedule',
      sourceBot: 'chloe',
      eventType: 'worker_schedule_rag',
      message: `[일정] ${proposal.title} | ${proposal.start_time}${proposal.end_time ? `~${proposal.end_time}` : ''} | ${proposal.type || 'task'}`,
      payload: {
        title: proposal.title,
        summary: `${proposal.start_time}${proposal.end_time ? `~${proposal.end_time}` : ''} | ${proposal.type || 'task'}`,
        details: [`schedule_id: ${row.id}`],
      },
      metadata: { company_id: req.companyId, schedule_id: row.id, type: proposal.type || 'task' },
      content: `[일정] ${proposal.title} | ${proposal.start_time}${proposal.end_time ? `~${proposal.end_time}` : ''} | ${proposal.type || 'task'}`,
      dedupeKey: `worker-schedule-rag:${req.companyId}:${row.id}`,
    }).catch(() => {});
    res.json({ ok: true, schedule: row, proposal: committedSnapshot });
  } catch (error) {
    res.status(500).json({ error: error.message || '일정 확정 처리 중 오류가 발생했습니다.', code: 'SCHEDULE_CONFIRM_FAILED' });
  }
});

app.post('/api/schedules/proposals/:id/reject', requireAuth, companyFilter, async (req, res) => {
  try {
    const session = await getWorkerFeedbackSessionById(Number(req.params.id));
    if (!session || String(session.user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: '일정 제안을 찾을 수 없습니다.', code: 'NOT_FOUND' });
    }
    await markWorkerFeedbackRejected({
      sessionId: session.id,
      submittedSnapshot: session.original_snapshot_json || {},
      eventMeta: { source: 'schedule_reject' },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '일정 제안을 반려하지 못했습니다.', code: 'SCHEDULE_REJECT_FAILED' });
  }
});

app.put('/api/schedules/:id',
  requireAuth, companyFilter, auditLog('UPDATE', 'schedules'),
  body('title').optional().trim().notEmpty(),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { title, description, type, start_time, end_time, all_day, location, attendees, recurrence } = req.body;
    try {
      const row = await pgPool.get(SCHEMA,
        `UPDATE worker.schedules
         SET title=COALESCE($1,title), description=COALESCE($2,description),
             type=COALESCE($3,type), start_time=COALESCE($4,start_time),
             end_time=COALESCE($5,end_time), all_day=COALESCE($6,all_day),
             location=COALESCE($7,location),
             attendees=COALESCE($8,attendees), recurrence=COALESCE($9,recurrence),
             updated_at=NOW()
         WHERE id=$10 AND company_id=$11 AND deleted_at IS NULL RETURNING *`,
        [title||null, description||null, type||null, start_time||null,
         end_time||null, all_day??null, location||null,
         attendees?JSON.stringify(attendees):null,
         recurrence||null, req.params.id, req.companyId]);
      if (!row) return res.status(404).json({ error: '일정 없음', code: 'NOT_FOUND' });
      res.json({ schedule: row });
    } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
  }
);

app.delete('/api/schedules/:id', requireAuth, companyFilter, auditLog('DELETE', 'schedules'), async (req, res) => {
  try {
    await pgPool.run(SCHEMA,
      `UPDATE worker.schedules SET deleted_at=NOW() WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' }); }
});

// ── 자연어 업무 대화 API (Worker v2) ─────────────────────────────────

app.get('/api/chat/sessions', requireAuth, companyFilter, async (req, res) => {
  try {
    const sessions = await listChatSessions(req.companyId, req.user.id);
    res.json({ sessions });
  } catch {
    res.status(500).json({ error: '대화 세션을 불러오지 못했습니다.', code: 'CHAT_SESSION_LOAD_FAILED' });
  }
});

app.get('/api/chat/sessions/:id/messages', requireAuth, companyFilter, async (req, res) => {
  try {
    const messages = await listChatMessages(req.params.id, req.companyId, req.user.id);
    res.json({ messages });
  } catch {
    res.status(500).json({ error: '대화 메시지를 불러오지 못했습니다.', code: 'CHAT_MESSAGE_LOAD_FAILED' });
  }
});

app.get('/api/chat/unrec', requireAuth, requireRole('master'), async (req, res) => {
  try {
    const filters = parseUnrecognizedQuery(req.query.q || '');
    const { rows, candidates } = await getUnrecognizedReportRows(pgPool, { schema: SCHEMA });
    const candidateMap = new Map(candidates.map(row => [normalizeIntentText(row.sample_text || ''), row]));
    const summary = buildUnrecognizedSummary(
      rows,
      (row) => candidateMap.get(normalizeIntentText(row.text || '')),
    );
    res.json({
      summaryOnly: !!filters.summaryOnly,
      summary,
      rows: filters.summaryOnly ? [] : rows,
      candidates: filters.summaryOnly ? [] : candidates.map((candidate) => ({
        ...candidate,
        status: getPromotionCandidateStatus(candidate),
        reason: getPromotionEventReason(candidate.latest_event_metadata),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: '워커 인텐트 미인식 리포트를 불러오지 못했습니다.', code: 'WORKER_INTENT_UNREC_FAILED', detail: e.message });
  }
});

app.get('/api/chat/promotions', requireAuth, requireRole('master'), async (req, res) => {
  try {
    const filters = parsePromotionQuery(req.query.q || '');
    const summary = await getPromotionSummary(pgPool, { schema: SCHEMA, filters });
    const rows = (filters.summaryOnly || filters.thresholdsOnly)
      ? []
      : await getPromotionRows(pgPool, { schema: SCHEMA, filters, limit: 20 });
    const events = filters.thresholdsOnly ? [] : await getPromotionEvents(pgPool, { schema: SCHEMA, filters, limit: 10 });
    const families = buildPromotionFamilySummary(rows);
    res.json({
      filters,
      summary,
      families,
      candidates: rows.map((candidate) => ({
        ...candidate,
        status: getPromotionCandidateStatus(candidate),
        reason: getPromotionEventReason(candidate.latest_event_metadata),
      })),
      events,
    });
  } catch (e) {
    res.status(500).json({ error: '워커 인텐트 후보 리포트를 불러오지 못했습니다.', code: 'WORKER_INTENT_PROMOTIONS_FAILED', detail: e.message });
  }
});

app.put('/api/chat/promotions/:id/apply', requireAuth, requireRole('master'), async (req, res) => {
  try {
    const candidate = await findPromotionCandidate(pgPool, {
      schema: SCHEMA,
      candidateId: Number(req.params.id),
    });
    if (!candidate) {
      return res.status(404).json({ error: '워커 인텐트 후보를 찾을 수 없습니다.', code: 'WORKER_INTENT_CANDIDATE_NOT_FOUND' });
    }

    const learnedPattern = candidate.learned_pattern || candidate.sample_text;
    addLearnedPattern({
      pattern: learnedPattern,
      intent: candidate.suggested_intent,
      filePath: WORKER_INTENT_LEARNINGS_PATH,
    });

    await markUnrecognizedPromoted(pgPool, {
      schema: SCHEMA,
      intent: candidate.suggested_intent,
      text: candidate.sample_text,
    });

    await upsertPromotionCandidate(pgPool, {
      schema: SCHEMA,
      normalizedText: candidate.normalized_text,
      sampleText: candidate.sample_text,
      suggestedIntent: candidate.suggested_intent,
      occurrenceCount: candidate.occurrence_count || 1,
      confidence: Number(candidate.confidence || 0.8),
      autoApplied: true,
      learnedPattern,
    });

    await logPromotionEvent(pgPool, {
      schema: SCHEMA,
      candidateId: candidate.id,
      normalizedText: candidate.normalized_text,
      sampleText: candidate.sample_text,
      suggestedIntent: candidate.suggested_intent,
      eventType: 'promote_manual',
      learnedPattern,
      actor: 'master',
      metadata: { source: 'worker_web' },
    });

    res.json({ ok: true, candidateId: candidate.id, intent: candidate.suggested_intent, learnedPattern });
  } catch (e) {
    res.status(500).json({ error: '워커 인텐트 후보 반영에 실패했습니다.', code: 'WORKER_INTENT_APPLY_FAILED', detail: e.message });
  }
});

app.put('/api/chat/promotions/:id/rollback', requireAuth, requireRole('master'), async (req, res) => {
  try {
    const candidate = await findPromotionCandidate(pgPool, {
      schema: SCHEMA,
      candidateId: Number(req.params.id),
    });
    if (!candidate) {
      return res.status(404).json({ error: '워커 인텐트 후보를 찾을 수 없습니다.', code: 'WORKER_INTENT_CANDIDATE_NOT_FOUND' });
    }

    removeLearnedPatterns({
      learnedPattern: candidate.learned_pattern,
      sampleText: candidate.sample_text,
      filePath: WORKER_INTENT_LEARNINGS_PATH,
    });

    await clearPromotedUnrecognized(pgPool, {
      schema: SCHEMA,
      suggestedIntent: candidate.suggested_intent,
      normalizedText: normalizeIntentText(candidate.sample_text || ''),
    });

    await clearPromotionCandidateState(pgPool, {
      schema: SCHEMA,
      candidateId: candidate.id,
    });

    await logPromotionEvent(pgPool, {
      schema: SCHEMA,
      candidateId: candidate.id,
      normalizedText: candidate.normalized_text,
      sampleText: candidate.sample_text,
      suggestedIntent: candidate.suggested_intent,
      eventType: 'rollback',
      learnedPattern: candidate.learned_pattern,
      actor: 'master',
      metadata: { source: 'worker_web' },
    });

    res.json({ ok: true, candidateId: candidate.id, intent: candidate.suggested_intent });
  } catch (e) {
    res.status(500).json({ error: '워커 인텐트 후보 롤백에 실패했습니다.', code: 'WORKER_INTENT_ROLLBACK_FAILED', detail: e.message });
  }
});

app.post('/api/chat/send',
  requireAuth,
  companyFilter,
  body('message').isString().trim().isLength({ min: 1, max: 1000 }),
  body('session_id').optional().isString().trim().isLength({ min: 8, max: 100 }),
  body('selected_bot').optional().isString().trim().isIn(['worker', 'emily', 'noah', 'ryan', 'chloe', 'oliver', 'sophie', 'marcus']),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const aiPolicy = await resolveRuntimeAiPolicy(req.user);
      const result = await handleChatMessage({
        text: req.body.message,
        sessionId: req.body.session_id || null,
        user: req.user,
        companyId: req.companyId,
        channel: 'web',
        aiPolicy,
        agentContext: {
          selectedBot: req.body.selected_bot || null,
        },
      });
      res.json(result);
    } catch (e) {
      console.error('[worker/chat]', e.message);
      res.status(500).json({ error: '대화 처리 중 오류가 발생했습니다.', code: 'CHAT_SEND_FAILED', detail: e.message });
    }
  }
);

app.post('/api/webhooks/n8n/chat-intake',
  requireWorkerWebhookSecret,
  body('company_id').trim().notEmpty(),
  body('user_id').isInt({ min: 1 }),
  body('message').isString().trim().isLength({ min: 1, max: 1000 }),
  body('session_id').optional().isString().trim().isLength({ min: 8, max: 100 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const user = await pgPool.get(SCHEMA,
        `SELECT id, company_id, username, role, name
         FROM worker.users
         WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL`,
        [req.body.user_id, req.body.company_id]);
      if (!user) {
        return res.status(404).json({ error: '사용자를 찾을 수 없습니다.', code: 'USER_NOT_FOUND' });
      }
      const aiPolicy = await resolveRuntimeAiPolicy(user);
      const result = await handleChatMessage({
        text: req.body.message,
        sessionId: req.body.session_id || null,
        user,
        companyId: req.body.company_id,
        channel: 'n8n',
        aiPolicy,
        agentContext: {
          selectedBot: req.body.selected_bot || null,
        },
      });
      res.json({
        ok: true,
        sessionId: result.sessionId,
        reply: result.reply,
        intent: result.intent,
        ui: result.ui || null,
      });
    } catch (e) {
      console.error('[worker/webhook/n8n]', e.message);
      res.status(500).json({ error: 'n8n 웹훅 처리 중 오류가 발생했습니다.', code: 'N8N_CHAT_INTAKE_FAILED', detail: e.message });
    }
  }
);

app.get('/api/webhooks/n8n/agent-tasks/:id',
  requireWorkerWebhookSecret,
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const task = await pgPool.get(SCHEMA,
        `SELECT t.*, u.name AS user_name, ar.status AS approval_status
         FROM worker.agent_tasks t
         LEFT JOIN worker.users u ON u.id = t.user_id
         LEFT JOIN worker.approval_requests ar ON ar.id = t.approval_id
         WHERE t.id=$1`,
        [req.params.id]);
      if (!task) {
        return res.status(404).json({ error: '업무를 찾을 수 없습니다.', code: 'TASK_NOT_FOUND' });
      }
      res.json({ ok: true, task });
    } catch (e) {
      res.status(500).json({ error: '업무 상태 조회 중 오류가 발생했습니다.', code: 'N8N_TASK_LOAD_FAILED', detail: e.message });
    }
  }
);

// ── AI 질문 API ───────────────────────────────────────────────────────

app.post('/api/ai/ask',
  requireAuth, requireRole('admin', 'master'), companyFilter,
  body('question').isString().trim().isLength({ min: 2, max: 500 }),
  async (req, res) => {
    if (!validate(req, res)) return;
    const { question } = req.body;
    const companyId   = req.companyId;

    // 0단계: 입력 질문 안전성 검증 (SQL 조작 의도 차단)
    if (!isSafeQuestion(question)) {
      return res.status(400).json({ error: 'SQL 조작 명령어가 포함된 질문은 허용되지 않습니다.', code: 'UNSAFE_QUESTION' });
    }

    try {
      // 1단계: SQL 생성 (Groq 우선 → Haiku 폴백)
      const { text: sqlText } = await callLLMWithFallback(
        'meta-llama/llama-4-maverick-17b-128e-instruct',
        '당신은 PostgreSQL 전문가입니다.',
        buildSQLPrompt(question, companyId), 512);
      let sql = extractSQL(sqlText);

      // 2단계: 안전성 검증
      if (!isSelectOnly(sql)) {
        return res.status(400).json({ error: 'SELECT 쿼리만 허용됩니다.', code: 'UNSAFE_QUERY', sql });
      }

      // 2-1단계: 허용 테이블 화이트리스트 검증
      if (!hasOnlyAllowedTables(sql)) {
        return res.status(400).json({ error: '허용되지 않은 테이블 접근입니다.', code: 'UNAUTHORIZED_TABLE' });
      }

      // 2-2단계: company_id 강제 검증 (업체 격리 확인)
      if (!hasCompanyFilter(sql, companyId)) {
        return res.status(400).json({ error: '쿼리에 업체 필터가 누락되었습니다.', code: 'MISSING_COMPANY_FILTER' });
      }

      // 2-3단계: LIMIT 강제 (LLM이 누락 시)
      if (!/LIMIT\s+\d+/i.test(sql)) {
        sql = sql.replace(/;?\s*$/, ' LIMIT 100;');
      }

      // 3단계: SQL 실행
      const rows = await pgPool.query(SCHEMA, sql, []);

      // 4단계: RAG 컨텍스트
      let ragContext = '';
      try {
        const hits = await rag.search('rag_work_docs', question, { limit: 3,
          filter: { company_id: companyId } });
        ragContext = hits.map(h => h.content).join('\n');
      } catch { /* RAG 실패 무시 */ }

      // 5단계: 결과 요약 (Groq 우선 → Haiku 폴백)
      const { text: answer } = await callLLMWithFallback(
        'meta-llama/llama-4-maverick-17b-128e-instruct',
        '당신은 업무 데이터 분석가입니다.',
        buildSummaryPrompt(question, rows, ragContext), 1024);

      const result = { answer, data: rows.slice(0, 50), sql, rowCount: rows.length, ragUsed: ragContext.length > 0 };
      // 감사 로그 기록 (비동기, 실패 무시)
      pgPool.run(SCHEMA,
        `INSERT INTO worker.audit_log (company_id, user_id, action, target, detail, ip_address) VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, req.user.id, 'ai_question', 'ai', JSON.stringify({ question, rowCount: rows.length }), req.ip]
      ).catch(() => {});
      res.json(result);
    } catch (e) {
      console.error('[AI/ask]', e.message);
      res.status(500).json({ error: 'AI 분석 중 오류가 발생했습니다.', code: 'AI_ERROR', detail: e.message });
    }
  }
);

app.post('/api/ai/revenue-forecast',
  requireAuth, requireRole('admin', 'master'), companyFilter,
  async (req, res) => {
    try {
      await syncSkaSalesToWorker(req.companyId);
      const rows = await pgPool.query(SCHEMA,
        `SELECT date::text, SUM(amount) AS daily_total, COUNT(*) AS tx_count
         FROM worker.sales
         WHERE company_id=$1 AND date >= NOW() - INTERVAL '90 days' AND deleted_at IS NULL
         GROUP BY date ORDER BY date`,
        [req.companyId]);

      if (rows.length < 7) {
        return res.json({ forecast: null,
          message: '예측에 필요한 데이터가 부족합니다. 최소 7일 이상의 매출 데이터가 필요합니다.',
          dataPoints: rows.length });
      }

      const dataStr = rows.map(r => `${r.date}: ${Number(r.daily_total).toLocaleString()}원 (${r.tx_count}건)`).join('\n');

      // 매출 예측 (Groq 우선 → Haiku 폴백)
      const { text: forecastText } = await callLLMWithFallback(
        'meta-llama/llama-4-maverick-17b-128e-instruct',
        '당신은 매출 분석 전문가입니다.',
        `아래 일별 매출 데이터를 분석하고 다음 30일 예측을 JSON으로 반환하세요.

## 매출 데이터
${dataStr}

## JSON 형식으로 답변 (다른 텍스트 없이)
{
  "trend": "상승/하락/횡보",
  "analysis": "분석 요약 (2~3문장)",
  "forecast_30d_total": 숫자,
  "forecast_30d_daily_avg": 숫자,
  "weekly_pattern": "요일별 패턴",
  "warnings": "주의사항",
  "confidence": "high/medium/low"
}`, 1024);

      let forecast;
      try {
        forecast = JSON.parse(forecastText.replace(/```json?\n?/gi, '').replace(/```/g, '').trim());
      } catch {
        forecast = { analysis: forecastText, raw: true };
      }

      const forecastResult = { forecast, dataPoints: rows.length,
        period: { from: rows[0]?.date, to: rows[rows.length - 1]?.date } };
      // 감사 로그 기록 (비동기, 실패 무시)
      pgPool.run(SCHEMA,
        `INSERT INTO worker.audit_log (company_id, user_id, action, target, detail, ip_address) VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.companyId, req.user.id, 'ai_forecast', 'ai', JSON.stringify({ dataPoints: rows.length, trend: forecast?.trend }), req.ip]
      ).catch(() => {});
      res.json(forecastResult);
    } catch (e) {
      console.error('[AI/revenue-forecast]', e.message);
      res.status(500).json({ error: 'AI 예측 중 오류가 발생했습니다.', code: 'FORECAST_ERROR' });
    }
  }
);

// ── 헬스체크 ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  port: PORT,
  ts: new Date().toISOString(),
  websocket: {
    enabled: true,
    path: '/ws/chat',
    clients: wsClients.size,
    ready: Boolean(chatWss),
  },
}));

// ── multer 에러 핸들러 ────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '파일 크기는 20MB 이하만 가능합니다.', code: 'FILE_TOO_LARGE' });
    }
    return res.status(400).json({ error: `파일 업로드 오류: ${err.message}`, code: 'UPLOAD_ERROR' });
  }
  if (err?.message?.includes('허용되지 않는')) {
    return res.status(400).json({ error: err.message, code: 'INVALID_FILE_TYPE' });
  }
  next(err);
});

// ── 에러 로그 미들웨어 (에러 핸들러 앞) ──────────────────────────────
app.use(errorLogger);

// ── 에러 핸들러 ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[worker/server] 오류:', err.message);
  res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
});

// ── Claude Code (SSE 스트리밍 + DB 동기화) ───────────────────────────
const NODE_BIN         = '/opt/homebrew/bin/node';
const CLAUDE_CLI       = process.env.CLAUDE_CODE_CLI || '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js';
const { PROJECT_ROOT: CLAUDE_WORKDIR, AI_AGENT_WORKSPACE: CLAUDE_RUNTIME_WORKSPACE } = require('../../../packages/core/lib/env.js');
const CLAUDE_SPAWN_LOG = path.join(CLAUDE_RUNTIME_WORKSPACE || AI_AGENT_WORKSPACE, 'logs', 'claude-code-spawns.jsonl');

function logClaudeSpawn(event) {
  try {
    fs.mkdirSync(path.dirname(CLAUDE_SPAWN_LOG), { recursive: true });
    fs.appendFileSync(CLAUDE_SPAWN_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch {}
}

function spawnClaude(sessionId, message) {
  const args = [CLAUDE_CLI, '-p', message, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', '--strict-mcp-config'];
  if (sessionId) args.push('--resume', sessionId);
  const childEnv = { ...process.env };
  delete childEnv.CLAUDECODE;
  delete childEnv.ANTHROPIC_API_KEY;    // API Key 과금 방지 — Claude Code CLI는 OAuth 구독 사용
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  return spawn(NODE_BIN, args, { cwd: CLAUDE_WORKDIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
}

// DB 헬퍼
async function dbUpsertSession(id, title) {
  await pgPool.run('worker', `
    INSERT INTO claude_code_sessions (id, title, started_at, last_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET last_at = NOW(), title = COALESCE(EXCLUDED.title, claude_code_sessions.title)
  `, [id, title]);
}
async function dbSaveMessage(sessionId, role, content, toolName, toolInput) {
  await pgPool.run('worker', `
    INSERT INTO claude_code_messages (session_id, role, content, tool_name, tool_input)
    VALUES ($1, $2, $3, $4, $5)
  `, [sessionId, role, content || null, toolName || null, toolInput ?? null]);
}

// 세션별 실행 중인 Claude 프로세스 추적 (동시 실행 방지)
const activeClaudeProcs = new Map(); // sessionId -> { proc, pid, startedAt }

// Claude Code 파일 업로드 디렉토리 (CLAUDE_WORKDIR 내부 — Claude Code가 직접 접근 가능)
const CLAUDE_UPLOAD_DIR = path.join(CLAUDE_WORKDIR, 'tmp', 'uploads');
require('fs').mkdirSync(CLAUDE_UPLOAD_DIR, { recursive: true });

const claudeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CLAUDE_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase();
      const safe = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9가-힣._-]/g, '_');
      cb(null, `${Date.now()}-${safe}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// POST /api/claude/upload — 파일 업로드 (Claude Code 작업 디렉토리 내 저장)
app.post('/api/claude/upload', requireAuth, claudeUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일 없음' });
  res.json({ ok: true, path: req.file.path, name: req.file.originalname, size: req.file.size });
});

// POST /api/claude/send — SSE 스트리밍
app.post('/api/claude/send', requireAuth, async (req, res) => {
  const { text, sessionId } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: '메시지가 필요합니다.' });

  // 기존 세션에 실행 중인 프로세스가 있으면 거부 (stale 엔트리는 정리 후 통과)
  if (sessionId && activeClaudeProcs.has(sessionId)) {
    const active = activeClaudeProcs.get(sessionId);
    const isAlive = !active.proc.killed && active.proc.exitCode === null;
    if (!isAlive) {
      // 프로세스가 이미 종료됐는데 Map에 남아있는 stale 엔트리 정리
      activeClaudeProcs.delete(sessionId);
    } else {
      return res.status(409).json({
        error: 'Claude가 아직 작업 중입니다. 완료 후 메시지를 보내주세요.',
        pid: active.pid,
        startedAt: active.startedAt,
      });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sseWrite = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  const title       = text.length > 50 ? text.slice(0, 50) + '…' : text;
  let curSessionId  = sessionId || null;
  let assistantBuf  = ''; // 스트리밍 중 assistant 텍스트 누적
  let userSaved     = false;

  const proc = spawnClaude(curSessionId, text.trim());
  logClaudeSpawn({ type: 'spawn', pid: proc.pid, sessionId: curSessionId, textLen: text.trim().length });
  console.log('[claude/sse] spawned pid:', proc.pid, 'text:', text.slice(0, 30));

  // 신규 세션은 system 이벤트에서 session_id 확정 후 등록 — 기존 세션은 즉시 등록
  if (curSessionId) activeClaudeProcs.set(curSessionId, { proc, pid: proc.pid, startedAt: new Date().toISOString() });

  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const event = JSON.parse(t);

        if (event.type === 'system' && event.session_id) {
          curSessionId = event.session_id;
          // 신규 세션 ID 확정 → Map 등록 (기존 세션은 이미 등록됨)
          if (!activeClaudeProcs.has(curSessionId)) {
            activeClaudeProcs.set(curSessionId, { proc, pid: proc.pid, startedAt: new Date().toISOString() });
          }
          // 세션 DB upsert + 유저 메시지 저장 (session_id 확정 후)
          dbUpsertSession(curSessionId, title).catch(() => {});
          if (!userSaved) {
            userSaved = true;
            dbSaveMessage(curSessionId, 'user', text.trim()).catch(() => {});
          }
        }

        if (event.type === 'assistant') {
          const content = event.message?.content || [];
          for (const part of content) {
            if (part.type === 'text' && part.text) {
              assistantBuf += part.text;
            } else if (part.type === 'tool_use') {
              // tool_use는 즉시 저장
              if (curSessionId) {
                dbSaveMessage(curSessionId, 'tool', null, part.name, part.input).catch(() => {});
              }
            }
          }
        }

        sseWrite({ type: 'event', event, sessionId: curSessionId });
      } catch {}
    }
  });

  proc.stderr.on('data', chunk => {
    console.error('[claude/sse] stderr:', chunk.toString().slice(0, 200));
  });

  // 클라이언트 연결 끊김 (탭 닫기, 페이지 이탈, 스탑 버튼) → 프로세스 종료
  req.on('close', () => {
    if (!proc.killed) {
      console.log('[claude/sse] client disconnected, killing pid:', proc.pid);
      try { proc.kill(); } catch {}
    }
  });

  proc.on('close', async code => {
    console.log('[claude/sse] closed, code:', code, 'sessionId:', curSessionId);
    // 프로세스 추적 Map에서 제거
    if (curSessionId) activeClaudeProcs.delete(curSessionId);

    if (buf.trim()) { try { sseWrite({ type: 'event', event: JSON.parse(buf), sessionId: curSessionId }); } catch {} }

    // assistant 누적 텍스트 DB 저장
    if (curSessionId && assistantBuf) {
      await dbSaveMessage(curSessionId, 'assistant', assistantBuf).catch(() => {});
      await pgPool.run('worker', `UPDATE claude_code_sessions SET last_at = NOW() WHERE id = $1`, [curSessionId]).catch(() => {});
    }

    sseWrite({ type: 'done', code, sessionId: curSessionId });
    if (!res.writableEnded) res.end();
  });
});

// GET /api/claude/sessions — DB에서 조회
app.get('/api/claude/sessions', requireAuth, async (req, res) => {
  try {
    const rows = await pgPool.query('worker', `
      SELECT id, title,
        to_char(started_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "startedAt",
        to_char(last_at    AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "lastAt"
      FROM claude_code_sessions
      ORDER BY last_at DESC
      LIMIT 100
    `);
    res.json({ sessions: rows });
  } catch (e) {
    res.json({ sessions: [] });
  }
});

// GET /api/claude/sessions/:id/messages — 메시지 목록 (디바이스 동기화)
app.get('/api/claude/sessions/:id/messages', requireAuth, async (req, res) => {
  try {
    const rows = await pgPool.query('worker', `
      SELECT id, role, content, tool_name AS "toolName", tool_input AS "toolInput",
        to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
      FROM claude_code_messages
      WHERE session_id = $1
      ORDER BY created_at ASC
    `, [req.params.id]);
    // 프론트엔드 형식으로 변환
    const messages = rows.map(r => {
      const time = r.createdAt ? (() => {
        const d = new Date(r.createdAt.replace(' ', 'T') + '+09:00');
        return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: true });
      })() : null;
      if (r.role === 'tool') return { role: 'tool', name: r.toolName, input: r.toolInput };
      return { role: r.role, text: r.content || '', time };
    });
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ messages: [] });
  }
});

// DELETE /api/claude/sessions/:id
app.delete('/api/claude/sessions/:id', requireAuth, async (req, res) => {
  try {
    // 실행 중인 Claude 프로세스 강제 종료
    const active = activeClaudeProcs.get(req.params.id);
    if (active) {
      try { active.proc.kill(); } catch {}
      activeClaudeProcs.delete(req.params.id);
    }
    await pgPool.run('worker', `DELETE FROM claude_code_sessions WHERE id = $1`, [req.params.id]);
    const rows = await pgPool.query('worker', `
      SELECT id, title,
        to_char(last_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "lastAt"
      FROM claude_code_sessions ORDER BY last_at DESC LIMIT 100
    `);
    res.json({ ok: true, sessions: rows });
  } catch (e) {
    res.json({ ok: true, sessions: [] });
  }
});

// ── Graceful Shutdown — 고아 프로세스 정리 ───────────────────────────
function killAllClaudeProcs(signal) {
  if (activeClaudeProcs.size === 0) return;
  console.log(`[worker/server] ${signal}: 실행 중인 Claude 프로세스 ${activeClaudeProcs.size}개 종료`);
  for (const [sid, { proc, pid }] of activeClaudeProcs) {
    try { proc.kill(); console.log(`[worker/server] killed pid ${pid} (session ${sid})`); } catch {}
  }
  activeClaudeProcs.clear();
}

process.on('SIGTERM', () => { killAllClaudeProcs('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { killAllClaudeProcs('SIGINT');  process.exit(0); });

async function setupTaskEventListener() {
  if (taskEventClient) return taskEventClient;
  const client = await pgPool.getClient(SCHEMA);
  await client.query('LISTEN worker_agent_task_events');
  client.on('notification', (msg) => {
    if (msg.channel !== 'worker_agent_task_events' || !msg.payload) return;
    try {
      broadcastTaskEvent(JSON.parse(msg.payload));
    } catch (error) {
      console.error('[worker/task-events] payload parse 실패:', error.message);
    }
  });
  client.on('error', (error) => {
    console.error('[worker/task-events] listener 오류:', error.message);
  });
  taskEventClient = client;
  return client;
}

function setupChatWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/chat' });
  chatWss = wss;

  wss.on('connection', async (ws, req) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token) {
        sendWs(ws, { type: 'chat.error', code: 'WS_AUTH_REQUIRED', message: '인증 토큰이 필요합니다.' });
        ws.close(4001, 'auth required');
        return;
      }

      const user = await verifyToken(token);
      const dbUser = await pgPool.get(SCHEMA,
        `SELECT id, company_id, username, role, name
         FROM worker.users
         WHERE id = $1 AND deleted_at IS NULL`,
        [user.id]);
      if (!dbUser) {
        sendWs(ws, { type: 'chat.error', code: 'WS_AUTH_FAILED', message: '사용자를 확인할 수 없습니다.' });
        ws.close(4003, 'auth failed');
        return;
      }

      ws.user = dbUser;
      ws.companyId = dbUser.company_id;
      ws.aiPolicy = await resolveRuntimeAiPolicy(dbUser);
      ws.isAlive = true;
      wsClients.add(ws);
      sendWs(ws, {
        type: 'chat.connected',
        user: { id: dbUser.id, role: dbUser.role, name: dbUser.name },
        ai_policy: ws.aiPolicy,
        ts: new Date().toISOString(),
      });

      ws.on('message', async (raw) => {
        let payload;
        try {
          payload = JSON.parse(String(raw));
        } catch {
          sendWs(ws, { type: 'chat.error', code: 'WS_BAD_PAYLOAD', message: 'JSON 형식이 올바르지 않습니다.' });
          return;
        }

        if (payload.type === 'ping') {
          sendWs(ws, { type: 'pong', ts: new Date().toISOString() });
          return;
        }

        if (payload.type !== 'chat.send') {
          sendWs(ws, { type: 'chat.error', code: 'WS_UNSUPPORTED_TYPE', message: '지원하지 않는 메시지 타입입니다.' });
          return;
        }

        const text = String(payload.message || '').trim();
        const sessionId = payload.sessionId ? String(payload.sessionId) : null;
        const selectedBot = payload.selectedBot ? String(payload.selectedBot).trim().toLowerCase() : null;
        if (!text || text.length > 1000) {
          sendWs(ws, { type: 'chat.error', code: 'WS_INVALID_MESSAGE', message: '메시지는 1~1000자여야 합니다.' });
          return;
        }

        sendWs(ws, {
          type: 'chat.status',
          phase: 'thinking',
          message: 'Worker가 업무를 정리하고 있습니다...',
          sessionId,
          ts: new Date().toISOString(),
        });

        try {
          const result = await handleChatMessage({
            text,
            sessionId,
            user: ws.user,
            companyId: ws.companyId,
            channel: 'websocket',
            aiPolicy: ws.aiPolicy || null,
            agentContext: {
              selectedBot,
            },
          });

          sendWs(ws, {
            type: 'chat.result',
            sessionId: result.sessionId,
            reply: result.reply,
            intent: result.intent,
            ui: result.ui || null,
            ai_policy: result.aiPolicy || ws.aiPolicy || null,
            ts: new Date().toISOString(),
          });
        } catch (err) {
          console.error('[worker/ws/chat]', err.message);
          sendWs(ws, {
            type: 'chat.error',
            code: 'WS_CHAT_FAILED',
            message: err.message || '대화 처리 중 오류가 발생했습니다.',
            ts: new Date().toISOString(),
          });
        }
      });

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('close', () => {
        wsClients.delete(ws);
      });
    } catch (err) {
      sendWs(ws, { type: 'chat.error', code: 'WS_CONNECT_FAILED', message: err.message || '연결 초기화 실패' });
      try { ws.close(1011, 'connect failed'); } catch {}
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of wsClients) {
      if (client.readyState !== 1) continue;
      if (client.isAlive === false) {
        try { client.terminate(); } catch {}
        wsClients.delete(client);
        continue;
      }
      client.isAlive = false;
      try { client.ping(); } catch {}
    }
  }, 30000);
  heartbeat.unref();

  wss.on('close', () => {
    clearInterval(heartbeat);
    chatWss = null;
  });

  return wss;
}

// ── 서버 기동 ────────────────────────────────────────────────────────
if (require.main === module) {
  const { initHubSecrets } = require('../lib/secrets.ts');
  // RAG 스키마 초기화 (pgvector 테이블, 비동기 — 실패해도 서버 기동 계속)
  rag.initSchema().catch(e => console.error('[RAG] 스키마 초기화 실패:', e.message));
  ensureChatSchema().catch(e => console.error('[worker/chat] 스키마 초기화 실패:', e.message));
  setupTaskEventListener().catch(e => console.error('[worker/task-events] listener 초기화 실패:', e.message));
  initHubSecrets().catch((e) => console.warn(`[worker/secrets] Hub 초기화 실패: ${e.message}`)).finally(() => {
    const server = http.createServer(app);
    setupChatWebSocket(server);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[worker/server] API 서버 기동 — http://0.0.0.0:${PORT}`);
      console.log(`[worker/server] WebSocket 채널 기동 — ws://0.0.0.0:${PORT}/ws/chat`);
    });
  });
}

module.exports = app;
