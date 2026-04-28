'use strict';

const { createTeamCommanderAdapter } = require('./team-adapter-factory');

function createClaudeCommanderAdapter() {
  return createTeamCommanderAdapter('claude', { toBot: 'claude' });
}

module.exports = {
  createClaudeCommanderAdapter,
};
