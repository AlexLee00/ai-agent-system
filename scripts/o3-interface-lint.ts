#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SKILL_ROOTS = ['skills', '.claude/skills', 'bots'];

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && ['node_modules', 'venv', '.venv', 'dist', 'build'].includes(entry.name)) continue;
    if (entry.isDirectory()) {
      walk(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end < 0) return {};
  const block = content.slice(4, end).trim();
  const data = {};
  let listKey = null;
  for (const line of block.split(/\r?\n/)) {
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && listKey) {
      data[listKey] = data[listKey] || [];
      data[listKey].push(listMatch[1].trim());
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].trim();
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else {
      data[key] = value.replace(/^['"]|['"]$/g, '');
      listKey = null;
    }
  }
  return data;
}

function skillFiles() {
  const roots = SKILL_ROOTS.map((root) => path.join(repoRoot, root));
  const files = roots.flatMap((root) => walk(root, (file) => file.endsWith('/SKILL.md') || file.endsWith('.skill.md')));
  return files
    .filter((file) => !file.includes(`${path.sep}skills${path.sep}archive${path.sep}`))
    .sort();
}

function lintSkill(file) {
  const relative = path.relative(repoRoot, file);
  const content = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(content);
  const missing = [];
  if (!fm.name) missing.push('name');
  if (!fm.description) missing.push('description');
  if (!Array.isArray(fm.triggers) || fm.triggers.length === 0) missing.push('triggers');
  return {
    file: relative,
    ok: missing.length === 0,
    missing,
    owner: fm.owner || null,
    permissions: fm.permissions || [],
    llm_routing: fm.llm_routing || null,
  };
}

function lintA2aCards() {
  const files = walk(path.join(repoRoot, 'bots'), (file) => file.endsWith('-card.json') || file.endsWith('/card.json')).sort();
  return files.map((file) => {
    const relative = path.relative(repoRoot, file);
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const missing = ['name', 'description'].filter((key) => !json[key]);
      return { file: relative, ok: missing.length === 0, missing };
    } catch (error) {
      return { file: relative, ok: false, missing: ['valid_json'], error: String(error?.message || error) };
    }
  });
}

function lintMcpDescriptions() {
  const files = walk(path.join(repoRoot, 'bots'), (file) => /mcp/.test(file) && /\.(ts|js|py)$/.test(file)).sort();
  return files.slice(0, 200).map((file) => {
    const relative = path.relative(repoRoot, file);
    const content = fs.readFileSync(file, 'utf8');
    const hasDescription = /description\s*[:=]/i.test(content) || /tool/i.test(content);
    return { file: relative, ok: hasDescription, missing: hasDescription ? [] : ['tool_description_hint'] };
  });
}

export function buildO3InterfaceLintReport() {
  const skills = skillFiles().map(lintSkill);
  const a2aCards = lintA2aCards();
  const mcpTools = lintMcpDescriptions();
  const skillFailures = skills.filter((item) => !item.ok);
  return {
    ok: true,
    pass: skillFailures.length === 0,
    source: 'o3_interface_lint',
    checkedAt: new Date().toISOString(),
    advisoryOnly: true,
    liveMutation: false,
    counts: {
      skills: skills.length,
      skillFailures: skillFailures.length,
      a2aCards: a2aCards.length,
      a2aReportOnlyFailures: a2aCards.filter((item) => !item.ok).length,
      mcpFiles: mcpTools.length,
      mcpReportOnlyFailures: mcpTools.filter((item) => !item.ok).length,
    },
    skills,
    a2aCards,
    mcpTools,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const smoke = argv.includes('--smoke');
  const json = argv.includes('--json') || smoke;
  const report = buildO3InterfaceLintReport();
  if (smoke) {
    const platformGlossary = report.skills.find((item) => item.file === 'skills/platform-glossary.skill.md');
    const hubRunbook = report.skills.find((item) => item.file === 'skills/hub-runbook-summary.skill.md');
    assert.equal(platformGlossary?.ok, true);
    assert.equal(hubRunbook?.ok, true);
    assert.equal(report.skills.some((item) => item.file.includes('skills/archive/n8n-workflow-ops')), false);
    assert.equal(report.liveMutation, false);
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`[o3-interface-lint] skills=${report.counts.skills} failures=${report.counts.skillFailures}`);
  if (strict && !report.pass) process.exit(1);
}

main();
