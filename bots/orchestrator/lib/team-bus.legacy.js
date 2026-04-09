'use strict';
/**
 * lib/team-bus.js — claude team-bus.js 재사용 래퍼
 *
 * bots/claude/lib/team-bus.js를 직접 require하여 재사용.
 * 오케스트레이터는 같은 claude-team.db를 공유한다.
 */

module.exports = require('../../claude/lib/team-bus');
