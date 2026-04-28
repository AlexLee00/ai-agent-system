'use strict';

const { createTeamCommanderAdapter } = require('./team-adapter-factory');

function createLegalCommanderAdapter() {
  return createTeamCommanderAdapter('legal', { toBot: 'legal' });
}

module.exports = {
  createLegalCommanderAdapter,
};
