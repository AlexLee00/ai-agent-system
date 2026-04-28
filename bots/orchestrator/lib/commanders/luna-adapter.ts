'use strict';

const { createTeamCommanderAdapter } = require('./team-adapter-factory');

function createLunaCommanderAdapter() {
  return createTeamCommanderAdapter('luna', { toBot: 'luna' });
}

module.exports = {
  createLunaCommanderAdapter,
};
