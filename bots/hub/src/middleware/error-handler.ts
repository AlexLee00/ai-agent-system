function resolveErrorStatus(error) {
  const status = Number(error?.status || error?.statusCode);
  if (Number.isFinite(status) && status >= 400 && status <= 599) return Math.floor(status);
  if (error?.type === 'entity.too.large') return 413;
  if (error instanceof SyntaxError && 'body' in error) return 400;
  return 500;
}

function publicErrorCode(status, error) {
  if (status === 400 && error instanceof SyntaxError && 'body' in error) return 'invalid_json_body';
  if (status === 413) return 'request_entity_too_large';
  if (status === 414) return 'uri_too_long';
  if (status >= 500) return 'internal_server_error';
  return String(error?.code || error?.type || 'request_failed');
}

function hubErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = resolveErrorStatus(error);
  const traceId = req.hubRequestContext?.traceId || '-';
  const code = publicErrorCode(status, error);
  console.error(`[hub] request_error code=${code} status=${status} trace=${traceId}:`, error?.message || error);
  return res.status(status).json({
    ok: false,
    error: code,
    traceId,
  });
}

module.exports = {
  hubErrorHandler,
  publicErrorCode,
  resolveErrorStatus,
};
