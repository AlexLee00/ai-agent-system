'use strict';

const registry = require('./free-registry');
const loader = require('./loader');
const teamRouter = require('./team-router');

module.exports = {
  ...registry,
  ...loader,
  ...teamRouter,
};

