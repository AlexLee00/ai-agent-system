'use strict';

const { createAgentMemory } = require('./agent-memory');

function createHealthMemoryHelper(opts = {}) {
  const agentId = String(opts.agentId || '').trim();
  const team = String(opts.team || '').trim();
  const domain = String(opts.domain || '').trim();
  if (!agentId) throw new Error('createHealthMemoryHelper: agentId is required');
  if (!team) throw new Error('createHealthMemoryHelper: team is required');
  if (!domain) throw new Error('createHealthMemoryHelper: domain is required');

  const healthMemory = createAgentMemory({ agentId, team });

  function buildMemoryQuery(key, msg) {
    const lines = String(msg || '')
      .split('\n')
      .map((line) => String(line || '').trim())
      .filter(Boolean);
    const headline = lines[0] || '';
    const detail = lines[1] || '';
    return [String(key || ''), headline, detail, domain].filter(Boolean).join(' ');
  }

  async function rememberHealthEvent(key, kind, msg, level = 1) {
    try {
      await healthMemory.remember(String(msg || ''), 'episodic', {
        importance: kind === 'issue' ? 0.76 : 0.62,
        expiresIn: 1000 * 60 * 60 * 24 * 30,
        metadata: {
          kind,
          issueKey: key,
          level,
        },
      });
      await healthMemory.consolidate({
        olderThanDays: 14,
        limit: 10,
      });
    } catch (_error) {
      // ignore
    }
  }

  async function buildIssueHints(key, msg) {
    const query = buildMemoryQuery(key, msg);
    const episodicHint = await healthMemory.recallCountHint(query, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 이슈',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        issue: '이슈',
        recovery: '회복',
      },
      order: ['issue', 'recovery'],
    }).catch(() => '');
    const semanticHint = await healthMemory.recallHint(`${query} consolidated health pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    return `${episodicHint}${semanticHint}`;
  }

  return {
    buildIssueHints,
    rememberHealthEvent,
  };
}

module.exports = {
  createHealthMemoryHelper,
};
