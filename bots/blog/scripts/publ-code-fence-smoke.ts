#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { _testOnly } = require('../lib/publ.ts');

const html = _testOnly._contentToHtml([
  '[실무 - 코드]',
  '아래 내용을 그대로 복사합니다.',
  '',
  '[실무 - 코드 및 아키텍처] 긴 작업을 에이전트에게 맡기는 3가지 실전 패턴',
  '',
  '```',
  '',
  '```text',
  '프롬프트 1 — 작업 분해 요청용',
  '다음 작업을 3단계로 나눠주세요.',
  '```',
  '',
  '```js',
  'const fs = require("fs");',
  'fs.writeFileSync("output/progress.txt", `${done}/${total}`, "utf8");',
  '```',
].join('\n'), '[에이전트 입문 20강] 긴 작업 맡기기');

assert(html.includes('<pre><code class="language-text">프롬프트 1'));
assert(html.includes('긴 작업을 에이전트에게 맡기는 3가지 실전 패턴'));
assert(!html.includes('및 아키텍처] 긴 작업'));
assert(html.includes('<pre><code class="language-js">const fs'));
assert(!html.includes('</code></pre>text'));
assert(!html.includes('</code></pre>js'));
assert(!html.includes('<p>```</p>'));
assert(!html.includes('<p>const fs = require'));
assert(html.includes('${done}/${total}'));

console.log('publ-code-fence-smoke ok');
