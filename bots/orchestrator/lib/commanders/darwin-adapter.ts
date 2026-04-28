'use strict';

const { createTeamCommanderAdapter } = require('./team-adapter-factory');

function createDarwinCommanderAdapter() {
  return createTeamCommanderAdapter('darwin', { toBot: 'darwin' });
}

module.exports = {
  createDarwinCommanderAdapter,
};
