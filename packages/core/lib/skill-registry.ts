// @ts-nocheck

function normalizeSkill(skill = {}) {
  if (!skill.name) throw new Error('skill.name required');
  return {
    name: String(skill.name),
    owner: String(skill.owner || 'luna'),
    category: String(skill.category || 'general'),
    version: String(skill.version || '1.0.0'),
    enabled: skill.enabled !== false,
    description: String(skill.description || ''),
    handler: skill.handler || null,
    metadata: skill.metadata || {},
  };
}

export function createSkillRegistry(initialSkills = []) {
  const skills = new Map();
  for (const skill of initialSkills) {
    const normalized = normalizeSkill(skill);
    skills.set(normalized.name, normalized);
  }
  return {
    register(skill) {
      const normalized = normalizeSkill(skill);
      skills.set(normalized.name, normalized);
      return normalized;
    },
    get(name) {
      return skills.get(String(name)) || null;
    },
    list({ owner = null, category = null, enabled = null } = {}) {
      return Array.from(skills.values()).filter((skill) => {
        if (owner && skill.owner !== owner) return false;
        if (category && skill.category !== category) return false;
        if (enabled != null && skill.enabled !== enabled) return false;
        return true;
      });
    },
    async execute(name, input = {}, context = {}) {
      const skill = skills.get(String(name));
      if (!skill) return { ok: false, code: 'skill_not_found', name };
      if (!skill.enabled) return { ok: false, code: 'skill_disabled', name };
      if (typeof skill.handler !== 'function') return { ok: true, code: 'skill_noop', name, input, context };
      return skill.handler(input, context);
    },
  };
}

export default { createSkillRegistry };
