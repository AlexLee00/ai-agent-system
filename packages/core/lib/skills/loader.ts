// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const BOT_CONFIGS = [
  { id: 'academic',     path: 'bots/academic/config.json' },
  { id: 'investment',   path: 'bots/investment/config.yaml' },
  { id: 'claude',       path: 'bots/claude/config.json' },
  { id: 'legal',        path: 'bots/legal/config.json' },
  { id: 'reservation',  path: 'bots/reservation/config.yaml' },
  { id: 'blog',         path: 'bots/blog/config.json' },
  { id: 'orchestrator', path: 'bots/orchestrator/config.json' },
];

// YAML에서 skills 배열 추출 (최상위 skills: 만 파싱, 외부 라이브러리 불필요)
function parseYamlSkills(content) {
  const lines = content.split('\n');
  const skills = [];
  let inSkills = false;

  for (const line of lines) {
    // 최상위 skills: 시작
    if (/^skills:\s*$/.test(line)) {
      inSkills = true;
      continue;
    }
    // skills 블록 안에서 - 항목 수집
    if (inSkills) {
      const match = line.match(/^\s+-\s+([a-z0-9-/]+)/);
      if (match) {
        skills.push(match[1]);
      } else if (/^\S/.test(line)) {
        // 다른 최상위 키 → skills 블록 종료
        break;
      }
    }
  }

  return skills;
}

// config 파일에서 skills 배열 읽기
function readSkillsFromConfig(configPath) {
  const absPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(ROOT, configPath);

  try {
    const content = fs.readFileSync(absPath, 'utf8');

    if (absPath.endsWith('.json')) {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed.skills) ? parsed.skills : [];
    }

    if (absPath.endsWith('.yaml') || absPath.endsWith('.yml')) {
      return parseYamlSkills(content);
    }

    return [];
  } catch (err) {
    console.warn(`[skills/loader] config 읽기 실패: ${configPath} — ${err.message}`);
    return [];
  }
}

// 봇 config에서 스킬 로딩
function loadSkills(configPath) {
  const skillNames = readSkillsFromConfig(configPath);
  const loaded = {};
  const failed = [];

  for (const name of skillNames) {
    try {
      loaded[name] = require(`./${name}`);
    } catch (err) {
      failed.push({ name, error: err.message });
      console.warn(`[skills/loader] 스킬 로딩 실패: ${name} — ${err.message}`);
    }
  }

  const loadedCount = Object.keys(loaded).length;
  console.log(`[skills] ${loadedCount}개 로딩, ${failed.length}개 실패`);

  return { loaded, failed };
}

// 특정 스킬을 사용하는 봇 목록
function getSkillUsers(skillName) {
  const users = [];

  for (const bot of BOT_CONFIGS) {
    const skills = readSkillsFromConfig(bot.path);
    if (skills.includes(skillName)) {
      users.push(bot.id);
    }
  }

  return users;
}

// 전체 봇-스킬 매핑
function getAllMappings() {
  const mappings = {};

  for (const bot of BOT_CONFIGS) {
    mappings[bot.id] = readSkillsFromConfig(bot.path);
  }

  return mappings;
}

module.exports = { loadSkills, getSkillUsers, getAllMappings, BOT_CONFIGS };
