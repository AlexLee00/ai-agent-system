'use strict';

const { createTeamCommanderAdapter } = require('./team-adapter-factory');

function createSkaCommanderAdapter() {
  return createTeamCommanderAdapter('ska', { toBot: 'ska' });
}

module.exports = {
  createSkaCommanderAdapter,
};
