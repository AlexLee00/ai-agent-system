'use strict';

const { createTeamCommanderAdapter } = require('./team-adapter-factory');

function createWorkerCommanderAdapter() {
  return createTeamCommanderAdapter('worker', { toBot: 'worker' });
}

module.exports = {
  createWorkerCommanderAdapter,
};
