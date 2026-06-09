const { captureHubError } = require('../../lib/sentry-mcp-adapter');
const { recordHubRuntimeErrorPatternAsync } = require('../../lib/autonomy/runtime-error-learning');

type HubError = Error & {
  status?: number | string;
  statusCode?: number | string;
  type?: string;
  code?: string;
  body?: unknown;
};

type HubErrorRequest = {
  hubRequestContext?: { traceId?: string };
  hubBodyRouteClass?: string;
  headers?: Record<string, unknown>;
  originalUrl?: string;
  path?: string;
  method?: string;
};

type HubErrorResponse = {
  headersSent?: boolean;
  status: (status: number) => { json: (payload: unknown) => unknown };
};

type Next = (error?: unknown) => unknown;

function resolveErrorStatus(error: HubError) {
  const status = Number(error?.status || error?.statusCode);
  if (Number.isFinite(status) && status >= 400 && status <= 599) return Math.floor(status);
  if (error?.type === 'entity.too.large') return 413;
  if (error instanceof SyntaxError && 'body' in error) return 400;
  return 500;
}

function publicErrorCode(status: number, error: HubError) {
  if (status === 400 && error instanceof SyntaxError && 'body' in error) return 'invalid_json_body';
  if (status === 413) return 'request_entity_too_large';
  if (status === 414) return 'uri_too_long';
  if (status >= 500) return 'internal_server_error';
  return String(error?.code || error?.type || 'request_failed');
}

function bodyLimitSuggestion(req: HubErrorRequest, status: number) {
  if (status !== 413) return null;
  const routeClass = String(req.hubBodyRouteClass || 'default');
  const currentMb = routeClass === 'llm'
    ? Number(process.env.HUB_LLM_JSON_LIMIT_MB || 8)
    : routeClass === 'events'
      ? Number(process.env.HUB_EVENTS_JSON_LIMIT_MB || 4)
      : routeClass === 'memory'
        ? Number(process.env.HUB_MEMORY_JSON_LIMIT_MB || 8)
        : Number(process.env.HUB_JSON_LIMIT_MB || 1);
  const contentLength = Number(req.headers?.['content-length'] || 0);
  const observedMb = Number.isFinite(contentLength) && contentLength > 0
    ? Math.ceil(contentLength / 1024 / 1024)
    : 0;
  const suggestedMb = Math.max(currentMb + 1, observedMb > 0 ? Math.min(observedMb * 2, 32) : currentMb * 2);
  return {
    routeClass,
    currentMb,
    suggestedMb,
    contentLength,
  };
}

function hubErrorHandler(error: HubError, req: HubErrorRequest, res: HubErrorResponse, next: Next) {
  if (res.headersSent) return next(error);
  const status = resolveErrorStatus(error);
  const traceId = req.hubRequestContext?.traceId || '-';
  const code = publicErrorCode(status, error);
  const path = String(req.originalUrl || req.path || '-');
  const method = String(req.method || '-');
  const contentLength = String(req.headers?.['content-length'] || '');
  console.error(
    `[hub] request_error code=${code} status=${status} method=${method} path=${path} content_length=${contentLength || '-'} trace=${traceId}:`,
    error?.message || error,
  );
  captureHubError(error, req);
  const suggestion = status === 413 ? bodyLimitSuggestion(req, status) : null;
  if (status === 413) {
    recordHubRuntimeErrorPatternAsync({
      errorType: code,
      route: path,
      routeClass: suggestion?.routeClass || 'default',
      method,
      status,
      currentValue: suggestion ? `${suggestion.currentMb}mb` : null,
      suggestedValue: suggestion ? `${suggestion.suggestedMb}mb` : null,
      rationale: 'Observed payload exceeded current route body limit; learn route-specific limit instead of raising every route globally.',
      traceId,
      evidence: {
        content_length: suggestion?.contentLength || contentLength || null,
        body_route_class: suggestion?.routeClass || req.hubBodyRouteClass || 'default',
        parser_error_type: error?.type || null,
      },
    });
  }
  return res.status(status).json({
    ok: false,
    error: code,
    traceId,
    ...(suggestion ? { bodyLimit: suggestion } : {}),
  });
}

module.exports = {
  hubErrorHandler,
  publicErrorCode,
  resolveErrorStatus,
};
