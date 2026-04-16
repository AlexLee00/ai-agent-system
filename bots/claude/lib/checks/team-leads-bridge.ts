// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

function resolveTeamLeadsModule() {
  const repoRoot =
    process.env.REPO_ROOT ||
    process.env.PROJECT_ROOT ||
    process.cwd();

  const candidates = [
    path.join(__dirname, './team-leads.legacy.js'),
    path.join(repoRoot, 'bots/claude/lib/checks/team-leads.legacy.js'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error('[claude] team-leads bridge target not found');
}

module.exports = require(resolveTeamLeadsModule());
