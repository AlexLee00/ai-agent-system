// @ts-nocheck
'use strict';

const BLOG_ENGAGEMENT_POLICY = Object.freeze({
  neighborCommentsPerDay: 30,
  commentSympathiesPerDay: 30,
  standaloneSympathiesPerDay: 30,
  totalSympathiesPerDay: 60,
  maxActionsPerCycle: 1,
});

const COMMENT_SYMPATHY_ACTION_TYPES = Object.freeze([
  'neighbor_comment_sympathy',
]);

const STANDALONE_SYMPATHY_ACTION_TYPES = Object.freeze([
  'neighbor_sympathy',
]);

const SYMPATHY_ACTION_TYPES = Object.freeze([
  ...COMMENT_SYMPATHY_ACTION_TYPES,
  ...STANDALONE_SYMPATHY_ACTION_TYPES,
]);

function buildEvenDailySchedule({ count, startHour, startMinute, intervalMinutes }) {
  const safeCount = Math.max(0, Math.floor(Number(count || 0)));
  const start = (Number(startHour || 0) * 60) + Number(startMinute || 0);
  const interval = Math.max(1, Math.floor(Number(intervalMinutes || 1)));
  return Array.from({ length: safeCount }, (_, index) => {
    const minuteOfDay = start + (index * interval);
    if (minuteOfDay >= 24 * 60) throw new Error('engagement_schedule_exceeds_day');
    return {
      Hour: Math.floor(minuteOfDay / 60),
      Minute: minuteOfDay % 60,
    };
  });
}

function clampActionsPerCycle(requested, remaining) {
  return Math.max(0, Math.min(
    BLOG_ENGAGEMENT_POLICY.maxActionsPerCycle,
    Math.floor(Number(requested || 0)),
    Math.floor(Number(remaining || 0)),
  ));
}

module.exports = {
  BLOG_ENGAGEMENT_POLICY,
  COMMENT_SYMPATHY_ACTION_TYPES,
  STANDALONE_SYMPATHY_ACTION_TYPES,
  SYMPATHY_ACTION_TYPES,
  buildEvenDailySchedule,
  clampActionsPerCycle,
};
