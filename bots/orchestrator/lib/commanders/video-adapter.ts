'use strict';

const { createTeamCommanderAdapter } = require('./team-adapter-factory');

function createVideoCommanderAdapter() {
  return createTeamCommanderAdapter('video', { toBot: 'video' });
}

module.exports = {
  createVideoCommanderAdapter,
};
