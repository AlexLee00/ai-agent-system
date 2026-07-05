'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function lineCount(filePath: string) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).length;
}

function main() {
  const skillDir = path.join(__dirname, '../skills/darwin-research');
  const skill = path.join(skillDir, 'SKILL.md');
  assert.ok(fs.existsSync(skill));
  assert.ok(lineCount(skill) <= 41);
  for (const name of ['cycle-overview', 'predicate-authoring', 'adopt-review', 'gotchas']) {
    const filePath = path.join(skillDir, 'commands', `${name}.md`);
    assert.ok(fs.existsSync(filePath), `${name} command missing`);
    assert.ok(lineCount(filePath) <= 120, `${name} command too long`);
  }
  assert.match(fs.readFileSync(path.join(skillDir, 'commands/gotchas.md'), 'utf8'), /FROZEN|frozen/i);
  console.log('✅ darwin skill pack smoke ok');
}

main();
