'use strict';

const reviewWorkflow = require('./review-workflow');
const qaWorkflow = require('./qa-workflow');
const shipWorkflow = require('./ship-workflow');
const retroWorkflow = require('./retro-workflow');

module.exports = {
  reviewWorkflow,
  qaWorkflow,
  shipWorkflow,
  retroWorkflow,
};
