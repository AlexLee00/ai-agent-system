'use strict';

const { createTeamCommanderAdapter } = require('./team-adapter-factory');

function createBlogCommanderAdapter() {
  return createTeamCommanderAdapter('blog', { toBot: 'blog' });
}

module.exports = {
  createBlogCommanderAdapter,
};
