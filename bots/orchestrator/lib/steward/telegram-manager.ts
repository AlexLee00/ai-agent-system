// @ts-nocheck
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const CLASS_TOPIC_KEYS = ['ops_work', 'ops_reports', 'ops_error_resolution', 'ops_emergency'];
const LEGACY_TEAM_TOPICS = ['general', 'ska', 'luna', 'claude_lead', 'blog', 'darwin', 'justin', 'sigma', 'meeting', 'emergency'];
const EXPECTED_TOPICS = process.env.HUB_ALARM_USE_CLASS_TOPICS === 'false'
  ? LEGACY_TEAM_TOPICS
  : CLASS_TOPIC_KEYS;

function getConfig() {
  if (!fs.existsSync(STORE_PATH)) return { token: '', groupId: '', topicIds: {} };
  const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  return {
    token: store.telegram?.bot_token || '',
    groupId: store.telegram?.group_id || '',
    topicIds: store.telegram?.topic_ids || {},
  };
}

function listTopics() {
  const config = getConfig();
  return EXPECTED_TOPICS.map((team) => ({
    team,
    topicId: config.topicIds[team] ?? null,
    configured: team === 'general'
      ? Object.prototype.hasOwnProperty.call(config.topicIds, team)
      : config.topicIds[team] !== undefined && config.topicIds[team] !== null,
  }));
}

function findMissingTopics() {
  return listTopics().filter((item) => !item.configured);
}

async function createTopic(name, iconColor = 7322096) {
  if (process.env.ALLOW_LEGACY_TEAM_TOPICS !== '1') {
    const legacyNames = ['일반', '스카', '루나', '클로드', '팀장', '회의록', 'blog', 'darwin', 'justin', 'sigma'];
    if (legacyNames.some((token) => String(name || '').toLowerCase().includes(token.toLowerCase()))) {
      throw new Error('legacy_team_topic_creation_blocked');
    }
  }
  const config = getConfig();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: config.groupId, name, icon_color: iconColor });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${config.token}/createForumTopic`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  listTopics,
  findMissingTopics,
  createTopic,
  EXPECTED_TOPICS,
};
