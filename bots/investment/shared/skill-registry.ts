// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const INVESTMENT_ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_SKILL_ROOT = path.join(INVESTMENT_ROOT, 'skills');

function createLocalSkillRegistry(initialSkills = []) {
  const skills = new Map();
  for (const skill of initialSkills) skills.set(skill.name, skill);
  return {
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
      if (skill.enabled === false) return { ok: false, code: 'skill_disabled', name };
      return { ok: true, code: 'skill_noop', name, input, context };
    },
  };
}

function parseSkillFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(DEFAULT_SKILL_ROOT, filePath);
  const [owner, fileName] = rel.split(path.sep);
  const name = fileName.replace(/\.skill\.md$/i, '');
  const title = (text.match(/^#\s+(.+)$/m) || [null, name])[1];
  const category = (text.match(/^- Category:\s*(.+)$/m) || [null, 'general'])[1].trim();
  const description = (text.match(/^- Contract:\s*(.+)$/m) || [null, title])[1].trim();
  return {
    name,
    owner,
    category,
    description,
    metadata: { path: filePath, title },
  };
}

export function listSkillFiles(root = DEFAULT_SKILL_ROOT) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const owner of fs.readdirSync(root).sort()) {
    const dir = path.join(root, owner);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (file.endsWith('.skill.md')) out.push(path.join(dir, file));
    }
  }
  return out;
}

export function loadInvestmentSkills(root = DEFAULT_SKILL_ROOT) {
  return listSkillFiles(root).map(parseSkillFile);
}

export function createInvestmentSkillRegistry({ root = DEFAULT_SKILL_ROOT } = {}) {
  return createLocalSkillRegistry(loadInvestmentSkills(root));
}

export async function executeInvestmentSkill(agent, skillName, input = {}, context = {}) {
  const registry = createInvestmentSkillRegistry();
  const skill = registry.list({ owner: agent }).find((item) => item.name === skillName);
  if (!skill) return { ok: false, code: 'skill_not_found', agent, skillName };
  return registry.execute(skill.name, input, { ...context, agent });
}

export default {
  listSkillFiles,
  loadInvestmentSkills,
  createInvestmentSkillRegistry,
  executeInvestmentSkill,
};
