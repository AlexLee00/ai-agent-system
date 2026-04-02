'use strict';

function synthesizeFindings(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const themes = {};
  const consensus = [];
  const conflicts = [];
  const nextQuestions = [];

  for (const item of items) {
    const theme = String(item.theme || 'general').trim();
    const conclusion = String(item.conclusion || '').trim();
    const stance = String(item.stance || 'neutral').toLowerCase();

    if (!themes[theme]) themes[theme] = [];
    if (conclusion) themes[theme].push({ conclusion, stance });
  }

  for (const [theme, entries] of Object.entries(themes)) {
    const supports = entries.filter((entry) => entry.stance === 'support').length;
    const opposes = entries.filter((entry) => entry.stance === 'oppose').length;

    if (supports > 0 && opposes > 0) {
      conflicts.push({ theme, supports, opposes });
      nextQuestions.push(`resolve conflict in ${theme}`);
    } else {
      consensus.push({ theme, count: entries.length });
    }
  }

  return {
    themes,
    consensus,
    conflicts,
    next_questions: [...new Set(nextQuestions)],
  };
}

module.exports = {
  synthesizeFindings,
};

