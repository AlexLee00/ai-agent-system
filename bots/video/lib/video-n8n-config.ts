// @ts-nocheck
'use strict';

const { getSecret } = require('../../worker/lib/secrets');

function resolveVideoN8nToken(config = null) {
  const raw = String(config?.n8n?.token || '').trim();
  if (raw && raw !== '${VIDEO_N8N_TOKEN}') {
    return raw;
  }

  return String(
    process.env.VIDEO_N8N_TOKEN
      || getSecret('video_n8n_token')
      || ''
  ).trim();
}

module.exports = {
  resolveVideoN8nToken,
};
